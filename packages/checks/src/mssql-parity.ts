import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';
import { CHECKS } from './definitions';

/**
 * 1:1 parity map: every PostgreSQL check id → SQL Server counterpart.
 * F4 gate: `assertMssqlParity()` must pass before calling the product "prod-ready".
 */
export const MSSQL_PARITY_MAP: Record<string, string> = {
  connection_saturation: 'mssql_connection_saturation',
  idle_in_transaction: 'mssql_idle_transactions',
  blocking_chain: 'mssql_blocking',
  xid_wraparound: 'mssql_log_reuse_pressure',
  xid_wraparound_table: 'mssql_tempdb_version_store',
  dead_tuples: 'mssql_forwarded_records',
  redundant_index_prefix: 'mssql_duplicate_indexes',
  unused_indexes: 'mssql_unused_indexes',
  temp_spill: 'mssql_tempdb_spills',
  cache_hit: 'mssql_cache_hit',
  inactive_replication_slot: 'mssql_replication_inactive',
  tables_without_pk: 'mssql_tables_without_pk',
  long_running_queries: 'mssql_long_queries',
  pg_stat_statements_state: 'mssql_query_store_state',
  config_coherence: 'mssql_memory_config',
  frequent_checkpoints: 'mssql_checkpoint_pressure',
  wal_archive_failing: 'mssql_log_backup_chain',
  unsafe_durability: 'mssql_unsafe_durability',
  autovacuum_disabled: 'mssql_auto_stats_disabled',
  stale_statistics: 'mssql_stale_statistics',
  replication_lag: 'mssql_replication_lag',
  missing_timeouts: 'mssql_missing_timeouts',
  weak_password_encryption: 'mssql_weak_password_policy',
};

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown, fallback = '(unknown)'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

export function assertMssqlParity(): void {
  const pgIds = CHECKS.map((check) => check.id);
  const missing = pgIds.filter((id) => !MSSQL_PARITY_MAP[id]);
  if (missing.length > 0) {
    throw new Error(`MSSQL parity map missing PG checks: ${missing.join(', ')}`);
  }
  const extra = Object.keys(MSSQL_PARITY_MAP).filter((id) => !pgIds.includes(id));
  if (extra.length > 0) {
    throw new Error(`MSSQL parity map has unknown PG ids: ${extra.join(', ')}`);
  }
  if (pgIds.length !== Object.keys(MSSQL_PARITY_MAP).length) {
    throw new Error(
      `PG checks (${pgIds.length}) ≠ MSSQL parity entries (${Object.keys(MSSQL_PARITY_MAP).length})`,
    );
  }
}

const connectionSaturation: ForeignCheckDefinition = {
  id: 'mssql_connection_saturation',
  title: 'Connection saturation',
  description: 'User connections versus configured maximum',
  sql: () => `
    select (select cast(value_in_use as int) from sys.configurations where name = 'user connections') as max_configured,
           (select count(*) from sys.dm_exec_sessions where is_user_process = 1) as used,
           (select cpu_count from sys.dm_os_sys_info) as cpu_count`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const used = num(row['used']);
    // 0 = unlimited; use a soft ceiling from CPU count like pool sizing advice.
    let max = num(row['max_configured']);
    if (max <= 0) max = Math.max(100, num(row['cpu_count']) * 50);
    const pct = (used / max) * 100;
    if (pct < 75) return [];
    return [
      {
        severity: pct >= 90 ? 'critical' : 'warning',
        message: `${used} of ~${max} connections in use (${formatPct(pct)}).`,
        remediation:
          'Put a pool in front of the app (or lower client pool sizes). Raising user connections without a pool burns worker threads and memory.',
        value: pct,
      },
    ];
  },
};

