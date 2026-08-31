import type { EngineClient } from '../engine';
import { tagged } from '../tag';
import { eolFor } from './eol';
import {
  date,
  emptySnapshot,
  num,
  text,
  type BackupRow,
  type DiskObject,
  type InventoryNote,
  type InventorySnapshot,
  type JobRow,
  type ReplicationRow,
  type SettingRow,
} from './types';

/**
 * Parámetros que un DBA revisa en una auditoría. No se traen los ~350 de
 * pg_settings: una lista de 350 filas no se audita, se ignora.
 */
const AUDITED = [
  'archive_mode',
  'archive_command',
  'archive_library',
  'autovacuum',
  'checkpoint_completion_target',
  'checkpoint_timeout',
  'default_transaction_read_only',
  'effective_cache_size',
  'fsync',
  'full_page_writes',
  'idle_in_transaction_session_timeout',
  'lock_timeout',
  'log_min_duration_statement',
  'maintenance_work_mem',
  'max_connections',
  'max_wal_size',
  'max_worker_processes',
  'password_encryption',
  'random_page_cost',
  'shared_buffers',
  'shared_preload_libraries',
  'ssl',
  'statement_timeout',
  'synchronous_commit',
  'track_io_timing',
  'wal_compression',
  'wal_level',
  'work_mem',
];

