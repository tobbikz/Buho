import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';
import { CHECKS } from './definitions';

/**
 * 1:1 parity map: every PostgreSQL check id → MariaDB/MySQL counterpart.
 * Gate: `assertMariadbParity()` must pass before calling the product "prod-ready".
 */
export const MARIADB_PARITY_MAP: Record<string, string> = {
  connection_saturation: 'mariadb_connection_saturation',
  idle_in_transaction: 'mariadb_idle_transactions',
  blocking_chain: 'mariadb_blocking',
  xid_wraparound: 'mariadb_history_list',
  xid_wraparound_table: 'mariadb_undo_pressure',
  dead_tuples: 'mariadb_table_bloat',
  redundant_index_prefix: 'mariadb_duplicate_indexes',
  unused_indexes: 'mariadb_unused_indexes',
  temp_spill: 'mariadb_temp_disk_tables',
  cache_hit: 'mariadb_cache_hit',
  inactive_replication_slot: 'mariadb_replication_inactive',
  tables_without_pk: 'mariadb_tables_without_pk',
  long_running_queries: 'mariadb_long_queries',
  pg_stat_statements_state: 'mariadb_perf_schema_state',
  config_coherence: 'mariadb_memory_config',
  frequent_checkpoints: 'mariadb_checkpoint_pressure',
  wal_archive_failing: 'mariadb_binlog_health',
  unsafe_durability: 'mariadb_unsafe_durability',
  autovacuum_disabled: 'mariadb_stats_auto_disabled',
  stale_statistics: 'mariadb_stale_statistics',
  replication_lag: 'mariadb_replication_lag',
  missing_timeouts: 'mariadb_missing_timeouts',
  weak_password_encryption: 'mariadb_weak_password_hash',
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

export function assertMariadbParity(): void {
  const pgIds = CHECKS.map((check) => check.id);
  const missing = pgIds.filter((id) => !MARIADB_PARITY_MAP[id]);
  if (missing.length > 0) {
    throw new Error(`MariaDB parity map missing PG checks: ${missing.join(', ')}`);
  }
  const extra = Object.keys(MARIADB_PARITY_MAP).filter((id) => !pgIds.includes(id));
  if (extra.length > 0) {
    throw new Error(`MariaDB parity map has unknown PG ids: ${extra.join(', ')}`);
  }
  if (pgIds.length !== Object.keys(MARIADB_PARITY_MAP).length) {
    throw new Error(
      `PG checks (${pgIds.length}) ≠ MariaDB parity entries (${Object.keys(MARIADB_PARITY_MAP).length})`,
    );
  }
}

const connectionSaturation: ForeignCheckDefinition = {
  id: 'mariadb_connection_saturation',
  title: 'Connection saturation',
  description: 'Threads connected versus max_connections',
  sql: () => `
    select
      (select cast(@@global.max_connections as unsigned)) as max_connections,
      (select cast(variable_value as unsigned)
         from information_schema.global_status
        where variable_name = 'THREADS_CONNECTED') as used`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const max = num(row['max_connections']);
    const used = num(row['used']);
    if (max <= 0) return [];
    const pct = (used / max) * 100;
    if (pct < 75) return [];
    return [
      {
        severity: pct >= 90 ? 'critical' : 'warning',
        message: `${used} of ${max} connections in use (${formatPct(pct)}).`,
        remediation:
          'Put a pool in front of the app before raising max_connections: each session reserves sort/join buffers.',
        value: pct,
      },
    ];
  },
};