const idleTransactions: ForeignCheckDefinition = {
  id: 'mssql_idle_transactions',
  title: 'Idle open transactions',
  description: 'Sleeping sessions that still hold an open transaction',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select s.session_id,
           s.login_name,
           s.host_name,
           s.program_name,
           datediff(second, t.transaction_begin_time, sysdatetime()) as open_seconds
      from sys.dm_tran_session_transactions st
      join sys.dm_tran_active_transactions t on t.transaction_id = st.transaction_id
      join sys.dm_exec_sessions s on s.session_id = st.session_id
      left join sys.dm_exec_requests r on r.session_id = s.session_id
     where s.is_user_process = 1
       and r.session_id is null
       and datediff(second, t.transaction_begin_time, sysdatetime()) >= 300
     order by open_seconds desc`,
  evaluate: (rows) =>
    rows.slice(0, 10).map((row) => {
      const seconds = num(row['open_seconds']);
      return {
        severity: seconds > 3600 ? 'critical' : 'warning',
        object: `session ${text(row['session_id'])} (${text(row['program_name'])})`,
        message: `Open transaction idle for ${formatDuration(seconds)} (login ${text(row['login_name'])}).`,
        remediation:
          'Find the client that left the transaction open. Set a sane remote query / lock timeout and fix the app path that begins a tran without committing.',
        value: seconds,
      } satisfies Finding;
    }),
};

const blocking: ForeignCheckDefinition = {
  id: 'mssql_blocking',
  title: 'Active blocking',
  description: 'Sessions waiting on locks held by others',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select r.session_id,
           r.blocking_session_id,
           r.wait_time / 1000.0 as blocked_seconds,
           left(isnull(t.text, ''), 120) as query_text
      from sys.dm_exec_requests r
      outer apply sys.dm_exec_sql_text(r.sql_handle) t
     where r.blocking_session_id <> 0
     order by r.wait_time desc`,
  evaluate: (rows) =>
    rows.slice(0, 15).map((row) => {
      const seconds = num(row['blocked_seconds']);
      return {
        severity: seconds >= 30 ? 'critical' : 'warning',
        object: `session ${text(row['session_id'])} ← ${text(row['blocking_session_id'])}`,
        message: `Blocked for ${formatDuration(seconds)}: ${text(row['query_text'], '(no text)')}`,
        remediation:
          'Inspect the head blocker (blocking_session_id). Prefer fixing the long write / missing index; kill only after confirming the session is stuck.',
        value: seconds,
      } satisfies Finding;
    }),
};

/** Closest to XID wraparound: log cannot truncate / reuse. */
const logReusePressure: ForeignCheckDefinition = {
  id: 'mssql_log_reuse_pressure',
  title: 'Transaction log reuse blocked',
  description: 'Databases whose log cannot truncate (FULL recovery risk)',
  sql: () => `
    select d.name as db,
           d.recovery_model_desc as modelo,
           d.log_reuse_wait_desc as espera,
           (select sum(size) * 8192.0 from sys.master_files mf
             where mf.database_id = d.database_id and mf.type = 1) as log_bytes
      from sys.databases d
     where d.database_id > 4
       and d.state_desc = 'ONLINE'
       and d.log_reuse_wait_desc not in ('NOTHING', 'CHECKPOINT')`,
  evaluate: (rows) =>
    rows.map((row) => {
      const espera = text(row['espera']);
      const critical = ['ACTIVE_TRANSACTION', 'REPLICATION', 'AVAILABILITY_REPLICA', 'DATABASE_MIRRORING'].includes(
        espera,
      );
      return {
        severity: critical ? 'critical' : 'warning',
        object: text(row['db']),
        message: `log reuse wait = ${espera} (${text(row['modelo'])}, log ${formatBytes(num(row['log_bytes']))}).`,
        remediation:
          espera === 'LOG_BACKUP'
            ? 'Take a transaction log backup now and schedule LOG backups ≤15–60 min for FULL/BULK_LOGGED.'
            : espera === 'ACTIVE_TRANSACTION'
              ? 'Find the oldest open transaction (dbcc opentran / dm_tran_active_transactions) and commit or kill it.'
              : 'Resolve the wait reason in log_reuse_wait_desc; until then the log file will only grow.',
      } satisfies Finding;
    }),
};

const tempdbVersionStore: ForeignCheckDefinition = {
  id: 'mssql_tempdb_version_store',
  title: 'tempdb version store pressure',
  description: 'Long snapshot / RCSI versions filling tempdb (wraparound analog)',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select sum(version_store_reserved_page_count) * 8192.0 as version_bytes,
           sum(user_object_reserved_page_count) * 8192.0 as user_bytes,
           sum(internal_object_reserved_page_count) * 8192.0 as internal_bytes,
           (select sum(size) * 8192.0 from tempdb.sys.database_files) as tempdb_bytes
      from tempdb.sys.dm_db_file_space_usage`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const version = num(row['version_bytes']);
    const tempdb = num(row['tempdb_bytes']);
    if (tempdb <= 0 || version < tempdb * 0.2) return [];
    const pct = (version / tempdb) * 100;
    return [
      {
        severity: pct >= 50 ? 'critical' : 'warning',
        object: 'tempdb',
        message: `version store is ${formatBytes(version)} (${formatPct(pct)} of tempdb).`,
        remediation:
          'Long-running snapshot/RCSI readers or open transactions are pinning versions. Find oldest tran and reduce snapshot duration; grow tempdb files evenly if needed.',
        value: pct,
      },
    ];
  },
};

const forwardedRecords: ForeignCheckDefinition = {
  id: 'mssql_forwarded_records',
  title: 'Heap forwarded records',
  description: 'Heaps with forwarded record fetches (dead-tuple style waste)',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select top 15
           quotename(object_schema_name(s.object_id)) + '.' + quotename(object_name(s.object_id)) as objeto,
           s.forwarded_fetch_count as forwarded,
           s.leaf_insert_count + s.leaf_update_count as writes
      from sys.dm_db_index_operational_stats(db_id(), null, null, null) s
      join sys.indexes i on i.object_id = s.object_id and i.index_id = s.index_id
     where i.type_desc = 'HEAP'
       and s.forwarded_fetch_count > 10000
     order by s.forwarded_fetch_count desc`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['forwarded']) > 1_000_000 ? 'warning' : 'info',
      object: text(row['objeto']),
      message: `${num(row['forwarded']).toLocaleString('en-US')} forwarded record fetches since restart.`,
      remediation:
        'Heaps that update variable-width columns forward rows. Add a clustered index or rebuild the heap (EXPORT/IMPORT) after measuring write patterns.',
      value: num(row['forwarded']),
    })),
};

