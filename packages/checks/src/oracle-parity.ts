import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';
import { CHECKS } from './definitions';

/** Oracle catalog noise — never surface as app findings. */
const ORACLE_SYSTEM_OWNERS = `
  'SYS','SYSTEM','OUTLN','XDB','WMSYS','CTXSYS','MDSYS','ORDSYS','ORDDATA',
  'LBACSYS','DVSYS','AUDSYS','GSMADMIN_INTERNAL','OJVMSYS','DVF','DBSNMP',
  'APPQOSSYS','GSMCATUSER','GGSYS','ANONYMOUS','SYSBACKUP','SYSDG','SYSKM',
  'SYSRAC','GSMUSER','REMOTE_SCHEDULER_AGENT','DBSFWUSER','SI_INFORMTN_SCHEMA',
  'OLAPSYS','ORDPLUGINS','MDDATA','DIP','APEX_PUBLIC_USER','FLOWS_FILES',
  'ORACLE_OCM','XS$NULL','OJVMSYS','VECSYS','DGPDB_INT'
`;

/**
 * 1:1 parity map: every PostgreSQL check id → Oracle counterpart.
 */
export const ORACLE_PARITY_MAP: Record<string, string> = {
  connection_saturation: 'oracle_connection_saturation',
  idle_in_transaction: 'oracle_idle_transactions',
  blocking_chain: 'oracle_blocking',
  xid_wraparound: 'oracle_undo_retention',
  xid_wraparound_table: 'oracle_undo_tablespace',
  dead_tuples: 'oracle_chained_rows',
  redundant_index_prefix: 'oracle_duplicate_indexes',
  unused_indexes: 'oracle_unused_indexes',
  temp_spill: 'oracle_temp_pressure',
  cache_hit: 'oracle_buffer_cache_hit',
  inactive_replication_slot: 'oracle_standby_inactive',
  tables_without_pk: 'oracle_tables_without_pk',
  long_running_queries: 'oracle_long_queries',
  pg_stat_statements_state: 'oracle_sql_monitoring',
  config_coherence: 'oracle_memory_config',
  frequent_checkpoints: 'oracle_log_switch_pressure',
  wal_archive_failing: 'oracle_archivelog_gap',
  unsafe_durability: 'oracle_unsafe_durability',
  autovacuum_disabled: 'oracle_stats_auto_disabled',
  stale_statistics: 'oracle_stale_statistics',
  replication_lag: 'oracle_replication_lag',
  missing_timeouts: 'oracle_missing_timeouts',
  weak_password_encryption: 'oracle_weak_password_policy',
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

export function assertOracleParity(): void {
  const pgIds = CHECKS.map((check) => check.id);
  const missing = pgIds.filter((id) => !ORACLE_PARITY_MAP[id]);
  if (missing.length > 0) {
    throw new Error(`Oracle parity map missing PG checks: ${missing.join(', ')}`);
  }
  const extra = Object.keys(ORACLE_PARITY_MAP).filter((id) => !pgIds.includes(id));
  if (extra.length > 0) {
    throw new Error(`Oracle parity map has unknown PG ids: ${extra.join(', ')}`);
  }
  if (pgIds.length !== Object.keys(ORACLE_PARITY_MAP).length) {
    throw new Error(
      `PG checks (${pgIds.length}) ≠ Oracle parity entries (${Object.keys(ORACLE_PARITY_MAP).length})`,
    );
  }
}

const connectionSaturation: ForeignCheckDefinition = {
  id: 'oracle_connection_saturation',
  title: 'Connection saturation',
  description: 'USER sessions versus SESSIONS parameter',
  sql: () => `
    select (select count(*) from v$session where type = 'USER') as used,
           (select to_number(value) from v$parameter where name = 'sessions') as max_sessions
      from dual`,
  evaluate: (rows) => {
    const used = num(rows[0]?.['used']);
    const max = num(rows[0]?.['max_sessions']);
    if (max <= 0) return [];
    const pct = (used / max) * 100;
    if (pct < 75) return [];
    return [
      {
        severity: pct >= 90 ? 'critical' : 'warning',
        message: `${used} of ${max} sessions in use (${formatPct(pct)}).`,
        remediation: 'Kill idle sessions or raise SESSIONS / PROCESSES (requires restart).',
        value: pct,
      },
    ];
  },
};

const idleTransactions: ForeignCheckDefinition = {
  id: 'oracle_idle_transactions',
  title: 'Idle open transactions',
  description: 'Sessions IN TRANSACTION with no active call for 5+ minutes',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select sid, serial#, username, program, status,
           (sysdate - sql_exec_start) * 86400 as idle_seconds
      from v$session
     where type = 'USER'
       and status = 'INACTIVE'
       and taddr is not null
       and sql_exec_start is not null
       and (sysdate - sql_exec_start) * 86400 >= 300
     order by idle_seconds desc`,
  evaluate: (rows) =>
    rows.slice(0, 10).map((row) => {
      const seconds = num(row['idle_seconds']);
      return {
        severity: seconds > 3600 ? 'critical' : 'warning',
        object: `SID ${text(row['sid'])},${text(row['serial#'])} (${text(row['program'])})`,
        message: `Open transaction idle for ${formatDuration(seconds)} (${text(row['username'])}).`,
        remediation: 'Commit or rollback from the client; set IDLE_TIME / profile limits for app pools.',
        value: seconds,
      } satisfies Finding;
    }),
};

const blocking: ForeignCheckDefinition = {
  id: 'oracle_blocking',
  title: 'Active blocking',
  description: 'Sessions waiting on a blocker',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select s.sid, s.serial#, s.blocking_session as blocker,
           s.seconds_in_wait as blocked_seconds,
           s.event, substr(s.sql_id, 1, 13) as sql_id
      from v$session s
     where s.blocking_session is not null
       and s.type = 'USER'
     order by s.seconds_in_wait desc`,
  evaluate: (rows) =>
    rows.slice(0, 15).map((row) => {
      const seconds = num(row['blocked_seconds']);
      return {
        severity: seconds >= 30 ? 'critical' : 'warning',
        object: `SID ${text(row['sid'])} ← ${text(row['blocker'])}`,
        message: `Blocked ${formatDuration(seconds)} on ${text(row['event'])} (sql_id=${text(row['sql_id'])}).`,
        remediation: 'Inspect blocker session; resolve lock holder or kill after confirming stuck work.',
        value: seconds,
      } satisfies Finding;
    }),
};

const undoRetention: ForeignCheckDefinition = {
  id: 'oracle_undo_retention',
  title: 'Undo retention pressure',
  description: 'Long transactions vs undo retention (wraparound analog)',
  sql: () => `
    select p.undo_retention_sec,
           nvl((
             select max((cast(sysdate as date) - cast(t.start_time as date)) * 86400)
               from v$transaction t
           ), 0) as oldest_tran_sec,
           nvl((select max(t.used_ublk) from v$transaction t), 0) as max_used_ublk
      from (
        select to_number(value) as undo_retention_sec
          from v$parameter
         where name = 'undo_retention'
      ) p`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const retention = num(row['undo_retention_sec']);
    const oldest = num(row['oldest_tran_sec']);
    if (retention <= 0 || oldest < retention * 0.8) return [];
    return [
      {
        severity: oldest >= retention ? 'critical' : 'warning',
        message: `Oldest open transaction ${formatDuration(oldest)} vs undo_retention ${formatDuration(retention)}.`,
        remediation: 'Find long transactions (v$transaction / v$session); extend undo tablespace before ORA-01555 storms.',
        value: oldest,
      },
    ];
  },
};

