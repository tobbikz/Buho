import type { EngineClient } from '../engine';
import { eolFor, mssqlProductName } from './eol';
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
  type LicensingRow,
  type ReplicationRow,
  type SettingRow,
} from './types';

const AUDITED = [
  'max server memory (MB)',
  'min server memory (MB)',
  'max degree of parallelism',
  'cost threshold for parallelism',
  'optimize for ad hoc workloads',
  'remote admin connections',
  'backup compression default',
  'backup checksum default',
  'fill factor (%)',
  'max worker threads',
  'recovery interval (min)',
  'xp_cmdshell',
  'Ole Automation Procedures',
  'clr enabled',
  'Database Mail XPs',
  'remote access',
  'default trace enabled',
  'common criteria compliance enabled',
];

/** Límites por edición, en núcleos y en memoria del buffer pool. */
const EDITION_LIMITS: Record<string, { cores: number | null; memoryGb: number | null; productionOk: boolean; note: string }> = {
  enterprise: {
    cores: null,
    memoryGb: null,
    note: 'Enterprise: no core or memory cap. Most expensive per-core edition.',
    productionOk: true,
  },
  standard: {
    cores: 24,
    memoryGb: 128,
    note: 'Standard: capped at 24 cores (or 4 sockets, whichever is lower) and 128 GB buffer pool. Cores above the cap are unused.',
    productionOk: true,
  },
  web: {
    cores: 16,
    memoryGb: 64,
    note: 'Web: capped at 16 cores and 64 GB. Only licensable through a hosting provider.',
    productionOk: true,
  },
  express: {
    cores: 4,
    memoryGb: 1.4,
    note: 'Express: 4 cores, 1.4 GB buffer pool, 10 GB per database. Free — the 10 GB cap is the classic production surprise.',
    productionOk: true,
  },
  developer: {
    cores: null,
    memoryGb: null,
    note: 'Developer: Enterprise features, free license, but production use is prohibited. Real workloads on this edition are a compliance violation.',
    productionOk: false,
  },
  evaluation: {
    cores: null,
    memoryGb: null,
    note: 'Evaluation: expires after 180 days and stops starting. Not for production.',
    productionOk: false,
  },
};

function editionKey(edition: string): string {
  const lower = edition.toLowerCase();
  for (const key of Object.keys(EDITION_LIMITS)) {
    if (lower.includes(key)) return key;
  }
  return 'enterprise';
}