const duplicateIndexes: ForeignCheckDefinition = {
  id: 'mssql_duplicate_indexes',
  title: 'Duplicate / overlapping indexes',
  description: 'Indexes whose key columns are identical or a left prefix',
  sql: () => `
    ;with keys as (
      select i.object_id, i.index_id, i.name as index_name,
             quotename(schema_name(t.schema_id)) + '.' + quotename(t.name) as tabla,
             stuff((
               select ',' + c.name
                 from sys.index_columns ic
                 join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
                where ic.object_id = i.object_id and ic.index_id = i.index_id and ic.is_included_column = 0
                order by ic.key_ordinal
                  for xml path(''), type
             ).value('.', 'nvarchar(max)'), 1, 1, '') as key_cols
        from sys.indexes i
        join sys.tables t on t.object_id = i.object_id
       where i.type > 0 and i.is_hypothetical = 0 and i.name is not null
    )
    select a.tabla,
           a.index_name as index_a,
           b.index_name as index_b,
           a.key_cols
      from keys a
      join keys b
        on a.object_id = b.object_id
       and a.index_id < b.index_id
       and (a.key_cols = b.key_cols
            or a.key_cols like b.key_cols + ',%'
            or b.key_cols like a.key_cols + ',%')
     where a.key_cols is not null and b.key_cols is not null`,
  evaluate: (rows) =>
    rows.slice(0, 20).map((row) => ({
      severity: 'info' as const,
      object: `${text(row['tabla'])}: ${text(row['index_a'])} ↔ ${text(row['index_b'])}`,
      message: `overlapping keys (${text(row['key_cols'])}).`,
      remediation:
        'Keep the wider useful index and drop the redundant one after confirming query plans. Duplicate keys cost writes and backup space.',
    })),
};

const unusedIndexes: ForeignCheckDefinition = {
  id: 'mssql_unused_indexes',
  title: 'Unused indexes',
  description: 'Nonclustered indexes with writes and no reads since restart',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select quotename(s.name) + '.' + quotename(t.name) + ' / ' + i.name as objeto,
           us.user_updates as escrituras,
           (select datediff(second, sqlserver_start_time, sysdatetime()) from sys.dm_os_sys_info) as uptime
      from sys.dm_db_index_usage_stats us
      join sys.indexes i on i.object_id = us.object_id and i.index_id = us.index_id
      join sys.tables t on t.object_id = i.object_id
      join sys.schemas s on s.schema_id = t.schema_id
     where us.database_id = db_id()
       and i.is_primary_key = 0 and i.is_unique_constraint = 0 and i.type_desc <> 'CLUSTERED'
       and us.user_seeks + us.user_scans + us.user_lookups = 0
       and us.user_updates > 1000`,
  evaluate: (rows) => {
    if (num(rows[0]?.['uptime']) < 86_400) return [];
    return rows.slice(0, 25).map((row) => ({
      severity: 'info' as const,
      object: text(row['objeto']),
      message: `${num(row['escrituras'])} writes and no reads since restart.`,
      remediation:
        'Disable the index first (ALTER INDEX … DISABLE) to confirm nothing breaks at month-end, then drop it.',
      value: num(row['escrituras']),
    }));
  },
};

const tempdbSpills: ForeignCheckDefinition = {
  id: 'mssql_tempdb_spills',
  title: 'Spill to tempdb',
  description: 'Queries warning about sort/hash spills (recent)',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select top 20
           qs.execution_count as executions,
           qs.total_worker_time / 1000.0 as cpu_ms,
           qs.total_elapsed_time / 1000.0 as elapsed_ms,
           left(isnull(st.text, ''), 160) as query_text
      from sys.dm_exec_query_stats qs
      cross apply sys.dm_exec_sql_text(qs.sql_handle) st
     where qs.total_grant_kb > 1024
       and qs.total_used_grant_kb * 1.0 / nullif(qs.total_grant_kb, 0) < 0.05
       and qs.execution_count > 20
       and qs.total_elapsed_time > 5000000
     order by qs.total_elapsed_time desc`,
  evaluate: (rows) =>
    rows.slice(0, 5).map((row) => ({
      severity: 'info' as const,
      object: text(row['query_text']).replace(/\s+/g, ' ').slice(0, 80),
      message: `possible memory grant waste/spill pattern (${num(row['executions'])} execs, ${formatDuration(num(row['elapsed_ms']) / 1000)} total).`,
      remediation:
        'Check actual plans for Sort/Hash Warning. Update statistics, fix cardinality, or raise memory grants carefully — spills thrash tempdb.',
    })),
};