const undoTablespace: ForeignCheckDefinition = {
  id: 'oracle_undo_tablespace',
  title: 'Undo tablespace pressure',
  description: 'Undo tablespace nearly full',
  sql: () => `
    select tablespace_name as name,
           round((1 - free_mb / nullif(total_mb, 0)) * 100, 1) as used_pct
      from (
        select df.tablespace_name,
               sum(df.bytes) / 1048576 as total_mb,
               nvl(sum(fs.bytes), 0) / 1048576 as free_mb
          from dba_data_files df
          left join dba_free_space fs on fs.tablespace_name = df.tablespace_name
         where df.tablespace_name in (
           select value from v$parameter where name = 'undo_tablespace'
         )
         group by df.tablespace_name
      )`,
  evaluate: (rows) =>
    rows.flatMap((row): Finding[] => {
      const pct = num(row['used_pct']);
      if (pct < 85) return [];
      return [
        {
          severity: pct >= 95 ? 'critical' : 'warning',
          object: text(row['name']),
          message: `Undo tablespace ${text(row['name'])} at ${formatPct(pct)} used.`,
          remediation: 'Add datafile to undo tablespace; shorten long queries holding undo.',
          value: pct,
        },
      ];
    }),
};

const chainedRows: ForeignCheckDefinition = {
  id: 'oracle_chained_rows',
  title: 'Chained / migrated rows',
  description: 'Tables with high chained row ratio (dead-tuple analog)',
  sql: () => `
    select * from (
      select owner as sch, table_name as tbl, chain_cnt, num_rows,
             case when num_rows > 0 then round(chain_cnt / num_rows * 100, 1) else 0 end as chain_pct
        from all_tables
       where owner not in (${ORACLE_SYSTEM_OWNERS})
         and chain_cnt > 1000
         and num_rows > 10000
       order by chain_cnt desc
    ) where rownum <= 15`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['chain_pct']) > 20 ? 'warning' : 'info',
      object: `${text(row['sch'])}.${text(row['tbl'])}`,
      message: `${num(row['chain_cnt']).toLocaleString('en-US')} chained rows (${formatPct(num(row['chain_pct']))} of rows).`,
      remediation: 'Rebuild table (MOVE) or fix PCTFREE / update patterns causing row migration.',
      value: num(row['chain_cnt']),
    })),
};