const idleTransactions: ForeignCheckDefinition = {
  id: 'mariadb_idle_transactions',
  title: 'Idle open transactions',
  description: 'Long-open InnoDB transactions that hold locks and undo',
  appliesTo: (caps) => caps.features.lockWaits,
  sql: () => `
    select trx_id, trx_mysql_thread_id as hilo, trx_state as estado,
           timestampdiff(second, trx_started, now()) as segundos,
           trx_rows_locked as filas_bloqueadas,
           left(coalesce(trx_query, ''), 200) as consulta
      from information_schema.innodb_trx
     where trx_started < now() - interval 5 minute
     order by trx_started
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['segundos']);
      const consulta = text(row['consulta'], '');
      return {
        severity: seconds > 3600 ? 'critical' : 'warning',
        object: `thread ${text(row['hilo'])}`,
        message:
          `transaction open for ${formatDuration(seconds)} (${text(row['estado'])}), ` +
          `${num(row['filas_bloqueadas'])} row(s) locked` +
          (consulta ? `: ${consulta}` : ' with no active query'),
        remediation:
          'Idle open transactions block purge and other sessions. Fix the app pool (BEGIN without COMMIT) before KILL.',
        value: seconds,
      } satisfies Finding;
    }),
};

const blocking: ForeignCheckDefinition = {
  id: 'mariadb_blocking',
  title: 'Active blocking',
  description: 'InnoDB lock waits (who blocks whom)',
  appliesTo: (caps) => caps.features.lockWaits,
  sql: () => `
    select esperando.trx_mysql_thread_id as blocked_thread,
           bloqueando.trx_mysql_thread_id as blocking_thread,
           timestampdiff(second, esperando.trx_wait_started, now()) as wait_seconds,
           left(coalesce(esperando.trx_query, ''), 120) as blocked_query,
           left(coalesce(bloqueando.trx_query, ''), 120) as blocking_query
      from information_schema.innodb_lock_waits w
      join information_schema.innodb_trx esperando
        on esperando.trx_id = w.requesting_trx_id
      left join information_schema.innodb_trx bloqueando
        on bloqueando.trx_id = w.blocking_trx_id
     order by esperando.trx_wait_started
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['wait_seconds']);
      return {
        severity: seconds > 60 ? 'critical' : 'warning',
        object: `thread ${text(row['blocked_thread'])} ← ${text(row['blocking_thread'])}`,
        message: `blocked for ${formatDuration(seconds)}: ${text(row['blocked_query'], '(no query)')}`,
        remediation:
          'Kill or commit the blocker if it is idle. Lower innodb_lock_wait_timeout so apps get retryable errors.',
        value: seconds,
      };
    }),
};

const historyList: ForeignCheckDefinition = {
  id: 'mariadb_history_list',
  title: 'History list length pressure',
  description: 'InnoDB purge lag (history list) — XID wraparound analog',
  sql: () => `
    select cast(variable_value as unsigned) as history_len
      from information_schema.global_status
     where variable_name = 'INNODB_HISTORY_LIST_LENGTH'`,
  evaluate: (rows) => {
    const len = num(rows[0]?.['history_len']);
    if (len < 100_000) return [];
    return [
      {
        severity: len > 1_000_000 ? 'critical' : 'warning',
        message: `InnoDB history list length is ${len.toLocaleString('en-US')}.`,
        remediation:
          'Long open transactions or a slow purge thread. Find old trx in information_schema.innodb_trx; raise innodb_purge_threads if CPU allows.',
        value: len,
      },
    ];
  },
};

const undoPressure: ForeignCheckDefinition = {
  id: 'mariadb_undo_pressure',
  title: 'Undo / purge table pressure',
  description: 'Largest tables under reclaimable free space (purge lag proxy)',
  sql: () => `
    select table_schema as db, table_name as tabla,
           data_length + index_length as bytes,
           data_free as libre
      from information_schema.tables
     where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and table_type = 'BASE TABLE'
       and data_free > 268435456
       and data_free > (data_length + index_length) * 0.3
     order by data_free desc
     limit 15`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['libre']) > 5_368_709_120 ? 'warning' : 'info',
      object: `${text(row['db'])}.${text(row['tabla'])}`,
      message: `${formatBytes(num(row['libre']))} free inside table file (${formatBytes(num(row['bytes']))} used).`,
      remediation:
        'OPTIMIZE TABLE or ALTER TABLE … FORCE (ALGORITHM=INPLACE, LOCK=NONE when supported) after confirming purge is not lagging.',
      value: num(row['libre']),
    })),
};

