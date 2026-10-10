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

  const notes: InventoryNote[] = [];

  // ----------------------------------------------------------- configuración
  // information_schema.system_variables trae el valor global y el default en la
  // misma fila, así que se sabe si alguien lo tocó — el equivalente del
  // `source = 'default'` de PostgreSQL.
  try {
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
  } catch (error) {
    notes.push({
      domain: 'settings',
      level: 'warn',
      message: `Could not read system_variables: ${
        error instanceof Error ? error.message : String(error)
      }. Grant PROCESS or use a privileged monitor user.`,
    });
  }

  // ------------------------------------------------------------------ disco
  try {
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
  } catch (error) {
    notes.push({
      domain: 'disk',
      level: 'warn',
      message: `Could not read table sizes: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  notes.push({
    domain: 'disk',
    level: 'info',
    message:
      'Sizes come from information_schema (data + indexes inside files), not volume free space. Host volume free space appears on the Host tab when system metrics are configured.',
  });

  // ------------------------------------------------------------ replicación
  const replication: ReplicationRow[] = [];
  try {
    const replica = await client.query('show replica status');
    for (const row of replica) {
      const io = String(row['Slave_IO_Running'] ?? row['Replica_IO_Running'] ?? 'Unknown');
      const sql = String(row['Slave_SQL_Running'] ?? row['Replica_SQL_Running'] ?? 'Unknown');
      replication.push({
        role: 'replica',
        peer: `${row['Source_Host'] ?? row['Master_Host'] ?? 'unknown'}:${
          row['Source_Port'] ?? row['Master_Port'] ?? ''
        }`,
        state: io === 'Yes' && sql === 'Yes' ? 'Yes' : `IO=${io} SQL=${sql}`,
        lagSeconds: num(row['Seconds_Behind_Master'] ?? row['Seconds_Behind_Source']),
        detail: {
          kind: 'async_replica',
          sql_running: sql,
          io_running: io,
          last_error: text(row['Last_Error'] || row['Last_IO_Error'] || row['Last_SQL_Error']),
          gtid: text(row['Gtid_IO_Pos']),
          using_gtid: text(row['Using_Gtid']),
          source_log_file: text(row['Master_Log_File'] ?? row['Source_Log_File']),
        },
      });
    }
  } catch (error) {
    notes.push({
      domain: 'replication',
      level: 'warn',
      message: `Could not read SHOW REPLICA STATUS: ${
        error instanceof Error ? error.message : String(error)
      }. Grant REPLICATION CLIENT to the monitor user.`,
    });
  }

  // Connected replicas registered against this primary (needs REPLICATION MASTER ADMIN).
  try {
    let hosts: Record<string, unknown>[] = [];
    try {
      hosts = await client.query('show replica hosts');
    } catch {
      hosts = await client.query('show slave hosts');
    }
    for (const row of hosts) {
      replication.push({
        role: 'standby',
        peer: `${row['Host'] ?? row['host'] ?? 'unknown'}:${row['Port'] ?? row['port'] ?? ''}`,
        state: 'connected',
        detail: { kind: 'registered_replica', server_id: text(row['Server_id'] ?? row['Server_Id']) },
      });
    }
  } catch (error) {
    notes.push({
      domain: 'replication',
      level: 'info',
      message:
        `Could not list connected replicas (SHOW REPLICA HOSTS): ${
          error instanceof Error ? error.message : String(error)
        }. Replicas must set report_host; grant REPLICATION MASTER ADMIN to list them.`,
    });
  }

  // Also surface Binlog Dump threads in PROCESSLIST — works for ring topologies
  // even when report_host is unset.
  try {
    const dumpers = await client.query(`
      select id, user, host, command, state
        from information_schema.processlist
       where command in ('Binlog Dump', 'Binlog Dump GTID')`);
    for (const row of dumpers) {
      const peer = String(row['host'] ?? 'unknown');
      if (replication.some((r) => (r.peer ?? '').includes(peer.split(':')[0] ?? peer))) continue;
      replication.push({
        role: 'standby',
        peer,
        state: String(row['state'] ?? 'binlog dump'),
        detail: {
          kind: 'binlog_dump_thread',
          thread_id: text(row['id']),
          user: text(row['user']),
        },
      });
    }
  } catch {
    // PROCESS privilege may be missing; sessions note already covers that.
  }

  let binlog: Record<string, unknown> | undefined;
  try {
    [binlog] = await client.query(
      `select @@log_bin as log_bin,
              @@gtid_binlog_pos as gtid_pos,
              @@server_id as server_id,
              @@read_only as read_only,
              @@binlog_format as binlog_format,
              @@log_bin_basename as log_bin_basename`,
    );
  } catch (error) {
    notes.push({
      domain: 'replication',
      level: 'warn',
      message: `Could not read binlog settings: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  const logBin = String(binlog?.['log_bin'] ?? '0') === '1';
  const isReplica = replication.some((row) => row.role === 'replica');
  const connectedReplicas = replication.filter((row) => row.role === 'standby').length;

  if (!isReplica) {
    // Always emit an explicit primary / HA posture row so the console never
    // looks "empty" when there are simply no replicas yet.
    const state = !logBin
      ? 'standalone — binary log OFF (cannot accept replicas or do PITR)'
      : connectedReplicas > 0
        ? `primary — ${connectedReplicas} registered replica(s)`
        : 'primary — binary log ON, no connected replicas';
    replication.unshift({
      role: 'primary',
      peer: '',
      state,
      detail: {
        kind: 'ha_posture',
        log_bin: logBin,
        gtid_pos: text(binlog?.['gtid_pos']),
        server_id: text(binlog?.['server_id']),
        read_only: text(binlog?.['read_only']),
        binlog_format: text(binlog?.['binlog_format']),
        connected_replicas: connectedReplicas,
      },
    });
  }

  if (!logBin && !isReplica) {
    notes.push({
      domain: 'replication',
      level: 'warn',
      message:
        'Binary logging is OFF (log_bin=0). This MariaDB cannot be a replication primary and has no point-in-time recovery. Enable log_bin in my.cnf and restart to start accepting replicas.',
    });
  } else if (logBin && connectedReplicas === 0 && !isReplica) {
    notes.push({
      domain: 'replication',
      level: 'info',
      message:
        'This instance can be a primary (binlog on) but no replicas are registered via SHOW REPLICA HOSTS / dump threads. For ring topologies, add each node as a Búho target, or set report_host on replicas.',
    });
  }
  snapshot.replication = replication;

  // ---------------------------------------------------------------- backups
  notes.push({
    domain: 'backups',
    level: 'info',
    message:
      'MariaDB has no in-server backup catalog: mariabackup and mysqldump leave no record inside the engine. What is verifiable from inside is the binlog, which enables point-in-time recovery when it is on and retained.',
  });

  if (!logBin) {
    notes.push({
      domain: 'backups',
      level: 'error',
      message:
        'log_bin is off: without the binary log there is no point-in-time recovery or replication. Recovery is limited to the last full copy.',
    });
  } else {
    const [expire] = await client.query(
      'select @@binlog_expire_logs_seconds as seconds, @@expire_logs_days as days',
    );
    snapshot.backups.push({
      database: '(server)',
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
  try {
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
            ? `event_scheduler is OFF: the ${events.length} defined event(s) are not running.`
            : 'event_scheduler is OFF and no events are defined. On MariaDB, scheduled work usually lives in system cron, which the engine cannot see.',
      });
    }
  } catch (error) {
    notes.push({
      domain: 'jobs',
      level: 'warn',
      message: `Could not read events: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  // -------------------------------------------------------------- licencias
  snapshot.licensing = {
    edition: 'MariaDB Community (open source)',
    licenseModel: 'GPL v2',
    productionOk: null,
    note: 'No license cost and no core limits. MariaDB Enterprise is a support subscription, not a different binary with caps.',
  };

  snapshot.notes = notes;
  return snapshot;
}