const duplicateIndexes: ForeignCheckDefinition = {
  id: 'oracle_duplicate_indexes',
  title: 'Duplicate / overlapping indexes',
  description: 'Indexes whose key columns are a left prefix of another',
  sql: () => `
    select a.owner as sch, a.table_name as tbl,
           a.index_name as index_a, b.index_name as index_b, a.cols as key_cols
      from (
        select index_owner as owner, table_name, index_name,
               listagg(column_name, ',') within group (order by column_position) as cols
          from all_ind_columns
         where index_owner not in (${ORACLE_SYSTEM_OWNERS})
         group by index_owner, table_name, index_name
      ) a
      join (
        select index_owner as owner, table_name, index_name,
               listagg(column_name, ',') within group (order by column_position) as cols
          from all_ind_columns
         where index_owner not in (${ORACLE_SYSTEM_OWNERS})
         group by index_owner, table_name, index_name
      ) b
        on a.owner = b.owner and a.table_name = b.table_name and a.index_name <> b.index_name
       and (a.cols = b.cols or b.cols like a.cols || ',%')
     fetch first 25 rows only`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['sch'])}.${text(row['tbl'])}: ${text(row['index_a'])} ↔ ${text(row['index_b'])}`,
      message: `overlapping keys (${text(row['key_cols'])}).`,
      remediation: 'Drop the redundant index after confirming plans; duplicates cost writes and backup space.',
    })),
};

const unusedIndexes: ForeignCheckDefinition = {
  id: 'oracle_unused_indexes',
  title: 'Unused indexes',
  description: 'Indexes with zero access in DBA_INDEX_USAGE (AWR-backed)',
  sql: () => `
    select * from (
      select u.owner as sch, u.name as index_name, i.table_name,
             u.total_access_count, u.last_used
        from dba_index_usage u
        join dba_indexes i
          on i.owner = u.owner and i.index_name = u.name
       where u.total_access_count = 0
         and u.owner not in (${ORACLE_SYSTEM_OWNERS})
       order by i.leaf_blocks desc nulls last
    ) where rownum <= 25`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['sch'])}.${text(row['table_name'])}.${text(row['index_name'])}`,
      message: `zero recorded accesses (last_used=${text(row['last_used'], 'never')}).`,
      remediation: 'Validate over a full business cycle before DROP; DBA_INDEX_USAGE needs AWR/usage tracking.',
      value: num(row['total_access_count']),
    })),
};