const cacheHit: ForeignCheckDefinition = {
  id: 'mssql_cache_hit',
  title: 'Low buffer cache hit ratio',
  description: 'Buffer manager cache hit below healthy range',
  sql: () => `
    select
      (select cntr_value from sys.dm_os_performance_counters
        where counter_name = 'Buffer cache hit ratio'
          and object_name like '%:Buffer Manager%') as hits,
      (select cntr_value from sys.dm_os_performance_counters
        where counter_name = 'Buffer cache hit ratio base'
          and object_name like '%:Buffer Manager%') as base,
      (select datediff(second, sqlserver_start_time, sysdatetime()) from sys.dm_os_sys_info) as uptime`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row || num(row['uptime']) < 3_600) return [];
    const base = num(row['base']);
    if (base <= 0) return [];
    const pct = (num(row['hits']) / base) * 100;
    if (pct >= 95) return [];
    return [
      {
        severity: pct < 90 ? 'warning' : 'info',
        message: `buffer cache hit ratio is ${formatPct(pct)}.`,
        remediation:
          'Usually memory pressure or scans: raise max server memory only after fixing heavy queries; check PAGEIOLATCH waits.',
        value: pct,
      },
    ];
  },
};

const replicationInactive: ForeignCheckDefinition = {
  id: 'mssql_replication_inactive',
  title: 'Inactive HA / replication topology',
  description: 'Always On / mirroring / log shipping configured but unhealthy',
  sql: () => `
    select kind, nombre, peer, health, connected from (
      select cast(N'ag' as nvarchar(32)) collate database_default as kind,
             cast(ag.name as nvarchar(256)) collate database_default as nombre,
             cast(ar.replica_server_name as nvarchar(256)) collate database_default as peer,
             cast(isnull(rs.synchronization_health_desc, N'UNKNOWN') as nvarchar(64)) collate database_default as health,
             cast(isnull(rs.connected_state_desc, N'DISCONNECTED') as nvarchar(64)) collate database_default as connected
        from sys.availability_groups ag
        join sys.availability_replicas ar on ar.group_id = ag.group_id
        left join sys.dm_hadr_availability_replica_states rs
          on rs.replica_id = ar.replica_id
       where isnull(rs.synchronization_health_desc, N'NOT_HEALTHY') <> N'HEALTHY'
      union all
      select cast(N'mirror' as nvarchar(32)) collate database_default,
             cast(db_name(database_id) as nvarchar(256)) collate database_default,
             cast(mirroring_partner_name as nvarchar(256)) collate database_default,
             cast(mirroring_state_desc as nvarchar(64)) collate database_default,
             cast(mirroring_role_desc as nvarchar(64)) collate database_default
        from sys.database_mirroring
       where mirroring_guid is not null
         and mirroring_state_desc not in (N'SYNCHRONIZED', N'SYNCHRONIZING')
      union all
      select cast(N'logship' as nvarchar(32)) collate database_default,
             cast(primary_database as nvarchar(256)) collate database_default,
             cast(secondary_server + N'.' + secondary_database as nvarchar(256)) collate database_default,
             cast(N'BEHIND' as nvarchar(64)) collate database_default,
             cast(cast(datediff(minute, last_copied_date, getdate()) as nvarchar(20)) + N'm' as nvarchar(64)) collate database_default
        from msdb.dbo.log_shipping_monitor_secondary
       where datediff(minute, last_copied_date, getdate()) > 30
    ) x`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'critical' as const,
      object: `${text(row['kind'])}:${text(row['nombre'])}`,
      message: `peer ${text(row['peer'])} health=${text(row['health'])} connected=${text(row['connected'])}.`,
      remediation:
        'Restore connectivity / resolve AG role issues / catch up log shipping. An inactive HA path is worse than none: you think you are protected.',
    })),
};