const tableBloat: ForeignCheckDefinition = {
  id: 'mariadb_table_bloat',
  title: 'Table bloat (data_free)',
  description: 'Tables with large reclaimable data_free — dead tuples analog',
  sql: () => `
    select table_schema as db, table_name as tabla,
           data_length + index_length as bytes,
           data_free as libre
      from information_schema.tables
     where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and table_type = 'BASE TABLE'
       and data_free > 1073741824
       and data_free > (data_length + index_length) * 0.2
     order by data_free desc
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const libre = num(row['libre']);
      const total = num(row['bytes']);
      const pct = total > 0 ? (libre / total) * 100 : 0;
      return {
        severity: libre > 10_737_418_240 ? 'warning' : 'info',
        object: `${text(row['db'])}.${text(row['tabla'])}`,
        message: `${formatBytes(libre)} reclaimable (${formatPct(pct)} of table size).`,
        remediation:
          'Rebuild with OPTIMIZE TABLE or ALTER TABLE … FORCE. Prefer online ALGORITHM=INPLACE when available.',
        value: libre,
      };
    }),
};

const duplicateIndexes: ForeignCheckDefinition = {
  id: 'mariadb_duplicate_indexes',
  title: 'Duplicate / redundant indexes',
  description: 'Indexes that are left-prefixes of another index on the same table',
  sql: () => `
    select a.table_schema as db, a.table_name as tabla,
           a.index_name as redundant_index, b.index_name as covering_index,
           a.cols as redundant_cols, b.cols as covering_cols
      from (
        select table_schema, table_name, index_name,
               group_concat(column_name order by seq_in_index separator ',') as cols,
               count(*) as n
          from information_schema.statistics
         where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
           and index_name <> 'PRIMARY'
         group by table_schema, table_name, index_name
      ) a
      join (
        select table_schema, table_name, index_name,
               group_concat(column_name order by seq_in_index separator ',') as cols,
               count(*) as n
          from information_schema.statistics
         where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
         group by table_schema, table_name, index_name
      ) b
        on a.table_schema = b.table_schema and a.table_name = b.table_name
       and a.index_name <> b.index_name
       and b.cols like concat(a.cols, ',%')
     limit 30`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['db'])}.${text(row['tabla'])}.${text(row['redundant_index'])}`,
      message: `redundant left-prefix of ${text(row['covering_index'])} (${text(row['redundant_cols'])}).`,
      remediation: `DROP INDEX \`${text(row['redundant_index'])}\` ON \`${text(row['db'])}\`.\`${text(row['tabla'])}\`; keep the wider covering index.`,
    })),
};