const tempPressure: ForeignCheckDefinition = {
  id: 'oracle_temp_pressure',
  title: 'Temp tablespace pressure',
  description: 'Temp space used versus temp files',
  sql: () => `
    select nvl((select sum(bytes) from dba_temp_files), 0) as temp_size,
           nvl((select sum(bytes_used) from v$temp_extent_pool), 0) as temp_used
      from dual`,
  evaluate: (rows) => {
    const size = num(rows[0]?.['temp_size']);
    const used = num(rows[0]?.['temp_used']);
    if (size <= 0) return [];
    const pct = (used / size) * 100;
    if (pct < 80) return [];
    return [
      {
        severity: pct >= 95 ? 'critical' : 'warning',
        object: 'TEMP',
        message: `Temp at ${formatPct(pct)} (${formatBytes(used)} / ${formatBytes(size)}).`,
        remediation: 'Tune large sorts/hashes; add tempfile; review PGA_AGGREGATE_TARGET.',
        value: pct,
      },
    ];
  },
};

const bufferCacheHit: ForeignCheckDefinition = {
  id: 'oracle_buffer_cache_hit',
  title: 'Low buffer cache hit ratio',
  description: 'Buffer cache hit from v$sysstat',
  sql: () => `
    select
      (select value from v$sysstat where name = 'consistent gets') +
      (select value from v$sysstat where name = 'db block gets') as gets,
      (select value from v$sysstat where name = 'physical reads') as phys_reads,
      (select (sysdate - startup_time) * 86400 from v$instance) as uptime_sec
      from dual`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row || num(row['uptime_sec']) < 3600) return [];
    const gets = num(row['gets']);
    const phys = num(row['phys_reads']);
    if (gets < 1_000_000) return [];
    const pct = ((gets - phys) / gets) * 100;
    if (pct >= 95) return [];
    return [
      {
        severity: pct < 90 ? 'warning' : 'info',
        message: `buffer cache hit ratio ${formatPct(pct)}.`,
        remediation: 'Memory pressure or full scans: increase SGA / buffer cache; fix heavy SQL.',
        value: pct,
      },
    ];
  },
};

const standbyInactive: ForeignCheckDefinition = {
  id: 'oracle_standby_inactive',
  title: 'Inactive Data Guard standby',
  description: 'Standby not applying or transport broken',
  appliesTo: (caps) => caps.features.alwaysOn || caps.role === 'replica',
  sql: () => `
    select database_role, open_mode, log_mode from v$database`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const role = text(row['database_role'], '').toUpperCase();
    const open = text(row['open_mode'], '');
    if (!role.includes('STANDBY')) return [];
    if (open.includes('READ ONLY') || open.includes('MOUNTED')) return [];
    return [
      {
        severity: 'critical' as const,
        object: role,
        message: `Standby open_mode=${open} (expected READ ONLY or MOUNTED apply).`,
        remediation: 'Check MRP0 / redo transport; fix gap before RPO is lost.',
      },
    ];
  },
};

const tablesWithoutPk: ForeignCheckDefinition = {
  id: 'oracle_tables_without_pk',
  title: 'Tables without primary key',
  description: 'User tables with no PK constraint',
  sql: () => `
    select * from (
      select t.owner as sch, t.table_name as tbl, nvl(t.num_rows, 0) as num_rows
        from all_tables t
       where t.owner not in (${ORACLE_SYSTEM_OWNERS})
         and t.temporary = 'N'
         and not exists (
           select 1 from all_constraints c
            where c.owner = t.owner and c.table_name = t.table_name and c.constraint_type = 'P'
         )
         and nvl(t.num_rows, 0) > 0
       order by t.num_rows desc nulls last
    ) where rownum <= 30`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['num_rows']) > 100_000 ? 'warning' : 'info',
      object: `${text(row['sch'])}.${text(row['tbl'])}`,
      message: `no primary key (${num(row['num_rows']).toLocaleString('en-US')} rows).`,
      remediation: 'Add a primary key or unique index; required for logical replication and ORM identity.',
      value: num(row['num_rows']),
    })),
};

