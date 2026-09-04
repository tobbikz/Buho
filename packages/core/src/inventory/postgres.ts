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
                     coalesce(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)
                       as lag_bytes,
                     extract(epoch from (now() - latest_end_time)) as receiver_idle_seconds
                from pg_stat_wal_receiver`),
    );
    // When the receiver is down, primary_conninfo still names the configured
    // upstream — enough to link a monitored primary in the UI without storing
    // the password (conninfo is redacted to host/port only).
    const [conninfoRow] = await client.query(
      tagged(`select current_setting('primary_conninfo', true) as primary_conninfo`),
    );
    const conninfo = String(conninfoRow?.['primary_conninfo'] ?? '');
    const configuredHost =
      conninfo.match(/\bhost\s*=\s*'([^']+)'/i)?.[1] ??
      conninfo.match(/\bhost\s*=\s*([^\s']+)/i)?.[1] ??
      null;
    const configuredPort =
      conninfo.match(/\bport\s*=\s*'?(\d+)'?/i)?.[1] ?? null;

    const pending = num(receiver?.['lag_bytes']) ?? 0;
    // Without recent commits, latest_end_time goes stale while the standby is
    // fully caught up. Bytes pending is the signal that matters.
    const lagSeconds = pending > 0 ? num(receiver?.['receiver_idle_seconds']) : null;
    const livePeer =
      receiver && receiver['sender_host']
        ? `${receiver['sender_host']}:${receiver['sender_port'] ?? configuredPort ?? '5432'}`
        : null;
    const configuredPeer =
      configuredHost != null
        ? `${configuredHost}:${configuredPort ?? '5432'}`
        : null;
    replication.push({
      role: 'upstream',
      peer: livePeer ?? configuredPeer ?? 'unknown primary',
      state: text(receiver?.['status']) ?? 'no WAL receiver',
      lagBytes: pending > 0 ? pending : 0,
      lagSeconds,
      detail: {
        slot: text(receiver?.['slot_name']),
        idle_since_last_commit: pending === 0 ? num(receiver?.['receiver_idle_seconds']) : null,
        configured_host: configuredHost,
        configured_port: configuredPort !== null ? Number(configuredPort) : null,
        live: Boolean(receiver),
      },
    });
  } else {
    const standbys = await client.query(
      tagged(`select host(client_addr) as client_addr,
                     client_hostname,
                     application_name,
                     state,
                     sync_state,
                     sync_priority,
                     pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes,
                     extract(epoch from replay_lag) as lag_seconds
                from pg_stat_replication`),
    );
    for (const row of standbys) {
      const application = text(row['application_name']);
      const clientAddr = text(row['client_addr']);
      const clientHostname = text(row['client_hostname']);
      // Prefer a stable human name over the generic walreceiver label.
      const peer =
        (application && !['walreceiver', 'postgres', '(sin nombre)'].includes(application)
          ? application
          : null) ??
        clientHostname ??
        clientAddr ??
        application ??
        'unknown';
      replication.push({
        role: 'standby',
        peer,
        state: text(row['state']),
        lagBytes: num(row['lag_bytes']),
        lagSeconds: num(row['lag_seconds']),
        detail: {
          sync_state: text(row['sync_state']),
          sync_priority: num(row['sync_priority']),
          application,
          client_addr: clientAddr,
          client_hostname: clientHostname,
        },
      });
    }

    const slots = await client.query(
      tagged(`select slot_name, slot_type, active, coalesce(wal_status, 'unknown') as wal_status,
                     pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as retained_bytes
                from pg_replication_slots`),
    );
    for (const row of slots) {
      replication.push({
        role: 'slot',
        peer: String(row['slot_name']),
        state: row['active'] === true ? 'active' : 'inactive',
        lagBytes: num(row['retained_bytes']),
        detail: { type: text(row['slot_type']), wal_status: text(row['wal_status']) },
      });
    }

    if (replication.length === 0) {
      replication.push({ role: 'primary', peer: '', state: 'no replicas or slots' });
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
        'PostgreSQL does not expose a backup catalog: the server cannot report when pg_dump or pg_basebackup last ran. Búho reports what is verifiable from inside the instance — WAL archiving — and real backup tools (pgBackRest, Barman, client scripts) must be integrated separately. Operational dump/pgBackRest jobs stay outside Búho (as in prod Airflow BACKUPS); Búho alerts on archive health and check findings.',
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
        'archive_mode is off: WAL is not archived, so point-in-time recovery is impossible. After a crash, everything since the last full backup is lost.',
    });
  } else {
    const failed = num(archiver?.['failed_count']) ?? 0;
    const archived = num(archiver?.['archived_count']) ?? 0;
    if (failed > 0 && archived === 0) {
      notes.push({
        domain: 'backups',
        level: 'error',
        message: `WAL archiving is configured but failing: ${failed} failed attempts and no archived files. The recovery chain is broken.`,
      });
    }
  }

  const running = num(archiver?.['running_basebackups']) ?? 0;
  if (running > 0) {
    notes.push({
      domain: 'backups',
      level: 'info',
      message: `${running} pg_basebackup job(s) running right now.`,
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
      message: 'pgAgent is installed; reading its catalog is not implemented yet.',
    });
  } else {
    notes.push({
      domain: 'jobs',
      level: 'info',
      message:
        'PostgreSQL has no built-in job scheduler. Scheduled tasks live outside the engine (system cron, systemd timers, Airflow) and cannot be seen from the database. With pg_cron installed, Búho lists jobs and the latest run result.',
    });
  }

  // -------------------------------------------------------------- licencias
  snapshot.licensing = {
    edition: 'PostgreSQL (open source)',
    licenseModel: 'PostgreSQL License (permissive, BSD/MIT-style)',
    productionOk: null,
    note: 'No license cost and no core or memory limits. Nothing to audit.',
  };

  snapshot.notes = notes;
  return snapshot;
}

export const POSTGRES_BACKUP_ROWS: BackupRow[] = [];