const unusedIndexes: ForeignCheckDefinition = {
  id: 'mariadb_unused_indexes',
  title: 'Unused indexes',
  description: 'Secondary indexes with zero reads in performance_schema',
  appliesTo: (caps) => caps.features.statementDigests,
  sql: () => `
    select object_schema as db, object_name as tabla, index_name,
           count_read as lecturas, count_write as escrituras
      from performance_schema.table_io_waits_summary_by_index_usage
     where object_schema not in ('mysql', 'performance_schema', 'information_schema', 'sys')
       and index_name is not null
       and index_name <> 'PRIMARY'
       and count_star > 0
       and count_read = 0
       and count_write > 100
     order by count_write desc
     limit 25`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['db'])}.${text(row['tabla'])}.${text(row['index_name'])}`,
      message: `${num(row['escrituras'])} writes and 0 reads since restart (performance_schema).`,
      remediation:
        'Confirm with a full business cycle, then DROP INDEX. Unused indexes slow every write.',
      value: num(row['escrituras']),
    })),
};

const tempDiskTables: ForeignCheckDefinition = {
  id: 'mariadb_temp_disk_tables',
  title: 'Temp tables spilling to disk',
  description: 'High ratio of Created_tmp_disk_tables — temp_spill analog',
  sql: () => `
    select
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'CREATED_TMP_TABLES') as tmp,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'CREATED_TMP_DISK_TABLES') as tmp_disk,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'UPTIME') as uptime`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row || num(row['uptime']) < 3600) return [];
    const tmp = num(row['tmp']);
    const disk = num(row['tmp_disk']);
    if (tmp < 1000) return [];
    const pct = (disk / tmp) * 100;
    if (pct < 25) return [];
    return [
      {
        severity: pct > 50 ? 'warning' : 'info',
        message: `${formatPct(pct)} of temp tables go to disk (${disk} of ${tmp}).`,
        remediation:
          'Raise tmp_table_size and max_heap_table_size together. TEXT/BLOB in GROUP BY always spills regardless of size.',
        value: pct,
      },
    ];
  },
};

const cacheHit: ForeignCheckDefinition = {
  id: 'mariadb_cache_hit',
  title: 'Low InnoDB buffer pool hit rate',
  description: 'Buffer pool read requests versus disk reads',
  sql: () => `
    select
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'INNODB_BUFFER_POOL_READ_REQUESTS') as requests,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'INNODB_BUFFER_POOL_READS') as disk_reads,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'UPTIME') as uptime,
      (select cast(@@global.innodb_buffer_pool_size as unsigned)) as pool_bytes`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row || num(row['uptime']) < 3600) return [];
    const requests = num(row['requests']);
    const disk = num(row['disk_reads']);
    if (requests < 1_000_000) return [];
    const pct = ((requests - disk) / requests) * 100;
    if (pct >= 99) return [];
    return [
      {
        severity: pct < 95 ? 'critical' : 'warning',
        message: `buffer pool hit rate ${formatPct(pct)} with pool ${formatBytes(num(row['pool_bytes']))}.`,
        remediation:
          'Raise innodb_buffer_pool_size toward 60–75% of RAM on a dedicated host (hot-resize on MariaDB 10.2+).',
        value: pct,
      },
    ];
  },
};

const replicationInactive: ForeignCheckDefinition = {
  id: 'mariadb_replication_inactive',
  title: 'Inactive replication',
  description: 'Replica IO/SQL threads stopped (slot inactive analog)',
  appliesTo: (caps) => caps.role === 'replica',
  sql: () => 'show replica status',
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const campo = (nombre: string): unknown => row[nombre] ?? row[nombre.toLowerCase()];
    const io =
      String(campo('Slave_IO_Running') ?? campo('Replica_IO_Running') ?? '').toLowerCase() === 'yes';
    const sql =
      String(campo('Slave_SQL_Running') ?? campo('Replica_SQL_Running') ?? '').toLowerCase() === 'yes';
    if (io && sql) return [];
    const errno = num(campo('Last_Errno') ?? campo('Last_SQL_Errno'));
    return [
      {
        severity: 'critical' as const,
        object: !io ? 'IO thread' : 'SQL thread',
        message:
          `${!io ? 'IO' : 'SQL'} thread is stopped` +
          (errno > 0 ? `: error ${errno} — ${text(campo('Last_Error') ?? campo('Last_SQL_Error'), 'no details')}` : '.'),
        remediation: 'Fix the error and START REPLICA. An inactive replica is worse than none: you think you have HA.',
      },
    ];
  },
};

const tablesWithoutPk: ForeignCheckDefinition = {
  id: 'mariadb_tables_without_pk',
  title: 'Tables without primary key',
  description: 'InnoDB tables without a PK (row-based replication pain)',
  sql: () => `
    select t.table_schema as db, t.table_name as tabla,
           t.data_length + t.index_length as bytes, t.table_rows as filas
      from information_schema.tables t
     where t.table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and t.table_type = 'BASE TABLE'
       and not exists (
         select 1 from information_schema.statistics st
          where st.table_schema = t.table_schema
            and st.table_name = t.table_name
            and st.index_name = 'PRIMARY')
     order by t.data_length + t.index_length desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['bytes']) > 1_073_741_824 ? 'warning' : 'info',
      object: `${text(row['db'])}.${text(row['tabla'])}`,
      message: `no primary key, ${formatBytes(num(row['bytes']))} and ~${num(row['filas'])} rows.`,
      remediation:
        'Add a primary key. With binlog_format=ROW the replica otherwise scans the full table per changed row.',
      value: num(row['bytes']),
    })),
};

const longQueries: ForeignCheckDefinition = {
  id: 'mariadb_long_queries',
  title: 'Long-running queries',
  description: 'Processlist queries older than 5 minutes',
  sql: () => `
    select id, user, host, db, time as segundos, state,
           left(coalesce(info, ''), 160) as consulta
      from information_schema.processlist
     where command not in ('Sleep', 'Binlog Dump', 'Binlog Dump GTID', 'Daemon')
       and info is not null
       and time > 300
     order by time desc
     limit 15`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['segundos']);
      return {
        severity: seconds > 3600 ? 'critical' : 'warning',
        object: `id ${text(row['id'])} (${text(row['user'])})`,
        message: `running for ${formatDuration(seconds)}: ${text(row['consulta'])}`,
        remediation: 'Kill if stuck; otherwise add indexes / break the batch. Set max_statement_time as a safety net.',
        value: seconds,
      };
    }),
};