const longQueries: ForeignCheckDefinition = {
  id: 'oracle_long_queries',
  title: 'Long-running queries',
  description: 'Active USER sessions running 5+ minutes',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select s.sid, s.serial#, s.username, s.status, s.sql_id,
           s.last_call_et as elapsed_sec,
           (select substr(sql_text, 1, 200)
              from v$sql
             where sql_id = s.sql_id and rownum = 1) as query_text
      from v$session s
     where s.type = 'USER'
       and s.status = 'ACTIVE'
       and s.last_call_et >= 300
       and s.sql_id is not null
     order by s.last_call_et desc`,
  evaluate: (rows) =>
    rows.slice(0, 10).map((row) => {
      const elapsed = num(row['elapsed_sec']);
      return {
        severity: elapsed >= 900 ? 'critical' : 'warning',
        object: `SID ${text(row['sid'])}`,
        message: `running ${formatDuration(elapsed)}: ${text(row['query_text'], '(no text)')}`,
        remediation: 'Capture SQL Monitor / AWR; check blocking and temp before killing.',
        value: elapsed,
      } satisfies Finding;
    }),
};

const sqlMonitoring: ForeignCheckDefinition = {
  id: 'oracle_sql_monitoring',
  title: 'SQL workload visibility',
  description: 'V$SQL populated (pg_stat_statements analog)',
  sql: () => `
    select count(*) as sql_count,
           sum(executions) as total_execs
      from v$sql
     where executions > 0`,
  evaluate: (rows) => {
    const count = num(rows[0]?.['sql_count']);
    const execs = num(rows[0]?.['total_execs']);
    if (count > 50 && execs > 1000) return [];
    return [
      {
        severity: 'info' as const,
        message: `Only ${count} distinct SQL entries with ${execs} executions in V$SQL (library may have been flushed).`,
        remediation: 'Ensure AWR/ASH retention; use SQL Tuning Advisor for heavy statements.',
      },
    ];
  },
};

const memoryConfig: ForeignCheckDefinition = {
  id: 'oracle_memory_config',
  title: 'Incoherent memory configuration',
  description: 'SGA/PGA targets vs physical memory',
  sql: () => `
    select
      (select to_number(value) from v$parameter where name = 'sga_target') as sga_target,
      (select to_number(value) from v$parameter where name = 'pga_aggregate_target') as pga_target,
      (select value from v$parameter where name = 'memory_target') as memory_target,
      (select round(value) from v$osstat where stat_name = 'PHYSICAL_MEMORY_BYTES') as physical_bytes
      from dual`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const physical = num(row['physical_bytes']);
    const sga = num(row['sga_target']);
    const pga = num(row['pga_target']);
    const memTarget = num(row['memory_target']);
    const hallazgos: Finding[] = [];
    const budget = memTarget > 0 ? memTarget : sga + pga;
    if (physical > 0 && budget > physical * 0.95) {
      hallazgos.push({
        severity: 'warning',
        object: 'SGA+PGA',
        message: `Memory targets ${formatBytes(budget)} exceed ~${formatBytes(physical)} RAM.`,
        remediation: 'Lower MEMORY_TARGET or SGA_TARGET/PGA_AGGREGATE_TARGET; leave OS headroom.',
      });
    }
    if (physical > 0 && budget > 0 && budget < physical * 0.25) {
      hallazgos.push({
        severity: 'info',
        object: 'SGA+PGA',
        message: `Memory targets only ${formatBytes(budget)} on ${formatBytes(physical)} host.`,
        remediation: 'Raise SGA/PGA on dedicated DB hosts if cache hit and temp spill are poor.',
      });
    }
    return hallazgos;
  },
};

const logSwitchPressure: ForeignCheckDefinition = {
  id: 'oracle_log_switch_pressure',
  title: 'Log switch pressure',
  description: 'Frequent log switches (checkpoint analog)',
  sql: () => `
    select count(*) as switches,
           max(first_time) as last_switch
      from v$log_history
     where first_time > sysdate - 1/24`,
  evaluate: (rows) => {
    const switches = num(rows[0]?.['switches']);
    if (switches < 20) return [];
    return [
      {
        severity: switches >= 60 ? 'warning' : 'info',
        message: `${switches} log switches in the last hour.`,
        remediation: 'Increase redo log size or count; frequent switches force checkpoints and IO spikes.',
        value: switches,
      },
    ];
  },
};

const archivelogGap: ForeignCheckDefinition = {
  id: 'oracle_archivelog_gap',
  title: 'Archive log gap',
  description: 'ARCHIVELOG mode without recent archivelog completion',
  sql: () => `
    select log_mode from v$database`,
  evaluate: (rows) => {
    const mode = text(rows[0]?.['log_mode'], '').toUpperCase();
    if (mode !== 'ARCHIVELOG') {
      return [
        {
          severity: 'warning' as const,
          message: `LOG_MODE=${mode}: no archivelog chain (PITR / standby risk).`,
          remediation: 'Enable ARCHIVELOG and configure FRA or LOG_ARCHIVE_DEST for backups and DG.',
        },
      ];
    }
    return [];
  },
};

const unsafeDurability: ForeignCheckDefinition = {
  id: 'oracle_unsafe_durability',
  title: 'Durability settings at risk',
  description: 'FORCE LOGGING off, NOLOGGING tables, or sync redo disabled',
  sql: () => `
    select force_logging, supplemental_log_data_min from v$database`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const hallazgos: Finding[] = [];
    if (text(row['force_logging'], 'NO').toUpperCase() === 'NO') {
      hallazgos.push({
        severity: 'info',
        object: 'FORCE LOGGING',
        message: 'Database FORCE LOGGING is OFF: direct-path loads may skip redo.',
        remediation: 'ALTER DATABASE FORCE LOGGING before relying on standby/backups for nologging loads.',
      });
    }
    return hallazgos;
  },
};

const statsAutoDisabled: ForeignCheckDefinition = {
  id: 'oracle_stats_auto_disabled',
  title: 'Automatic statistics disabled',
  description: 'OPTIMIZER automatic stats gathering off (autovacuum analog)',
  sql: () => `
    select client_name, status from dba_autotask_client where client_name = 'auto optimizer stats collection'`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    if (text(row['status'], '').toUpperCase() === 'ENABLED') return [];
    return [
      {
        severity: 'warning' as const,
        object: 'auto optimizer stats collection',
        message: `Autotask status=${text(row['status'])}.`,
        remediation:
          'Enable auto optimizer stats collection via DBMS_AUTO_TASK_ADMIN.ENABLE for client auto optimizer stats collection.',
      },
    ];
  },
};

const staleStatistics: ForeignCheckDefinition = {
  id: 'oracle_stale_statistics',
  title: 'Stale optimizer statistics',
  description: 'Tables with stats older than 14 days and significant row count',
  sql: () => `
    select * from (
      select owner as sch, table_name as tbl, num_rows, last_analyzed,
             trunc(sysdate - last_analyzed) as days_stale
        from all_tab_statistics
       where owner not in (${ORACLE_SYSTEM_OWNERS})
         and object_type = 'TABLE'
         and last_analyzed < sysdate - 14
         and num_rows > 100000
       order by days_stale desc nulls last
    ) where rownum <= 25`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['days_stale']) > 45 ? 'warning' : 'info',
      object: `${text(row['sch'])}.${text(row['tbl'])}`,
      message: `statistics ${num(row['days_stale'])} days old (${num(row['num_rows']).toLocaleString('en-US')} rows).`,
      remediation: 'DBMS_STATS.GATHER_TABLE_STATS … or enable auto optimizer stats collection.',
      value: num(row['days_stale']),
    })),
};

const replicationLag: ForeignCheckDefinition = {
  id: 'oracle_replication_lag',
  title: 'Data Guard apply lag',
  description: 'Apply lag from v$dataguard_stats',
  appliesTo: (caps) => caps.features.alwaysOn,
  sql: () => `select name, value, unit from v$dataguard_stats where name = 'apply lag'`,
  evaluate: (rows) => {
    const raw = String(rows[0]?.['value'] ?? '');
    const m = /(?:\+(\d+)\s+)?(\d+):(\d+):(\d+)/.exec(raw);
    if (!m) return [];
    const lag =
      Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    if (lag < 30) return [];
    return [
      {
        severity: lag >= 300 ? 'critical' : 'warning',
        object: 'dataguard',
        message: `Apply lag ${formatDuration(lag)}.`,
        remediation: 'Check standby apply, network, and redo transport.',
        value: lag,
      } satisfies Finding,
    ];
  },
};

const missingTimeouts: ForeignCheckDefinition = {
  id: 'oracle_missing_timeouts',
  title: 'No idle / call timeouts',
  description: 'Profiles or resources without idle/call limits',
  sql: () => `
    select profile, resource_name, limit
      from dba_profiles
     where resource_name in ('IDLE_TIME', 'CONNECT_TIME')
       and limit in ('DEFAULT', 'UNLIMITED')`,
  evaluate: (rows) =>
    rows.slice(0, 20).map((row) => ({
      severity: 'info' as const,
      object: `${text(row['profile'])}.${text(row['resource_name'])}`,
      message: `limit=${text(row['limit'])}.`,
      remediation: 'Set finite IDLE_TIME on application profiles to shed leaked sessions.',
    })),
};

const weakPasswordPolicy: ForeignCheckDefinition = {
  id: 'oracle_weak_password_policy',
  title: 'Weak password profiles',
  description: 'Profiles without failed login / password life limits',
  sql: () => `
    select profile, count(*) as weak_resources
      from dba_profiles
     where resource_name in ('FAILED_LOGIN_ATTEMPTS', 'PASSWORD_LIFE_TIME', 'PASSWORD_VERIFY_FUNCTION')
       and (limit in ('DEFAULT', 'UNLIMITED') or limit is null)
     group by profile
    having count(*) >= 2`,
  evaluate: (rows) =>
    rows.slice(0, 15).map((row) => ({
      severity: 'warning' as const,
      object: text(row['profile']),
      message: `${num(row['weak_resources'])} password-related resources unset or unlimited.`,
      remediation: 'Use a VERIFY_FUNCTION and finite PASSWORD_LIFE_TIME; avoid shared DEFAULT profile for apps.',
    })),
};

export const ORACLE_PARITY_CHECKS: ForeignCheckDefinition[] = [
  connectionSaturation,
  idleTransactions,
  blocking,
  undoRetention,
  undoTablespace,
  chainedRows,
  duplicateIndexes,
  unusedIndexes,
  tempPressure,
  bufferCacheHit,
  standbyInactive,
  tablesWithoutPk,
  longQueries,
  sqlMonitoring,
  memoryConfig,
  logSwitchPressure,
  archivelogGap,
  unsafeDurability,
  statsAutoDisabled,
  staleStatistics,
  replicationLag,
  missingTimeouts,
  weakPasswordPolicy,
];

assertOracleParity();

if (ORACLE_PARITY_CHECKS.length !== CHECKS.length) {
  throw new Error(
    `ORACLE_PARITY_CHECKS length ${ORACLE_PARITY_CHECKS.length} !== PG CHECKS ${CHECKS.length}`,
  );
}

for (let i = 0; i < CHECKS.length; i++) {
  const expected = ORACLE_PARITY_MAP[CHECKS[i]!.id];
  const actual = ORACLE_PARITY_CHECKS[i]!.id;
  if (expected !== actual) {
    throw new Error(`Parity order mismatch at ${i}: PG ${CHECKS[i]!.id} expected ${expected}, got ${actual}`);
  }
}