const tablesWithoutPk: ForeignCheckDefinition = {
  id: 'mssql_tables_without_pk',
  title: 'Tables without primary key',
  description: 'User tables with no PK (logical replication / ORM pain)',
  sql: () => `
    select top 30
           quotename(schema_name(t.schema_id)) + '.' + quotename(t.name) as tabla,
           sum(p.rows) as filas
      from sys.tables t
      join sys.partitions p on p.object_id = t.object_id and p.index_id in (0, 1)
     where t.is_ms_shipped = 0
       and not exists (
         select 1 from sys.indexes i
          where i.object_id = t.object_id and i.is_primary_key = 1
       )
     group by t.schema_id, t.name
     having sum(p.rows) > 0
     order by sum(p.rows) desc`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['filas']) > 100_000 ? 'warning' : 'info',
      object: text(row['tabla']),
      message: `no primary key (${num(row['filas']).toLocaleString('en-US')} rows).`,
      remediation:
        'Add a primary key (or unique clustered index). Heaps without keys break CDC, merge, and most ORMs.',
      value: num(row['filas']),
    })),
};

const longQueries: ForeignCheckDefinition = {
  id: 'mssql_long_queries',
  title: 'Long-running queries',
  description: 'Active requests older than 5 minutes',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select r.session_id,
           r.total_elapsed_time / 1000.0 as elapsed_s,
           r.status,
           db_name(r.database_id) as database_name,
           left(isnull(t.text, ''), 200) as query_text
      from sys.dm_exec_requests r
      outer apply sys.dm_exec_sql_text(r.sql_handle) t
     where r.session_id <> @@spid
       and r.status in ('running', 'runnable', 'suspended')
       and r.command not in ('AWAITING COMMAND', 'TASK MANAGER', 'XE TIMER', 'XE DISPATCHER')
       and r.total_elapsed_time >= 300000
       and t.text is not null
     order by r.total_elapsed_time desc`,
  evaluate: (rows) =>
    rows.slice(0, 10).map((row) => {
      const elapsed = num(row['elapsed_s']);
      return {
        severity: elapsed >= 900 ? 'critical' : 'warning',
        object: `session ${text(row['session_id'])}`,
        message:
          `running ${formatDuration(elapsed)} on ${text(row['database_name'])} (${text(row['status'])}): ` +
          text(row['query_text'], '(no text)'),
        remediation:
          'Capture the plan (Query Store / SET STATISTICS XML). Check blocking and missing indexes before killing.',
        value: elapsed,
      } satisfies Finding;
    }),
};

const queryStoreState: ForeignCheckDefinition = {
  id: 'mssql_query_store_state',
  title: 'Query Store status',
  description: 'Query Store off or read-only (pg_stat_statements analog)',
  sql: () => `
    select d.name as db,
           d.is_query_store_on as encendido,
           isnull(qs.actual_state_desc, 'OFF') as estado,
           isnull(qs.readonly_reason, 0) as readonly_reason
      from sys.databases d
      left join sys.database_query_store_options qs on 1 = 1
     where d.database_id = db_id()`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    if (num(row['encendido']) === 1 && text(row['estado']) === 'READ_WRITE') return [];
    if (text(row['estado']) === 'READ_ONLY') {
      return [
        {
          severity: 'warning',
          object: text(row['db']),
          message: `Query Store is READ_ONLY (reason ${text(row['readonly_reason'])}).`,
          remediation:
            'Free disk / raise max_storage_size_mb and set OPERATION_MODE = READ_WRITE. Without it you lose plan history.',
        },
      ];
    }
    return [
      {
        severity: 'info',
        object: text(row['db']),
        message: 'Query Store is off for the connected database.',
        remediation:
          "Enable with ALTER DATABASE … SET QUERY_STORE = ON (READ_WRITE). It is SQL Server's pg_stat_statements.",
      },
    ];
  },
};

const memoryConfig: ForeignCheckDefinition = {
  id: 'mssql_memory_config',
  title: 'Incoherent memory configuration',
  description: 'max/min server memory vs physical RAM',
  sql: () => `
    select
      (select cast(value_in_use as bigint) from sys.configurations where name = 'max server memory (MB)') as max_mb,
      (select cast(value_in_use as bigint) from sys.configurations where name = 'min server memory (MB)') as min_mb,
      (select physical_memory_kb / 1024 from sys.dm_os_sys_info) as physical_mb`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const hallazgos: Finding[] = [];
    const maxMb = num(row['max_mb']);
    const minMb = num(row['min_mb']);
    const physical = num(row['physical_mb']);
    if (physical > 0 && maxMb >= 2_147_483_647) {
      hallazgos.push({
        severity: 'critical',
        object: 'max server memory',
        message: `uncapped with ${formatBytes(physical * 1024 * 1024)} RAM.`,
        remediation: `Cap max server memory to ~${Math.max(1024, physical - Math.max(4096, Math.floor(physical * 0.1)))} MB so the OS can breathe.`,
      });
    }
    if (physical > 0 && maxMb > 0 && maxMb < physical * 0.5 && maxMb < 2_147_483_647) {
      hallazgos.push({
        severity: 'warning',
        object: 'max server memory',
        message: `only ${maxMb} MB of ${physical} MB RAM is allowed to the engine.`,
        remediation: 'Raise max server memory if this host is dedicated to SQL Server; otherwise leave headroom for co-located services.',
      });
    }
    if (minMb > 0 && maxMb > 0 && minMb > maxMb * 0.8 && maxMb < 2_147_483_647) {
      hallazgos.push({
        severity: 'warning',
        object: 'min server memory',
        message: `min (${minMb} MB) is very close to max (${maxMb} MB).`,
        remediation: 'Lower min server memory; a high floor prevents the engine from releasing memory under OS pressure.',
      });
    }
    return hallazgos;
  },
};

const checkpointPressure: ForeignCheckDefinition = {
  id: 'mssql_checkpoint_pressure',
  title: 'Checkpoint / lazy writer pressure',
  description: 'Elevated checkpoint or lazy writes (WAL-forced checkpoint analog)',
  sql: () => `
    select
      (select cntr_value from sys.dm_os_performance_counters
        where counter_name = 'Checkpoint pages/sec' and object_name like '%:Buffer Manager%') as checkpoint_pages,
      (select cntr_value from sys.dm_os_performance_counters
        where counter_name = 'Lazy writes/sec' and object_name like '%:Buffer Manager%') as lazy_writes,
      (select cntr_value from sys.dm_os_performance_counters
        where counter_name = 'Page life expectancy' and object_name like '%:Buffer Manager%') as ple,
      (select datediff(second, sqlserver_start_time, sysdatetime()) from sys.dm_os_sys_info) as uptime`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row || num(row['uptime']) < 3_600) return [];
    const hallazgos: Finding[] = [];
    const ple = num(row['ple']);
    // These counters are often cumulative "per sec" type 272696576 — treat high PLE drop as signal.
    if (ple > 0 && ple < 300) {
      hallazgos.push({
        severity: 'warning',
        object: 'page life expectancy',
        message: `PLE is ${ple}s (buffer pool churn).`,
        remediation:
          'Memory pressure or scans. Fix heavy queries and consider more RAM / higher max server memory on dedicated hosts.',
        value: ple,
      });
    }
    return hallazgos;
  },
};

const logBackupChain: ForeignCheckDefinition = {
  id: 'mssql_log_backup_chain',
  title: 'Log backup chain failing',
  description: 'FULL/BULK_LOGGED databases without a recent log backup',
  sql: () => `
    select d.name as db,
           d.recovery_model_desc as modelo,
           (select max(b.backup_finish_date) from msdb.dbo.backupset b
             where b.database_name = d.name and b.type = 'L') as ultimo_log,
           d.log_reuse_wait_desc as espera
      from sys.databases d
     where d.database_id > 4
       and d.state_desc = 'ONLINE'
       and d.recovery_model_desc in ('FULL', 'BULK_LOGGED')`,
  evaluate: (rows) => {
    const ahora = Date.now();
    return rows.flatMap((row): Finding[] => {
      const ultimo = row['ultimo_log'] ? new Date(String(row['ultimo_log'])).getTime() : null;
      if (ultimo === null) {
        return [
          {
            severity: 'critical',
            object: text(row['db']),
            message: 'FULL/BULK_LOGGED without any log backup (PITR chain broken).',
            remediation: 'Schedule transaction log backups. Until then the log will grow and point-in-time restore is impossible.',
          },
        ];
      }
      const hours = (ahora - ultimo) / 3_600_000;
      if (hours <= 24) return [];
      return [
        {
          severity: hours > 72 ? 'critical' : 'warning',
          object: text(row['db']),
          message: `last log backup ${formatDuration(hours * 3600)} ago (wait=${text(row['espera'])}).`,
          remediation: 'Fix the log backup job; this is the SQL Server equivalent of a failing archive_command.',
          value: hours,
        },
      ];
    });
  },
};

const unsafeDurability: ForeignCheckDefinition = {
  id: 'mssql_unsafe_durability',
  title: 'Durability settings at risk',
  description: 'Delayed durability, torn page detection off, autoshrink',
  sql: () => `
    select d.name as db,
           d.delayed_durability_desc as delayed,
           d.page_verify_option_desc as verify,
           d.is_auto_shrink_on as autoshrink,
           d.is_auto_close_on as autoclose
      from sys.databases d
     where d.database_id > 4 and d.state_desc = 'ONLINE'`,
  evaluate: (rows) => {
    const hallazgos: Finding[] = [];
    for (const row of rows) {
      const db = text(row['db']);
      if (text(row['delayed']) === 'FORCED') {
        hallazgos.push({
          severity: 'critical',
          object: db,
          message: 'delayed durability is FORCED: committed transactions may be lost on crash.',
          remediation: 'Set DELAYED_DURABILITY = DISABLED unless you explicitly accept data loss for speed.',
        });
      }
      if (text(row['verify']) === 'NONE' || text(row['verify']) === 'TORN_PAGE_DETECTION') {
        hallazgos.push({
          severity: text(row['verify']) === 'NONE' ? 'warning' : 'info',
          object: db,
          message: `page_verify = ${text(row['verify'])}.`,
          remediation: 'Use CHECKSUM. TORN_PAGE_DETECTION is obsolete; NONE hides corruption until restore fails.',
        });
      }
      if (num(row['autoshrink']) === 1) {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: 'auto_shrink is on (fragmentation + IO storms).',
          remediation: 'ALTER DATABASE … SET AUTO_SHRINK OFF. Shrink only manually and rarely.',
        });
      }
      if (num(row['autoclose']) === 1) {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: 'auto_close is on (cold-start latency on every connect).',
          remediation: 'ALTER DATABASE … SET AUTO_CLOSE OFF.',
        });
      }
    }
    return hallazgos;
  },
};

const autoStatsDisabled: ForeignCheckDefinition = {
  id: 'mssql_auto_stats_disabled',
  title: 'Automatic statistics disabled',
  description: 'Databases with auto create/update stats off (autovacuum analog)',
  sql: () => `
    select name as db,
           is_auto_create_stats_on as auto_create,
           is_auto_update_stats_on as auto_update,
           is_auto_update_stats_async_on as auto_async
      from sys.databases
     where database_id > 4 and state_desc = 'ONLINE'
       and (is_auto_create_stats_on = 0 or is_auto_update_stats_on = 0)`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: text(row['db']),
      message: `auto_create=${num(row['auto_create'])} auto_update=${num(row['auto_update'])}.`,
      remediation:
        'Turn auto create/update statistics back on. Without them the optimizer uses stale density and picks bad plans — the SQL Server cousin of disabling autovacuum.',
    })),
};

const staleStatistics: ForeignCheckDefinition = {
  id: 'mssql_stale_statistics',
  title: 'Stale planner statistics',
  description: 'Statistics not updated in 14+ days on large tables',
  sql: () => `
    select top 25
           quotename(schema_name(o.schema_id)) + '.' + quotename(o.name) + ' / ' + s.name as objeto,
           stats_date(s.object_id, s.stats_id) as last_update,
           datediff(day, stats_date(s.object_id, s.stats_id), getdate()) as days_stale,
           sum(p.rows) as filas
      from sys.stats s
      join sys.objects o on o.object_id = s.object_id
      join sys.partitions p on p.object_id = s.object_id and p.index_id in (0, 1)
     where o.is_ms_shipped = 0
       and stats_date(s.object_id, s.stats_id) < dateadd(day, -14, getdate())
     group by o.schema_id, o.name, s.name, s.object_id, s.stats_id
     having sum(p.rows) > 100000
     order by days_stale desc`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['days_stale']) > 45 ? 'warning' : 'info',
      object: text(row['objeto']),
      message: `statistics ${num(row['days_stale'])} days old (${num(row['filas']).toLocaleString('en-US')} rows).`,
      remediation: 'UPDATE STATISTICS … WITH FULLSCAN (or sample) after large loads; enable auto_update_stats if disabled.',
      value: num(row['days_stale']),
    })),
};

const replicationLag: ForeignCheckDefinition = {
  id: 'mssql_replication_lag',
  title: 'Replication lag',
  description: 'Always On redo/secondary lag above threshold',
  sql: () => `
    select ag.name as ag_name,
           ar.replica_server_name as replica,
           rs.role_desc,
           isnull(drs.secondary_lag_seconds, 0) as lag_seconds,
           isnull(drs.log_send_queue_size, 0) as send_queue_kb,
           isnull(drs.redo_queue_size, 0) as redo_queue_kb
      from sys.dm_hadr_database_replica_states drs
      join sys.availability_replicas ar on ar.replica_id = drs.replica_id
      join sys.availability_groups ag on ag.group_id = ar.group_id
      join sys.dm_hadr_availability_replica_states rs on rs.replica_id = ar.replica_id
     where drs.is_local = 0 or rs.role_desc = 'SECONDARY'`,
  evaluate: (rows) =>
    rows.flatMap((row): Finding[] => {
      const lag = num(row['lag_seconds']);
      if (lag < 30 && num(row['send_queue_kb']) < 1024 * 50) return [];
      return [
        {
          severity: lag >= 300 ? 'critical' : 'warning',
          object: `${text(row['ag_name'])}/${text(row['replica'])}`,
          message: `secondary lag ${formatDuration(lag)} (send_queue=${num(row['send_queue_kb'])} KB, redo_queue=${num(row['redo_queue_kb'])} KB).`,
          remediation:
            'Check network to secondary, disk on redo, and whether secondary is overloaded. Persistent lag means RPO/RTO promises are already broken.',
          value: lag,
        },
      ];
    }),
};

const missingTimeouts: ForeignCheckDefinition = {
  id: 'mssql_missing_timeouts',
  title: 'No per-session time limits',
  description: 'Remote query / lock / user options without guardrails',
  sql: () => `
    select
      (select cast(value_in_use as int) from sys.configurations where name = 'remote query timeout (s)') as remote_query,
      (select cast(value_in_use as int) from sys.configurations where name = 'query wait (s)') as query_wait,
      (select cast(value_in_use as int) from sys.configurations where name = 'user connections') as user_connections`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const hallazgos: Finding[] = [];
    // 0 = infinite wait for remote query timeout
    if (num(row['remote_query']) === 0) {
      hallazgos.push({
        severity: 'warning',
        object: 'remote query timeout',
        message: 'remote query timeout is 0 (infinite).',
        remediation:
          'Set a finite remote query timeout for linked-server workloads so a hung remote call cannot pin workers forever.',
      });
    }
    return hallazgos;
  },
};

const weakPasswordPolicy: ForeignCheckDefinition = {
  id: 'mssql_weak_password_policy',
  title: 'Weak SQL authentication policy',
  description: 'SQL logins without policy / expiration (password encryption analog)',
  sql: () => `
    select name as login_name,
           is_policy_checked,
           is_expiration_checked,
           is_disabled
      from sys.sql_logins
     where is_disabled = 0
       and name not in ('sa')
       and (is_policy_checked = 0 or is_expiration_checked = 0)`,
  evaluate: (rows) =>
    rows.slice(0, 30).map((row) => ({
      severity: 'warning' as const,
      object: text(row['login_name']),
      message: `SQL login policy_checked=${num(row['is_policy_checked'])} expiration_checked=${num(row['is_expiration_checked'])}.`,
      remediation:
        'ALTER LOGIN … WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON (or move to Windows auth). Unchecked SQL logins are the weak-password class of failures.',
    })),
};

/** Exactly one MSSQL check per PostgreSQL check (order follows CHECKS). */
export const MSSQL_PARITY_CHECKS: ForeignCheckDefinition[] = [
  connectionSaturation,
  idleTransactions,
  blocking,
  logReusePressure,
  tempdbVersionStore,
  forwardedRecords,
  duplicateIndexes,
  unusedIndexes,
  tempdbSpills,
  cacheHit,
  replicationInactive,
  tablesWithoutPk,
  longQueries,
  queryStoreState,
  memoryConfig,
  checkpointPressure,
  logBackupChain,
  unsafeDurability,
  autoStatsDisabled,
  staleStatistics,
  replicationLag,
  missingTimeouts,
  weakPasswordPolicy,
];

assertMssqlParity();

if (MSSQL_PARITY_CHECKS.length !== CHECKS.length) {
  throw new Error(
    `MSSQL_PARITY_CHECKS length ${MSSQL_PARITY_CHECKS.length} !== PG CHECKS ${CHECKS.length}`,
  );
}

for (let i = 0; i < CHECKS.length; i++) {
  const expected = MSSQL_PARITY_MAP[CHECKS[i]!.id];
  const actual = MSSQL_PARITY_CHECKS[i]!.id;
  if (expected !== actual) {
    throw new Error(`Parity order mismatch at ${i}: PG ${CHECKS[i]!.id} expected ${expected}, got ${actual}`);
  }
}