const perfSchemaState: ForeignCheckDefinition = {
  id: 'mariadb_perf_schema_state',
  title: 'Performance schema / statement consumers',
  description: 'Observability equivalent of pg_stat_statements',
  sql: () => `
    select
      (select @@global.performance_schema) as perf_on,
      (select count(*) from performance_schema.setup_consumers
        where name like 'events_statements%' and enabled = 'YES') as stmt_consumers
    from dual`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const on = num(row['perf_on']);
    if (on === 0) {
      return [
        {
          severity: 'warning' as const,
          message: 'performance_schema is OFF: no statement analytics.',
          remediation: 'Set performance_schema=ON in my.cnf and restart (~5% CPU typical).',
        },
      ];
    }
    if (num(row['stmt_consumers']) === 0) {
      return [
        {
          severity: 'warning' as const,
          message: 'performance_schema is on but no events_statements* consumers are enabled.',
          remediation:
            "UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME LIKE 'events_statements%';",
        },
      ];
    }
    return [];
  },
};

const memoryConfig: ForeignCheckDefinition = {
  id: 'mariadb_memory_config',
  title: 'Memory / buffer pool coherence',
  description: 'Buffer pool sizing relative to pressure — config_coherence analog',
  sql: () => `
    select
      cast(@@global.innodb_buffer_pool_size as unsigned) as pool_bytes,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'INNODB_BUFFER_POOL_WAIT_FREE') as wait_free,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'INNODB_BUFFER_POOL_PAGES_TOTAL') as pages_total,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'INNODB_BUFFER_POOL_PAGES_FREE') as pages_free`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];
    const waitFree = num(row['wait_free']);
    if (waitFree > 100) {
      findings.push({
        severity: 'warning',
        object: 'innodb_buffer_pool_wait_free',
        message: `${waitFree} waits for a free buffer pool page.`,
        remediation: 'Raise innodb_io_capacity / innodb_buffer_pool_size; the dirty-page flush cannot keep up.',
        value: waitFree,
      });
    }
    const total = num(row['pages_total']);
    const free = num(row['pages_free']);
    if (total > 0 && free / total > 0.5 && num(row['pool_bytes']) > 1_073_741_824) {
      findings.push({
        severity: 'info',
        object: 'innodb_buffer_pool_size',
        message: `buffer pool ${formatBytes(num(row['pool_bytes']))} is >50% free — oversized for this workload.`,
        remediation: 'Shrink only if RAM is scarce elsewhere; otherwise leave headroom for growth.',
      });
    }
    return findings;
  },
};

const checkpointPressure: ForeignCheckDefinition = {
  id: 'mariadb_checkpoint_pressure',
  title: 'Checkpoint / redo log pressure',
  description: 'InnoDB log waits — frequent_checkpoints analog',
  sql: () => `
    select
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'INNODB_LOG_WAITS') as log_waits,
      (select cast(variable_value as unsigned) from information_schema.global_status
        where variable_name = 'UPTIME') as uptime,
      cast(@@global.innodb_log_file_size as unsigned) as log_file_size`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row || num(row['uptime']) < 3600) return [];
    const waits = num(row['log_waits']);
    if (waits === 0) return [];
    return [
      {
        severity: waits > 10 ? 'warning' : 'info',
        message: `${waits} InnoDB log wait(s) since startup (log file ${formatBytes(num(row['log_file_size']))}).`,
        remediation:
          'Raise innodb_log_file_size (restart) or innodb_log_buffer_size. Log waits mean redo could not keep up with writes.',
        value: waits,
      },
    ];
  },
};

const binlogHealth: ForeignCheckDefinition = {
  id: 'mariadb_binlog_health',
  title: 'Binlog / archive health',
  description: 'Binlog off or never expires — wal_archive_failing analog',
  sql: () => `
    select
      @@global.log_bin as log_bin,
      @@global.expire_logs_days as expire_days,
      @@global.binlog_expire_logs_seconds as expire_seconds`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];
    const logBin = text(row['log_bin'], '0');
    const on = logBin === '1' || logBin.toUpperCase() === 'ON';
    if (!on) {
      findings.push({
        severity: 'warning',
        object: 'log_bin',
        message: 'binlog is off: no PITR and no replica can be added cleanly.',
        remediation: 'Enable log_bin in my.cnf (requires restart).',
      });
      return findings;
    }
    const days = num(row['expire_days']);
    const seconds = num(row['expire_seconds']);
    if (days === 0 && seconds === 0) {
      findings.push({
        severity: 'warning',
        object: 'expire_logs',
        message: 'binlog never expires (expire_logs_days=0 and binlog_expire_logs_seconds=0): disk will fill.',
        remediation: 'Set binlog_expire_logs_seconds (e.g. 604800 for 7 days) or expire_logs_days.',
      });
    }
    return findings;
  },
};