export async function collectMssql(client: EngineClient): Promise<InventorySnapshot> {
  const [props] = await client.query(
    `select serverproperty('ProductVersion') as product_version,
            serverproperty('ProductLevel') as product_level,
            serverproperty('ProductUpdateLevel') as update_level,
            serverproperty('Edition') as edition,
            serverproperty('EngineEdition') as engine_edition,
            serverproperty('Collation') as collation,
            serverproperty('IsHadrEnabled') as hadr_enabled,
            serverproperty('IsIntegratedSecurityOnly') as integrated_only,
            serverproperty('InstanceName') as instance_name,
            @@version as full_text`,
  );

  const productVersion = String(props?.['product_version'] ?? '');
  const major = Number(productVersion.split('.')[0] ?? 0);
  const productName = mssqlProductName(major);

  const [sysinfo] = await client.query(
    `select cpu_count, hyperthread_ratio, socket_count, cores_per_socket,
            physical_memory_kb, committed_target_kb, sqlserver_start_time,
            virtual_machine_type_desc
       from sys.dm_os_sys_info`,
  );

  const edition = String(props?.['edition'] ?? '');
  const snapshot = emptySnapshot({
    engine: 'mssql',
    // 16.0.4265.3 → 160004 para que ordene igual que el server_version_num de PG.
    versionNum: major > 0 ? major * 10_000 + Number(productVersion.split('.')[2] ?? 0) : null,
    versionText: `${productName ?? `SQL Server ${major}`} ${productVersion} ${
      props?.['update_level'] ? String(props['update_level']) : String(props?.['product_level'] ?? '')
    }`.trim(),
    edition,
    productLevel: text(props?.['product_level']),
    updateLevel: text(props?.['update_level']),
    collation: text(props?.['collation']),
    startedAt: date(sysinfo?.['sqlserver_start_time']),
    cores: num(sysinfo?.['cpu_count']),
    memoryBytes: (num(sysinfo?.['physical_memory_kb']) ?? 0) * 1024 || null,
    eolDate: eolFor('mssql', productVersion),
  });

  const notes: InventoryNote[] = [];

  // ----------------------------------------------------------- configuración
  const settings = await client.query(
    `select name, cast(value_in_use as nvarchar(64)) as value,
            cast(value as nvarchar(64)) as pending_value,
            is_dynamic, is_advanced, description
       from sys.configurations
      order by name`,
  );
  snapshot.settings = settings
    .filter((row) => AUDITED.some((name) => name.toLowerCase() === String(row['name']).toLowerCase()))
    .map(
      (row): SettingRow => ({
        name: String(row['name']),
        value: String(row['value'] ?? ''),
        category: row['is_advanced'] === true ? 'avanzado' : 'básico',
        // is_dynamic = false significa que el cambio necesita reinicio del
        // servicio; es el equivalente del context 'postmaster' de PostgreSQL.
        requiresRestart: row['is_dynamic'] === false,
        isDefault: null,
        unit: String(row['name']).includes('(MB)') ? 'MB' : null,
      }),
    );

  // Un valor pendiente (value != value_in_use) es un cambio hecho con
  // sp_configure sin RECONFIGURE, o que espera reinicio: el DBA cree que ya
  // aplicó y no aplicó.
  const pending = settings.filter(
    (row) => String(row['value'] ?? '') !== String(row['pending_value'] ?? ''),
  );
  if (pending.length > 0) {
    notes.push({
      domain: 'settings',
      level: 'warn',
      message: `${pending.length} parámetro(s) tienen un valor configurado distinto al que está en uso (${pending
        .map((row) => String(row['name']))
        .slice(0, 4)
        .join(', ')}): falta RECONFIGURE o reiniciar el servicio.`,
    });
  }

  // ------------------------------------------------------------------ disco
  const files = await client.query(
    `select db_name(mf.database_id) as db, mf.name as logical_name, mf.type_desc,
            cast(mf.size as bigint) * 8192 as size_bytes,
            case when mf.max_size = -1 then null
                 when mf.max_size = 268435456 then null
                 else cast(mf.max_size as bigint) * 8192 end as max_bytes,
            mf.growth, mf.is_percent_growth, mf.physical_name
       from sys.master_files mf
      order by mf.size desc`,
  );
  const volumes = await client.query(
    `select distinct vs.volume_mount_point, vs.logical_volume_name, vs.file_system_type,
            vs.total_bytes, vs.available_bytes
       from sys.master_files mf
       cross apply sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs`,
  );

  const byDatabase = new Map<string, { size: number; log: number }>();
  for (const row of files) {
    const db = String(row['db'] ?? 'desconocida');
    const size = num(row['size_bytes']) ?? 0;
    const entry = byDatabase.get(db) ?? { size: 0, log: 0 };
    entry.size += size;
    if (String(row['type_desc']) === 'LOG') entry.log += size;
    byDatabase.set(db, entry);
  }

  snapshot.disks = [
    ...[...byDatabase.entries()].map(
      ([name, entry]): DiskObject => ({
        kind: 'database',
        name,
        sizeBytes: entry.size,
        detail: { log_bytes: entry.log, data_bytes: entry.size - entry.log },
      }),
    ),
    ...files.map(
      (row): DiskObject => ({
        kind: 'file',
        name: String(row['logical_name']),
        container: String(row['db'] ?? ''),
        sizeBytes: num(row['size_bytes']),
        maxBytes: num(row['max_bytes']),
        location: text(row['physical_name']),
        detail: {
          type: text(row['type_desc']),
          growth: num(row['growth']),
          percent_growth: row['is_percent_growth'] === true,
        },
      }),
    ),
    ...volumes.map(
      (row): DiskObject => ({
        kind: 'volume',
        // En contenedores el punto de montaje viene null aunque los tamaños
        // sí lleguen.
        name: text(row['volume_mount_point']) ?? text(row['logical_volume_name']) ?? '(volumen)',
        sizeBytes: num(row['total_bytes']),
        freeBytes: num(row['available_bytes']),
        detail: { file_system: text(row['file_system_type']) },
      }),
    ),
  ];

  // Crecimiento porcentual en archivos grandes: cada crecimiento es más grande
  // que el anterior y termina en una pausa larga en producción.
  const percentGrowth = files.filter(
    (row) => row['is_percent_growth'] === true && (num(row['size_bytes']) ?? 0) > 1024 ** 3,
  );
  if (percentGrowth.length > 0) {
    notes.push({
      domain: 'disk',
      level: 'warn',
      message: `${percentGrowth.length} archivo(s) de más de 1 GB crecen por porcentaje en vez de por tamaño fijo: cada crecimiento es mayor que el anterior y bloquea más tiempo.`,
    });
  }

  // ---------------------------------------------------------------- backups
  // Acá SQL Server sí tiene catálogo real (msdb.dbo.backupset), y por eso este
  // tab responde de verdad en este motor.
  const backups = await client.query(
    `select d.name as db, d.recovery_model_desc, d.state_desc,
            max(case when b.type = 'D' then b.backup_finish_date end) as last_full,
            max(case when b.type = 'I' then b.backup_finish_date end) as last_diff,
            max(case when b.type = 'L' then b.backup_finish_date end) as last_log,
            max(case when b.type = 'D' then b.backup_size end) as full_size,
            count(b.backup_set_id) as backup_count
       from sys.databases d
       left join msdb.dbo.backupset b
              on b.database_name = d.name and b.is_copy_only = 0
      where d.database_id <> 2
      group by d.name, d.recovery_model_desc, d.state_desc
      order by d.name`,
  );

  const rows: BackupRow[] = [];
  const neverBackedUp: string[] = [];
  const fullWithoutLog: string[] = [];

  for (const row of backups) {
    const db = String(row['db']);
    const recovery = String(row['recovery_model_desc'] ?? '');
    const lastFull = date(row['last_full']);
    const lastLog = date(row['last_log']);

    rows.push({
      database: db,
      kind: 'full',
      finishedAt: lastFull,
      sizeBytes: num(row['full_size']),
      source: 'msdb',
      detail: { recovery_model: recovery, state: text(row['state_desc']), backup_count: num(row['backup_count']) },
    });
    const lastDiff = date(row['last_diff']);
    rows.push({
      database: db,
      kind: 'differential',
      finishedAt: lastDiff,
      source: 'msdb',
      detail: { recovery_model: recovery },
    });
    if (recovery === 'FULL' || recovery === 'BULK_LOGGED') {
      rows.push({ database: db, kind: 'log', finishedAt: lastLog, source: 'msdb', detail: { recovery_model: recovery } });
      if (!lastLog) fullWithoutLog.push(db);
    }
    if (!lastFull) neverBackedUp.push(db);
  }
  snapshot.backups = rows;

  if (neverBackedUp.length > 0) {
    notes.push({
      domain: 'backups',
      level: 'error',
      message: `Sin ningún respaldo completo registrado: ${neverBackedUp.join(', ')}. Si el servidor se pierde, estas bases se pierden con él.`,
    });
  }
  if (fullWithoutLog.length > 0) {
    notes.push({
      domain: 'backups',
      level: 'error',
      message: `En modelo FULL pero sin respaldo de log: ${fullWithoutLog.join(
        ', ',
      )}. El log de transacciones no se puede truncar y va a crecer hasta llenar el disco.`,
    });
  }

  // ------------------------------------------------------------------- jobs
  const jobs = await client.query(
    `select j.name, j.enabled, j.description,
            h.run_status, h.run_date, h.run_time, h.run_duration,
            s.next_run_date, s.next_run_time,
            c.name as category
       from msdb.dbo.sysjobs j
       left join msdb.dbo.syscategories c on c.category_id = j.category_id
       left join (
         select job_id, min(next_run_date) as next_run_date, min(next_run_time) as next_run_time
           from msdb.dbo.sysjobschedules group by job_id
       ) s on s.job_id = j.job_id
       outer apply (
         select top 1 run_status, run_date, run_time, run_duration
           from msdb.dbo.sysjobhistory
          where job_id = j.job_id and step_id = 0
          order by run_date desc, run_time desc
       ) h
      order by j.name`,
  );

  const STATUS: Record<string, string> = {
    '0': 'falló',
    '1': 'exitoso',
    '2': 'reintento',
    '3': 'cancelado',
    '4': 'en progreso',
  };

  snapshot.jobs = jobs.map((row): JobRow => {
    const runStatus = num(row['run_status']);
    return {
      scope: text(row['category']) ?? 'SQL Agent',
      name: String(row['name']),
      enabled: row['enabled'] === 1 || row['enabled'] === true,
      lastRunAt: msdbDate(row['run_date'], row['run_time']),
      lastStatus: runStatus === null ? null : STATUS[String(runStatus)] ?? String(runStatus),
      lastDurationMs: msdbDuration(num(row['run_duration'])),
      nextRunAt: msdbDate(row['next_run_date'], row['next_run_time']),
      detail: { description: text(row['description']) },
    };
  });

  const failed = snapshot.jobs.filter((job) => job.lastStatus === 'falló');
  if (failed.length > 0) {
    notes.push({
      domain: 'jobs',
      level: 'error',
      message: `${failed.length} job(s) terminaron con error en su última corrida: ${failed
        .map((job) => job.name)
        .slice(0, 5)
        .join(', ')}.`,
    });
  }
  const disabled = snapshot.jobs.filter((job) => job.enabled === false);
  if (disabled.length > 0) {
    notes.push({
      domain: 'jobs',
      level: 'warn',
      message: `${disabled.length} job(s) están deshabilitados: ${disabled
        .map((job) => job.name)
        .slice(0, 5)
        .join(', ')}. Un job de respaldo deshabilitado no avisa que no corrió.`,
    });
  }

  // ------------------------------------------------------------ replicación / HA
  const replication: ReplicationRow[] = [];
  const hadr = props?.['hadr_enabled'] === 1 || props?.['hadr_enabled'] === true;

  // Always surface Always On posture — an empty AG list with HADR off used to
  // look like "Búho does not support AG" rather than "AG is disabled here".
  replication.push({
    role: 'availability_group',
    peer: '',
    state: hadr ? 'Always On enabled' : 'Always On DISABLED',
    detail: {
      kind: 'hadr_posture',
      is_hadr_enabled: hadr,
      edition: edition,
      note: hadr
        ? 'sys.availability_groups is readable; replica rows follow when groups exist.'
        : 'SERVERPROPERTY(IsHadrEnabled)=0. Enable Always On Availability Groups on Windows Server / failover cluster, or use log shipping / transactional replication below.',
    },
  });

  if (hadr) {
    try {
      const replicas = await client.query(
        `select ar.replica_server_name, ar.availability_mode_desc, ar.failover_mode_desc,
                hars.role_desc, hars.synchronization_health_desc, hars.connected_state_desc,
                ag.name as group_name
           from sys.availability_replicas ar
           join sys.availability_groups ag on ag.group_id = ar.group_id
           left join sys.dm_hadr_availability_replica_states hars on hars.replica_id = ar.replica_id`,
      );
      for (const row of replicas) {
        replication.push({
          role: 'availability_group',
          peer: String(row['replica_server_name'] ?? 'unknown'),
          state: text(row['synchronization_health_desc']) ?? text(row['connected_state_desc']),
          detail: {
            kind: 'availability_replica',
            group: text(row['group_name']),
            role: text(row['role_desc']),
            availability_mode: text(row['availability_mode_desc']),
            failover_mode: text(row['failover_mode_desc']),
            connected_state: text(row['connected_state_desc']),
          },
        });
      }

      const dbJoin = await client.query(
        `select ag.name as group_name, db_name(drs.database_id) as db,
                drs.is_local, drs.is_primary_replica, drs.synchronization_state_desc,
                drs.synchronization_health_desc,
                drs.secondary_lag_seconds
           from sys.dm_hadr_database_replica_states drs
           join sys.availability_replicas ar on ar.replica_id = drs.replica_id
           join sys.availability_groups ag on ag.group_id = ar.group_id
          where drs.is_local = 1`,
      );
      for (const row of dbJoin) {
        replication.push({
          role: 'availability_group',
          peer: String(row['db'] ?? 'unknown'),
          state: text(row['synchronization_health_desc']) ?? text(row['synchronization_state_desc']),
          lagSeconds: num(row['secondary_lag_seconds']),
          detail: {
            kind: 'availability_database',
            group: text(row['group_name']),
            is_primary_replica: row['is_primary_replica'] === true,
            synchronization_state: text(row['synchronization_state_desc']),
          },
        });
      }

      if (replicas.length === 0) {
        notes.push({
          domain: 'replication',
          level: 'warn',
          message:
            'Always On is enabled but no availability groups exist yet. Create an AG to get replica health and lag here.',
        });
      }
    } catch (error) {
      notes.push({
        domain: 'replication',
        level: 'warn',
        message: `Could not read Always On DMVs: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    notes.push({
      domain: 'replication',
      level: 'info',
      message:
        'Always On Availability Groups are disabled on this instance (IsHadrEnabled=0). Búho still checks database mirroring, log shipping, and transactional replication below.',
    });
  }

  const mirroring = await client.query(
    `select db_name(database_id) as db, mirroring_role_desc, mirroring_state_desc,
            mirroring_partner_name
       from sys.database_mirroring
      where mirroring_guid is not null`,
  );
  for (const row of mirroring) {
    replication.push({
      role: 'standby',
      peer: String(row['mirroring_partner_name'] ?? 'unknown'),
      state: text(row['mirroring_state_desc']),
      detail: {
        kind: 'mirroring',
        database: text(row['db']),
        role: text(row['mirroring_role_desc']),
      },
    });
  }

  try {
    const logShipPrimary = await client.query(
      `select primary_database, monitor_server,
              datediff(second, last_backup_date, sysutcdatetime()) as seconds_since_backup,
              last_backup_file
         from msdb.dbo.log_shipping_primary_databases`,
    );
    for (const row of logShipPrimary) {
      replication.push({
        role: 'primary',
        peer: String(row['primary_database'] ?? ''),
        state: 'log shipping primary',
        lagSeconds: num(row['seconds_since_backup']),
        detail: {
          kind: 'log_shipping_primary',
          monitor_server: text(row['monitor_server']),
          last_backup_file: text(row['last_backup_file']),
        },
      });
    }
    const logShipSecondary = await client.query(
      `select sd.secondary_database, s.primary_server, s.primary_database,
              datediff(second, sd.last_restored_date, sysutcdatetime()) as seconds_since_restore,
              sd.last_restored_file
         from msdb.dbo.log_shipping_secondary_databases sd
         join msdb.dbo.log_shipping_secondary s on s.secondary_id = sd.secondary_id`,
    );
    for (const row of logShipSecondary) {
      replication.push({
        role: 'standby',
        peer: `${row['primary_server'] ?? '?'}/${row['primary_database'] ?? '?'}`,
        state: 'log shipping secondary',
        lagSeconds: num(row['seconds_since_restore']),
        detail: {
          kind: 'log_shipping_secondary',
          secondary_database: text(row['secondary_database']),
          last_restored_file: text(row['last_restored_file']),
        },
      });
    }
  } catch (error) {
    notes.push({
      domain: 'replication',
      level: 'info',
      message:
        `Log shipping catalog not readable: ${error instanceof Error ? error.message : String(error)}. Grant SELECT on msdb.dbo.log_shipping_* to the monitor login.`,
    });
  }

  try {
    const pubs = await client.query(
      `select p.name as publication, p.publication_type, p.status,
              d.name as publisher_db
         from distribution.dbo.MSpublications p
         join distribution.dbo.MSpublisher_databases d on d.publisher_id = p.publisher_id`,
    );
    for (const row of pubs) {
      replication.push({
        role: 'primary',
        peer: String(row['publication'] ?? ''),
        state: `txn replication · status ${row['status'] ?? '?'}`,
        detail: {
          kind: 'transactional_publication',
          publisher_db: text(row['publisher_db']),
          publication_type: text(row['publication_type']),
        },
      });
    }
  } catch {
    // distribution DB is absent on most installs — silence is correct.
  }

  const haRows = replication.filter(
    (row) =>
      (row.detail?.['kind'] !== 'hadr_posture' && row.role === 'availability_group') ||
      row.detail?.['kind'] === 'mirroring' ||
      String(row.detail?.['kind'] ?? '').startsWith('log_shipping') ||
      String(row.detail?.['kind'] ?? '').startsWith('transactional'),
  );
  if (haRows.length === 0 && !hadr) {
    replication.push({
      role: 'primary',
      peer: '',
      state: 'no HA mechanism configured (no AG, mirroring, log shipping, or txn replication)',
      detail: { kind: 'ha_summary', is_hadr_enabled: false },
    });
  }
  snapshot.replication = replication;

  // -------------------------------------------------------------- licencias
  const key = editionKey(edition);
  const limits = EDITION_LIMITS[key];
  const cores = num(sysinfo?.['cpu_count']);
  const memoryBytes = (num(sysinfo?.['physical_memory_kb']) ?? 0) * 1024;

  const licensing: LicensingRow = {
    edition,
    licenseModel: key === 'developer' || key === 'evaluation' ? 'gratuita, sin derecho de producción' : 'por núcleo o por CAL',
    cores,
    coresLimit: limits?.cores ?? null,
    memoryBytes: memoryBytes || null,
    memoryLimitBytes: limits?.memoryGb ? Math.round(limits.memoryGb * 1024 ** 3) : null,
    productionOk: limits?.productionOk ?? null,
    note: limits?.note ?? null,
    detail: {
      engine_edition: num(props?.['engine_edition']),
      sockets: num(sysinfo?.['socket_count']),
      cores_per_socket: num(sysinfo?.['cores_per_socket']),
      hyperthread_ratio: num(sysinfo?.['hyperthread_ratio']),
      virtual_machine: text(sysinfo?.['virtual_machine_type_desc']),
      committed_target_bytes: (num(sysinfo?.['committed_target_kb']) ?? 0) * 1024,
    },
  };
  snapshot.licensing = licensing;

  if (limits && limits.productionOk === false) {
    notes.push({
      domain: 'licensing',
      level: 'error',
      message: `${edition} edition: ${limits.note}`,
    });
  }
  // Núcleos que la edición no puede usar: se están pagando (o enfriando) para
  // nada, y el motor los ignora en silencio.
  if (limits?.cores && cores && cores > limits.cores) {
    notes.push({
      domain: 'licensing',
      level: 'warn',
      message: `Server has ${cores} cores but ${edition} can only use ${limits.cores}. The remaining ${
        cores - limits.cores
      } cores are unused by the engine.`,
    });
  }

  snapshot.notes = notes;
  return snapshot;
}

/**
 * msdb guarda fecha y hora como enteros decimales legibles: 20260831 y 143005
 * para las 14:30:05. No es un timestamp y hay que armarlo a mano.
 */
function msdbDate(rawDate: unknown, rawTime: unknown): Date | null {
  const day = num(rawDate) ?? 0;
  if (day <= 0) return null;
  const time = num(rawTime) ?? 0;
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const dayOfMonth = day % 100;
  const hour = Math.floor(time / 10_000);
  const minute = Math.floor((time % 10_000) / 100);
  const second = time % 100;
  const parsed = new Date(year, month - 1, dayOfMonth, hour, minute, second);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** run_duration viene como HHMMSS decimal, no como segundos. */
function msdbDuration(raw: number | null): number | null {
  if (raw === null) return null;
  const hours = Math.floor(raw / 10_000);
  const minutes = Math.floor((raw % 10_000) / 100);
  const seconds = raw % 100;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}
