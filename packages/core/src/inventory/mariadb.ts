import type { EngineClient } from '../engine';
import { eolFor } from './eol';
import {
  date,
  emptySnapshot,
  num,
  text,
  type DiskObject,
  type InventoryNote,
  type InventorySnapshot,
  type JobRow,
  type ReplicationRow,
  type SettingRow,
} from './types';

const AUDITED = [
  'innodb_buffer_pool_size',
  'innodb_flush_log_at_trx_commit',
  'innodb_flush_method',
  'innodb_file_per_table',
  'innodb_log_file_size',
  'innodb_io_capacity',
  'max_connections',
  'wait_timeout',
  'interactive_timeout',
  'log_bin',
  'binlog_format',
  'sync_binlog',
  'expire_logs_days',
  'binlog_expire_logs_seconds',
  'slow_query_log',
  'long_query_time',
  'character_set_server',
  'collation_server',
  'sql_mode',
  'read_only',
  'event_scheduler',
  'max_allowed_packet',
  'tmp_table_size',
  'table_open_cache',
  'thread_pool_size',
  'require_secure_transport',
];

/** Los identificadores de MariaDB no llevan comillas simples en el IN. */
function quoted(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(',');
}

export async function collectMariadb(client: EngineClient): Promise<InventorySnapshot> {
  const [version] = await client.query(
    'select version() as version, @@version_comment as comment, @@hostname as hostname,' +
      ' @@character_set_server as charset, @@server_id as server_id',
  );

  const versionText = String(version?.['version'] ?? '');
  // "11.4.12-MariaDB-ubu2404-log" → 11.4.12 → 110412
  const parts = versionText.split('-')[0]?.split('.').map((value) => Number(value)) ?? [];
  const versionNum =
    parts.length >= 3 ? (parts[0] ?? 0) * 10_000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0) : null;

  const [status] = await client.query(
    "select variable_value as uptime from information_schema.global_status where variable_name = 'UPTIME'",
  );
  const uptimeSeconds = num(status?.['uptime']);

  const snapshot = emptySnapshot({
    engine: 'mariadb',
    versionNum,
    versionText: `${versionText}${version?.['comment'] ? ` (${version['comment']})` : ''}`,
    collation: text(version?.['charset']),
    startedAt: uptimeSeconds === null ? null : new Date(Date.now() - uptimeSeconds * 1000),
    eolDate: eolFor('mariadb', versionText),
  });

  // ----------------------------------------------------------- configuración
  // information_schema.system_variables trae el valor global y el default en la
  // misma fila, así que se sabe si alguien lo tocó — el equivalente del
  // `source = 'default'` de PostgreSQL.
  const settings = await client.query(
    `select variable_name, global_value, default_value, variable_comment, variable_scope
       from information_schema.system_variables
      where lower(variable_name) in (${quoted(AUDITED)})
      order by variable_name`,
  );
  snapshot.settings = settings.map(
    (row): SettingRow => ({
      name: String(row['variable_name']).toLowerCase(),
      value: String(row['global_value'] ?? ''),
      category: text(row['variable_scope']),
      isDefault: String(row['global_value'] ?? '') === String(row['default_value'] ?? ''),
      // En MariaDB el scope GLOBAL sin SESSION suele requerir reinicio para
      // variables como innodb_log_file_size; se marca por scope.
      requiresRestart: String(row['variable_scope'] ?? '').toUpperCase() === 'GLOBAL',
    }),
  );

  // ------------------------------------------------------------------ disco
  const schemas = await client.query(
    `select table_schema as name,
            sum(coalesce(data_length, 0)) as data_bytes,
            sum(coalesce(index_length, 0)) as index_bytes,
            sum(coalesce(data_free, 0)) as free_bytes,
            count(*) as tables
       from information_schema.tables
      where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
      group by table_schema
      order by 2 desc`,
  );
  snapshot.disks = schemas.map((row): DiskObject => {
    const data = num(row['data_bytes']) ?? 0;
    const index = num(row['index_bytes']) ?? 0;
    return {
      kind: 'database',
      name: String(row['name']),
      sizeBytes: data + index,
      // data_free es espacio reclamable dentro de los archivos, no espacio en
      // disco: es lo que devolvería un OPTIMIZE TABLE.
      freeBytes: num(row['free_bytes']),
      detail: { data_bytes: data, index_bytes: index, tables: num(row['tables']) },
    };
  });

  const notes: InventoryNote[] = [
    {
      domain: 'disk',
      level: 'info',
      message:
        'Los tamaños vienen de information_schema y son de datos e índices dentro de los archivos, no del espacio ocupado en disco. El espacio libre del volumen se ve en Host cuando la instancia tiene métricas de sistema configuradas.',
    },
  ];

  // ------------------------------------------------------------ replicación
  const replication: ReplicationRow[] = [];
  const replica = await client.query('show replica status');
  for (const row of replica) {
    replication.push({
      role: 'replica',
      peer: `${row['Source_Host'] ?? row['Master_Host'] ?? 'desconocido'}:${
        row['Source_Port'] ?? row['Master_Port'] ?? ''
      }`,
      state: String(row['Slave_IO_Running'] ?? row['Replica_IO_Running'] ?? 'desconocido'),
      lagSeconds: num(row['Seconds_Behind_Master'] ?? row['Seconds_Behind_Source']),
      detail: {
        sql_running: text(row['Slave_SQL_Running'] ?? row['Replica_SQL_Running']),
        last_error: text(row['Last_Error']),
        gtid: text(row['Gtid_IO_Pos']),
      },
    });
  }

  // Réplicas conectadas contra este servidor.
  const hosts = await client.query('show replica hosts');
  for (const row of hosts) {
    replication.push({
      role: 'standby',
      peer: `${row['Host'] ?? 'desconocido'}:${row['Port'] ?? ''}`,
      state: 'conectada',
      detail: { server_id: text(row['Server_id']) },
    });
  }

  const [binlog] = await client.query(
    'select @@log_bin as log_bin, @@gtid_binlog_pos as gtid_pos, @@server_id as server_id, @@read_only as read_only',
  );
  const logBin = String(binlog?.['log_bin'] ?? '0') === '1';

  if (replication.length === 0) {
    replication.push({
      role: 'primary',
      peer: '',
      state: logBin ? 'binlog activo, sin réplicas' : 'sin replicación',
      detail: { gtid_pos: text(binlog?.['gtid_pos']), server_id: text(binlog?.['server_id']) },
    });
  }
  snapshot.replication = replication;

  // ---------------------------------------------------------------- backups
  notes.push({
    domain: 'backups',
    level: 'info',
    message:
      'MariaDB tampoco lleva catálogo de backups: mariabackup y mysqldump no dejan registro dentro del servidor. Lo verificable desde dentro es el binlog, que permite recuperación a un punto en el tiempo si está activo y se conserva.',
  });

  if (!logBin) {
    notes.push({
      domain: 'backups',
      level: 'error',
      message:
        'log_bin está apagado: sin binlog no hay recuperación a un punto en el tiempo ni replicación posible. El respaldo queda limitado a la última copia completa.',
    });
  } else {
    const [expire] = await client.query(
      'select @@binlog_expire_logs_seconds as seconds, @@expire_logs_days as days',
    );
    snapshot.backups.push({
      database: '(servidor)',
      kind: 'wal_archive',
      finishedAt: null,
      source: 'binlog',
      detail: {
        log_bin: true,
        gtid_pos: text(binlog?.['gtid_pos']),
        expire_seconds: num(expire?.['seconds']),
        expire_days: num(expire?.['days']),
      },
    });
  }

  // ------------------------------------------------------------------- jobs
  const [sched] = await client.query('select @@event_scheduler as scheduler');
  const schedulerOn = String(sched?.['scheduler'] ?? 'OFF').toUpperCase() === 'ON';

  const events = await client.query(
    `select event_schema, event_name, status, last_executed, starts, ends,
            interval_value, interval_field, event_type, on_completion
       from information_schema.events
      order by event_schema, event_name`,
  );
  snapshot.jobs = events.map(
    (row): JobRow => ({
      scope: String(row['event_schema'] ?? ''),
      name: String(row['event_name']),
      enabled: String(row['status'] ?? '').toUpperCase() === 'ENABLED',
      lastRunAt: date(row['last_executed']),
      lastStatus: text(row['status']),
      detail: {
        type: text(row['event_type']),
        every: `${row['interval_value'] ?? ''} ${row['interval_field'] ?? ''}`.trim(),
        on_completion: text(row['on_completion']),
      },
    }),
  );

  if (!schedulerOn) {
    notes.push({
      domain: 'jobs',
      level: events.length > 0 ? 'warn' : 'info',
      message:
        events.length > 0
          ? `event_scheduler está en OFF: los ${events.length} eventos definidos no se están ejecutando.`
          : 'event_scheduler está en OFF y no hay eventos definidos. En MariaDB las tareas suelen vivir en el cron del sistema, que el motor no puede ver.',
    });
  }

  // -------------------------------------------------------------- licencias
  snapshot.licensing = {
    edition: 'MariaDB Community (código abierto)',
    licenseModel: 'GPL v2',
    productionOk: null,
    note: 'Sin costo de licencia ni límite de núcleos. MariaDB Enterprise es una suscripción de soporte, no un cambio de binario con límites.',
  };

  snapshot.notes = notes;
  return snapshot;
}