const unsafeDurability: ForeignCheckDefinition = {
  id: 'mariadb_unsafe_durability',
  title: 'Unsafe durability settings',
  description: 'innodb_flush_log_at_trx_commit / sync_binlog not crash-safe',
  sql: () => `
    select @@global.innodb_flush_log_at_trx_commit as flush,
           @@global.sync_binlog as sync_binlog,
           @@global.log_bin as log_bin`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];
    if (text(row['flush']) !== '1') {
      findings.push({
        severity: 'critical',
        object: 'innodb_flush_log_at_trx_commit',
        message: `innodb_flush_log_at_trx_commit = ${text(row['flush'])}: up to ~1s of commits can be lost on crash.`,
        remediation: 'SET GLOBAL innodb_flush_log_at_trx_commit=1 (and persist in my.cnf).',
      });
    }
    const logBin = text(row['log_bin'], '0');
    const on = logBin === '1' || logBin.toUpperCase() === 'ON';
    if (on && text(row['sync_binlog']) !== '1') {
      findings.push({
        severity: 'warning',
        object: 'sync_binlog',
        message: `sync_binlog = ${text(row['sync_binlog'])} with binlog on: crash can desync replica.`,
        remediation: 'SET GLOBAL sync_binlog=1.',
      });
    }
    return findings;
  },
};

const statsAutoDisabled: ForeignCheckDefinition = {
  id: 'mariadb_stats_auto_disabled',
  title: 'Automatic statistics disabled',
  description: 'innodb_stats_auto_recalc off — autovacuum_disabled analog',
  sql: () => `select @@global.innodb_stats_auto_recalc as auto_recalc`,
  evaluate: (rows) => {
    const val = text(rows[0]?.['auto_recalc'], '1');
    if (val === '1' || val.toUpperCase() === 'ON') return [];
    return [
      {
        severity: 'warning' as const,
        object: 'innodb_stats_auto_recalc',
        message: 'innodb_stats_auto_recalc is off: optimizer stats go stale until ANALYZE TABLE.',
        remediation: 'SET GLOBAL innodb_stats_auto_recalc=ON, or schedule ANALYZE TABLE on hot tables.',
      },
    ];
  },
};

const staleStatistics: ForeignCheckDefinition = {
  id: 'mariadb_stale_statistics',
  title: 'Stale InnoDB table statistics',
  description: 'mysql.innodb_table_stats last_update older than 30 days',
  sql: () => `
    select database_name as db, table_name as tabla,
           last_update, timestampdiff(day, last_update, now()) as days_stale
      from mysql.innodb_table_stats
     where last_update < now() - interval 30 day
       and database_name not in ('mysql', 'sys', 'performance_schema', 'information_schema')
     order by last_update
     limit 25`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['days_stale']) > 90 ? 'warning' : 'info',
      object: `${text(row['db'])}.${text(row['tabla'])}`,
      message: `InnoDB stats last updated ${num(row['days_stale'])} days ago.`,
      remediation: `ANALYZE TABLE \`${text(row['db'])}\`.\`${text(row['tabla'])}\`;`,
      value: num(row['days_stale']),
    })),
};

const replicationLag: ForeignCheckDefinition = {
  id: 'mariadb_replication_lag',
  title: 'Replication lag',
  description: 'Seconds behind primary on a replica',
  appliesTo: (caps) => caps.role === 'replica',
  sql: () => 'show replica status',
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const campo = (nombre: string): unknown => row[nombre] ?? row[nombre.toLowerCase()];
    const lag = campo('Seconds_Behind_Master') ?? campo('Seconds_Behind_Source');
    if (lag === null || lag === undefined) {
      return [
        {
          severity: 'warning' as const,
          object: 'Seconds_Behind_Master',
          message: 'lag reports NULL: replica cannot measure how far behind it is.',
          remediation: 'Often transient after START REPLICA; if persistent, check connectivity to the primary.',
        },
      ];
    }
    const seconds = num(lag);
    if (seconds <= 60) return [];
    return [
      {
        severity: seconds > 600 ? 'critical' : 'warning',
        message: `replica is ${formatDuration(seconds)} behind the primary.`,
        remediation:
          'Raise parallel replica workers / fix tables without PK. Large single-threaded apply is the usual cause.',
        value: seconds,
      },
    ];
  },
};