export async function collectPostgres(client: EngineClient): Promise<InventorySnapshot> {
  const [version] = await client.query(
    tagged(`select current_setting('server_version') as version,
                   current_setting('server_version_num')::int as version_num,
                   version() as full_text,
                   current_setting('server_encoding') as encoding,
                   pg_postmaster_start_time() as started_at,
                   current_setting('max_connections')::int as max_connections`),
  );

  const versionText = String(version?.['version'] ?? '');
  const snapshot = emptySnapshot({
    engine: 'postgres',
    versionNum: num(version?.['version_num']),
    versionText: String(version?.['full_text'] ?? versionText).split(' on ')[0] ?? versionText,
    collation: text(version?.['encoding']),
    startedAt: date(version?.['started_at']),
    eolDate: eolFor('postgres', versionText),
  });

  // ----------------------------------------------------------- configuración
  // reset_val y no setting: el driver manda parámetros en el paquete de
  // arranque (statement_timeout entre ellos), así que `setting` refleja la
  // sesión de Búho y no lo que tiene configurado el servidor. Ya nos mordió
  // una vez con los checks de timeouts.
  const settings = await client.query(
    tagged(`select name, reset_val as value, unit, category, source = 'default' as is_default,
                   context in ('postmaster', 'sighup') as requires_restart
              from pg_settings
             where name = any (array[${AUDITED.map((name) => `'${name}'`).join(',')}])
             order by name`),
  );
  snapshot.settings = settings.map(
    (row): SettingRow => ({
      name: String(row['name']),
      value: String(row['value'] ?? ''),
      unit: text(row['unit']),
      category: text(row['category']),
      isDefault: row['is_default'] === true,
      requiresRestart: row['requires_restart'] === true,
    }),
  );

  // ------------------------------------------------------------------ disco
  const databases = await client.query(
    tagged(`select datname as name, pg_database_size(oid) as size_bytes
              from pg_database
             where datallowconn and not datistemplate
             order by 2 desc`),
  );
  const tablespaces = await client.query(
    tagged(`select spcname as name,
                   coalesce(nullif(pg_tablespace_location(oid), ''), 'directorio de datos') as location,
                   pg_tablespace_size(oid) as size_bytes
              from pg_tablespace
             order by 3 desc`),
  );

  snapshot.disks = [
    ...databases.map(
      (row): DiskObject => ({
        kind: 'database',
        name: String(row['name']),
        sizeBytes: num(row['size_bytes']),
      }),
    ),
    ...tablespaces.map(
      (row): DiskObject => ({
        kind: 'tablespace',
        name: String(row['name']),
        location: text(row['location']),
        sizeBytes: num(row['size_bytes']),
      }),
    ),
  ];

  // ------------------------------------------------------------ replicación
  const [recovery] = await client.query(
    tagged('select pg_is_in_recovery() as in_recovery'),
  );
  const inRecovery = recovery?.['in_recovery'] === true;
  const replication: ReplicationRow[] = [];

  if (inRecovery) {
    const [receiver] = await client.query(
      tagged(`select status, sender_host, sender_port, slot_name,
                     latest_end_lsn, latest_end_time,
                     extract(epoch from (now() - latest_end_time)) as lag_seconds
                from pg_stat_wal_receiver`),
    );
    replication.push({
      // `upstream` y no `standby`: en una réplica esta fila describe el enlace
      // con su primario, no un standby ajeno. Con el mismo nombre para las dos
      // cosas, la pantalla de una réplica se lista a sí misma como su propio
      // standby.
      role: 'upstream',
      peer: receiver ? `${receiver['sender_host']}:${receiver['sender_port']}` : 'primario desconocido',
      state: text(receiver?.['status']) ?? 'sin receptor de WAL',
      lagSeconds: num(receiver?.['lag_seconds']),
      detail: { slot: text(receiver?.['slot_name']) },
    });
  } else {
    const standbys = await client.query(
      tagged(`select client_addr::text as peer, application_name, state, sync_state,
                     pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes,
                     extract(epoch from replay_lag) as lag_seconds
                from pg_stat_replication`),
    );
    for (const row of standbys) {
      replication.push({
        role: 'standby',
        peer: text(row['peer']) ?? String(row['application_name'] ?? 'desconocido'),
        state: text(row['state']),
        lagBytes: num(row['lag_bytes']),
        lagSeconds: num(row['lag_seconds']),
        detail: { sync_state: text(row['sync_state']), application: text(row['application_name']) },
      });
    }

    const slots = await client.query(
      tagged(`select slot_name, slot_type, active, coalesce(wal_status, 'desconocido') as wal_status,
                     pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as retained_bytes
                from pg_replication_slots`),
    );
    for (const row of slots) {
      replication.push({
        role: 'slot',
        peer: String(row['slot_name']),
        state: row['active'] === true ? 'activo' : 'inactivo',
        lagBytes: num(row['retained_bytes']),
        detail: { type: text(row['slot_type']), wal_status: text(row['wal_status']) },
      });
    }

    if (replication.length === 0) {
      replication.push({ role: 'primary', peer: '', state: 'sin réplicas ni slots' });
    }
  }
  snapshot.replication = replication;

  // ---------------------------------------------------------------- backups
  // Acá está el límite honesto del motor: PostgreSQL **no tiene catálogo de
  // backups**. Nada en el servidor sabe si anoche corrió un pg_dump o un
  // pgBackRest. Lo único verificable desde dentro es el archivado de WAL, que
  // responde una pregunta distinta pero crítica: si esto está apagado, no hay
  // recuperación a un punto en el tiempo, y entonces el "backup" es a lo sumo
  // una foto de anoche.
  const [archiver] = await client.query(
    tagged(`select a.archived_count, a.last_archived_wal, a.last_archived_time,
                   a.failed_count, a.last_failed_wal, a.last_failed_time,
                   current_setting('archive_mode') as archive_mode,
                   (select count(*) from pg_stat_progress_basebackup) as running_basebackups
              from pg_stat_archiver a`),
  );

  const archiveMode = String(archiver?.['archive_mode'] ?? 'off');
  const notes: InventoryNote[] = [
    {
      domain: 'backups',
      level: 'info',
      message:
        'PostgreSQL no expone un catálogo de backups: ningún dato del servidor dice cuándo corrió el último pg_dump o pg_basebackup. Búho reporta lo que sí es verificable desde dentro — el archivado de WAL — y para respaldos reales hace falta integrar pgBackRest, Barman o el propio script del cliente.',
    },
  ];

  // La fila se emite **siempre**, incluso con el archivado apagado.
  //
  // En una vista de flota, una instancia que no aparece en la tabla de backups
  // se lee como una instancia sana. Si el servidor no tiene forma de recuperarse
  // tiene que estar en la lista, en rojo, no ausente.
  snapshot.backups.push({
    database: '(servidor)',
    kind: 'wal_archive',
    finishedAt: archiveMode === 'off' ? null : date(archiver?.['last_archived_time']),
    source: 'pg_stat_archiver',
    detail: {
      archive_mode: archiveMode,
      archived_count: num(archiver?.['archived_count']),
      failed_count: num(archiver?.['failed_count']),
      last_archived_wal: text(archiver?.['last_archived_wal']),
      last_failed_wal: text(archiver?.['last_failed_wal']),
      last_failed_time: text(archiver?.['last_failed_time']),
    },
  });

  if (archiveMode === 'off') {
    notes.push({
      domain: 'backups',
      level: 'error',
      message:
        'archive_mode está en off: no hay archivado de WAL, así que no existe recuperación a un punto en el tiempo. Ante una caída se pierde todo lo ocurrido desde el último respaldo completo.',
    });
  } else {
    const failed = num(archiver?.['failed_count']) ?? 0;
    const archived = num(archiver?.['archived_count']) ?? 0;
    if (failed > 0 && archived === 0) {
      notes.push({
        domain: 'backups',
        level: 'error',
        message: `El archivado de WAL está configurado pero falla: ${failed} intentos fallidos y ningún archivo archivado. La cadena de recuperación está rota.`,
      });
    }
  }

  const running = num(archiver?.['running_basebackups']) ?? 0;
  if (running > 0) {
    notes.push({
      domain: 'backups',
      level: 'info',
      message: `Hay ${running} pg_basebackup en curso ahora mismo.`,
    });
  }

  // ------------------------------------------------------------------- jobs
  // PostgreSQL no trae planificador. Si hay pg_cron o pgAgent instalado se leen
  // sus tablas; si no, se dice que las tareas viven fuera del motor (cron del
  // sistema, systemd timers, Airflow) y que el motor no las puede ver.
  const [scheduler] = await client.query(
    tagged(`select (select count(*) from pg_extension where extname = 'pg_cron') as has_pg_cron,
                   (select count(*) from pg_extension where extname = 'pgagent') as has_pgagent`),
  );

  const hasCron = (num(scheduler?.['has_pg_cron']) ?? 0) > 0;
  const hasAgent = (num(scheduler?.['has_pgagent']) ?? 0) > 0;

  if (hasCron) {
    const jobs = await client.query(
      tagged(`select j.jobid, j.jobname, j.schedule, j.database, j.active,
                     r.status, r.start_time, r.end_time,
                     extract(epoch from (r.end_time - r.start_time)) * 1000 as duration_ms
                from cron.job j
                left join lateral (
                  select status, start_time, end_time
                    from cron.job_run_details d
                   where d.jobid = j.jobid
                   order by start_time desc
                   limit 1
                ) r on true
               order by j.jobname`),
    );
    snapshot.jobs = jobs.map(
      (row): JobRow => ({
        scope: 'pg_cron',
        name: String(row['jobname'] ?? row['jobid']),
        enabled: row['active'] === true,
        lastRunAt: date(row['start_time']),
        lastStatus: text(row['status']),
        lastDurationMs: num(row['duration_ms']),
        detail: { schedule: text(row['schedule']), database: text(row['database']) },
      }),
    );
  } else if (hasAgent) {
    notes.push({
      domain: 'jobs',
      level: 'info',
      message: 'pgAgent está instalado; la lectura de su catálogo todavía no está implementada.',
    });
  } else {
    notes.push({
      domain: 'jobs',
      level: 'info',
      message:
        'PostgreSQL no tiene planificador propio. Las tareas programadas viven fuera del motor (cron del sistema, systemd timers, Airflow) y desde la base no se pueden ver. Con pg_cron instalado, Búho lista sus tareas y el resultado de la última corrida.',
    });
  }

  // -------------------------------------------------------------- licencias
  snapshot.licensing = {
    edition: 'PostgreSQL (código abierto)',
    licenseModel: 'PostgreSQL License (permisiva, tipo BSD/MIT)',
    productionOk: null,
    note: 'Sin costo de licencia ni límite de núcleos o memoria. No hay nada que auditar.',
  };

  snapshot.notes = notes;
  return snapshot;
}

export const POSTGRES_BACKUP_ROWS: BackupRow[] = [];