const missingTimeouts: ForeignCheckDefinition = {
  id: 'mariadb_missing_timeouts',
  title: 'Missing or weak timeouts',
  description: 'wait_timeout / max_statement_time / lock wait defaults',
  sql: () => `
    select @@global.wait_timeout as wait_timeout,
           @@global.interactive_timeout as interactive_timeout,
           @@global.max_statement_time as max_statement_time,
           @@global.innodb_lock_wait_timeout as lock_wait`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];
    const stmt = num(row['max_statement_time']);
    if (stmt === 0) {
      findings.push({
        severity: 'warning',
        object: 'max_statement_time',
        message: 'max_statement_time = 0: a bad query can run forever.',
        remediation: 'Set a generous ceiling (e.g. 300s) globally; raise per session for batch jobs.',
      });
    }
    const wait = num(row['wait_timeout']);
    if (wait >= 28800) {
      findings.push({
        severity: 'info',
        object: 'wait_timeout',
        message: `wait_timeout = ${wait}s (8h+): abandoned sessions hold resources for a full workday.`,
        remediation: 'Lower wait_timeout (e.g. 600–3600) and rely on the application pool.',
      });
    }
    const lockWait = num(row['lock_wait']);
    if (lockWait >= 300) {
      findings.push({
        severity: 'info',
        object: 'innodb_lock_wait_timeout',
        message: `innodb_lock_wait_timeout = ${lockWait}s: blocked sessions hang for minutes.`,
        remediation: 'Lower to 10–50s so the app gets a retryable error.',
      });
    }
    return findings;
  },
};

const weakPasswordHash: ForeignCheckDefinition = {
  id: 'mariadb_weak_password_hash',
  title: 'Weak password hashing',
  description: 'Accounts still on mysql_old_password (or unexpected weak plugins)',
  sql: () => `
    select user as cuenta, host as origen, plugin as plugin
      from mysql.user
     where plugin in ('mysql_native_password', 'mysql_old_password')
       and user <> ''
       and user not in (
         'mariadb.sys', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'healthcheck'
       )
     order by user, host
     limit 30`,
  evaluate: (rows) =>
    rows.flatMap((row) => {
      const user = text(row['cuenta'] ?? row['User'] ?? row['user']);
      const host = text(row['origen'] ?? row['Host'] ?? row['host']);
      const plugin = text(row['plugin'] ?? row['Plugin']);
      // mysql_native_password is still MariaDB's portable default for Node mysql2
      // collectors (ed25519 / Maria caching_sha2 break that client). Only the
      // ancient mysql_old_password plugin is a real lab/prod finding.
      if (plugin === 'mysql_native_password') return [];
      return [
        {
          severity: 'warning' as const,
          object: `${user}@${host}`,
          message: `auth plugin ${plugin} (migrate off mysql_old_password).`,
          remediation:
            "ALTER USER … IDENTIFIED VIA mysql_native_password USING PASSWORD('…'); then flush privileges. Prefer ed25519 for interactive SQL clients that support it.",
        },
      ];
    }),
};

/** Exactly one MariaDB check per PostgreSQL check (order follows CHECKS). */
export const MARIADB_PARITY_CHECKS: ForeignCheckDefinition[] = [
  connectionSaturation,
  idleTransactions,
  blocking,
  historyList,
  undoPressure,
  tableBloat,
  duplicateIndexes,
  unusedIndexes,
  tempDiskTables,
  cacheHit,
  replicationInactive,
  tablesWithoutPk,
  longQueries,
  perfSchemaState,
  memoryConfig,
  checkpointPressure,
  binlogHealth,
  unsafeDurability,
  statsAutoDisabled,
  staleStatistics,
  replicationLag,
  missingTimeouts,
  weakPasswordHash,
];

assertMariadbParity();

if (MARIADB_PARITY_CHECKS.length !== CHECKS.length) {
  throw new Error(
    `MARIADB_PARITY_CHECKS length ${MARIADB_PARITY_CHECKS.length} !== PG CHECKS ${CHECKS.length}`,
  );
}

for (let i = 0; i < CHECKS.length; i++) {
  const expected = MARIADB_PARITY_MAP[CHECKS[i]!.id];
  const actual = MARIADB_PARITY_CHECKS[i]!.id;
  if (expected !== actual) {
    throw new Error(
      `MariaDB parity order mismatch at ${i}: PG ${CHECKS[i]!.id} expected ${expected}, got ${actual}`,
    );
  }
}
