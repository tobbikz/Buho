import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { CheckDefinition, Finding } from './types';

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

const connectionSaturation: CheckDefinition = {
  id: 'connection_saturation',
  title: 'Connection saturation',
  description: 'Sessions in use versus max_connections',
  sql: () => `
    select current_setting('max_connections')::int as max_connections,
           count(*)                                as total
      from pg_stat_activity
     where backend_type = 'client backend'`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const max = num(row['max_connections']);
    const total = num(row['total']);
    if (max <= 0) return [];
    const pct = (total / max) * 100;
    if (pct < 75) return [];
    return [
      {
        severity: pct >= 90 ? 'critical' : 'warning',
        message: `${total} of ${max} connections in use (${formatPct(pct)}).`,
        remediation:
          'Put a pool (PgBouncer) in front of the application instead of raising max_connections: each connection reserves work_mem and backend memory.',
        value: pct,
      },
    ];
  },
};

const idleInTransaction: CheckDefinition = {
  id: 'idle_in_transaction',
  title: 'Idle open transactions',
  description: 'Idle in transaction sessions that hold XIDs and block vacuum',
  sql: () => `
    select pid, coalesce(usename, '(no user)') as usename,
           coalesce(application_name, '(unnamed)') as application_name,
           extract(epoch from (now() - state_change)) as idle_seconds
      from pg_stat_activity
     where state like 'idle in transaction%'
       and state_change < now() - interval '5 minutes'
     order by state_change
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['idle_seconds']);
      return {
        severity: seconds > 3600 ? 'critical' : 'warning',
        object: `pid ${text(row['pid'])} (${text(row['application_name'])})`,
        message: `Transaction idle for ${formatDuration(seconds)}.`,
        remediation:
          'Review the application that leaves the transaction open and set idle_in_transaction_session_timeout as a safety net: it holds XIDs, prevents autovacuum from cleaning up, and causes bloat.',
        value: seconds,
      } satisfies Finding;
    }),
};

const blockingChain: CheckDefinition = {
  id: 'blocking_chain',
  title: 'Active blocking',
  description: 'Blocked sessions and what is blocking them',
  sql: () => `
    select pid, pg_blocking_pids(pid) as blocked_by,
           extract(epoch from (now() - query_start)) as blocked_seconds,
           left(coalesce(query, ''), 120) as query
      from pg_stat_activity
     where cardinality(pg_blocking_pids(pid)) > 0
     order by query_start
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['blocked_seconds']);
      const blockedBy = Array.isArray(row['blocked_by']) ? (row['blocked_by'] as unknown[]).join(', ') : '?';
      return {
        severity: seconds > 30 ? 'critical' : 'warning',
        object: `pid ${text(row['pid'])}`,
        message: `Blocked for ${formatDuration(seconds)} by pid ${blockedBy}. Query: ${text(row['query'], '(hidden)')}`,
        remediation:
          'Identify the blocking session with pg_blocking_pids and decide whether to terminate it (pg_terminate_backend). If it repeats, review table access order in the transaction.',
        value: seconds,
      } satisfies Finding;
    }),
};

const xidWraparound: CheckDefinition = {
  id: 'xid_wraparound',
  title: 'XID wraparound risk',
  description: 'XID age versus autovacuum_freeze_max_age',
  sql: () => `
    select datname,
           age(datfrozenxid) as xid_age,
           current_setting('autovacuum_freeze_max_age')::bigint as freeze_max_age
      from pg_database
     where datallowconn
     order by age(datfrozenxid) desc`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const age = num(row['xid_age']);
      const max = num(row['freeze_max_age']);
      if (max <= 0) continue;
      const pct = (age / max) * 100;
      if (pct < 50) continue;
      findings.push({
        severity: pct >= 80 ? 'critical' : 'warning',
        object: text(row['datname']),
        message: `XIDs are at ${formatPct(pct)} of autovacuum_freeze_max_age (age ${Math.round(age).toLocaleString('en-US')}).`,
        remediation:
          'Let autovacuum freeze or run VACUUM (FREEZE) on the oldest tables. If this keeps rising without dropping, something is holding XIDs: an open transaction, an inactive replication slot, or an orphaned prepared transaction.',
        value: pct,
      });
    }
    return findings;
  },
};

/**
 * Wraparound de la tabla, no de la base.
 *
 * `age(datfrozenxid)` avisa de que la base se acerca al límite, pero no dice
 * qué congelar. Y la respuesta rara vez es "todo": lo normal es que una o dos
 * tablas arrastren a las demás, porque tienen autovacuum apagado, porque nunca
 * se escriben y nadie las visita, o porque son tan grandes que el vacuum de
 * congelamiento no termina antes de que llegue el siguiente.
 *
 * Los multixact se miran aparte porque llegan al límite por su cuenta: los
 * generan las claves foráneas y los `SELECT FOR SHARE`, no las escrituras, así
 * que una tabla puede estar tranquila de XID y apretada de mxid.
 */
const xidWraparoundTable: CheckDefinition = {
  id: 'xid_wraparound_table',
  title: 'Tables pushing wraparound',
  description: 'relfrozenxid and relminmxid age per table, against its effective freeze_max_age',
  sql: () => `
    select n.nspname as schema_name,
           c.relname,
           case when c.relfrozenxid = '0'::xid then 0 else age(c.relfrozenxid) end as xid_age,
           case when c.relminmxid = '0'::xid then 0 else mxid_age(c.relminmxid) end as mxid_age,
           coalesce(
             (select option_value::numeric from pg_options_to_table(c.reloptions)
               where option_name = 'autovacuum_freeze_max_age'),
             current_setting('autovacuum_freeze_max_age')::numeric
           ) as freeze_max_age,
           coalesce(
             (select option_value::numeric from pg_options_to_table(c.reloptions)
               where option_name = 'autovacuum_multixact_freeze_max_age'),
             current_setting('autovacuum_multixact_freeze_max_age')::numeric
           ) as multixact_freeze_max_age,
           coalesce(
             (select option_value from pg_options_to_table(c.reloptions)
               where option_name = 'autovacuum_enabled'),
             'true'
           ) as autovacuum_enabled,
           pg_size_pretty(pg_total_relation_size(c.oid)) as size_pretty
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     -- Sin 'p': la tabla particionada no guarda filas, su relfrozenxid es 0 y
     -- el wraparound se mide en cada partición por separado.
     where c.relkind in ('r', 'm', 't')
       and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
     order by xid_age desc
     limit 20`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const object = `${text(row['schema_name'])}.${text(row['relname'])}`;
      const size = text(row['size_pretty']);
      const apagado = text(row['autovacuum_enabled']) === 'false';

      const xidAge = num(row['xid_age']);
      const xidMax = num(row['freeze_max_age']);
      const xidPct = xidMax > 0 ? (xidAge / xidMax) * 100 : 0;

      const mxidAge = num(row['mxid_age']);
      const mxidMax = num(row['multixact_freeze_max_age']);
      const mxidPct = mxidMax > 0 && mxidAge > 0 ? (mxidAge / mxidMax) * 100 : 0;

      // Debajo del 60 % la tabla está donde autovacuum quiere que esté: el
      // congelamiento es un ciclo normal, no un problema, y avisar antes sería
      // enseñar a ignorar la pantalla.
      const peor = Math.max(xidPct, mxidPct);
      if (peor < 60 && !(apagado && peor >= 40)) continue;

      const cual = mxidPct > xidPct ? 'multixact' : 'transactions';
      const edad = mxidPct > xidPct ? mxidAge : xidAge;
      findings.push({
        severity: peor >= 90 ? 'critical' : peor >= 75 ? 'warning' : 'info',
        object,
        message:
          `${cual} age is at ${formatPct(peor)} of the limit that forces vacuum ` +
          `(${Math.round(edad).toLocaleString('en-US')} of ${Math.round(mxidPct > xidPct ? mxidMax : xidMax).toLocaleString('en-US')}), ` +
          `table size ${size}${apagado ? ', with autovacuum disabled' : ''}.`,
        remediation: apagado
          ? 'This table has autovacuum disabled and keeps aging: the freeze vacuum will still arrive, forced and at the worst time. Restore the normal cycle with ALTER TABLE ... RESET (autovacuum_enabled), or freeze it manually in a chosen window with VACUUM (FREEZE).'
          : 'Freeze it in a quiet window with VACUUM (FREEZE, VERBOSE) before autovacuum does it on its own: a forced freeze cannot be canceled and blocks ALTER TABLE. If it rises again without dropping, what holds the XIDs is outside the table: an open transaction, an inactive replication slot, or an orphaned prepared transaction.',
        value: peor,
      });
    }
    return findings;
  },
};

const deadTuples: CheckDefinition = {
  id: 'dead_tuples',
  title: 'Dead tuples and lagging autovacuum',
  description: 'Tables where autovacuum is not keeping up with changes',
  sql: () => `
    select schemaname, relname, n_live_tup, n_dead_tup, autovacuum_count,
           extract(epoch from (now() - greatest(last_autovacuum, last_vacuum))) as seconds_since_vacuum
      from pg_stat_user_tables
     where n_dead_tup > 0
     order by n_dead_tup desc
     limit 20`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const live = num(row['n_live_tup']);
      const dead = num(row['n_dead_tup']);
      const total = live + dead;
      if (total === 0) continue;
      const pct = (dead / total) * 100;
      const object = `${text(row['schemaname'])}.${text(row['relname'])}`;
      const autovacuums = num(row['autovacuum_count']);

      if (dead > 1000 && pct > 20) {
        findings.push({
          severity: pct > 50 ? 'warning' : 'info',
          object,
          message:
            `${dead.toLocaleString('en-US')} dead tuples (${formatPct(pct)} of the table)` +
            (autovacuums > 0 ? `, despite ${autovacuums} autovacuums.` : ', with no autovacuum runs.'),
          remediation:
            'On tables with many UPDATEs the global scale_factor (0.2) never triggers. Lower it per table: ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000). Consider fillfactor 90 to favor HOT updates.',
          value: pct,
        });
      } else if (autovacuums === 0 && dead > 10) {
        findings.push({
          severity: 'info',
          object,
          message: `${dead} dead tuples and autovacuum has never run on this table.`,
          remediation:
            'Normal if the table is new or small. If it grows, verify that autovacuum is enabled at the table level (reloptions).',
          value: dead,
        });
      }
    }
    return findings;
  },
};

/**
 * Verificado contra PG 18.4: encontró 4 índices redundantes (~132 MB) en el
 * lake de DataSync, donde el PK compuesto ya cubre el índice de la columna.
 */
const redundantIndexes: CheckDefinition = {
  id: 'redundant_index_prefix',
  title: 'Redundant prefix indexes',
  description: 'Indexes whose columns are already the left prefix of another index',
  sql: () => `
    with idx as (
      select i.indexrelid,
             n.nspname  as schema_name,
             c.relname  as table_name,
             ir.relname as index_name,
             i.indisunique,
             pg_relation_size(i.indexrelid) as bytes,
             (i.indpred is not null)   as is_partial,
             (i.indexprs is not null)  as has_expression,
             (select array_agg(k.attnum order by k.ord)
                from unnest(i.indkey) with ordinality k(attnum, ord)) as cols
        from pg_index i
        join pg_class c      on c.oid = i.indrelid
        join pg_class ir     on ir.oid = i.indexrelid
        join pg_namespace n  on n.oid = c.relnamespace
       where i.indisvalid
         and c.relkind in ('r', 'p')
         and n.nspname not in ('pg_catalog', 'information_schema')
    )
    select a.schema_name, a.table_name,
           a.index_name as redundant_index,
           b.index_name as covered_by,
           a.bytes      as redundant_bytes
      from idx a
      join idx b
        on a.schema_name = b.schema_name
       and a.table_name  = b.table_name
       and a.indexrelid <> b.indexrelid
       and array_length(a.cols, 1) <= array_length(b.cols, 1)
       and b.cols[1:array_length(a.cols, 1)] = a.cols
     where not a.indisunique
       and not a.is_partial and not b.is_partial
       and not a.has_expression and not b.has_expression
       and a.bytes > 1024 * 1024
     order by a.bytes desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: `${text(row['schema_name'])}.${text(row['table_name'])}.${text(row['redundant_index'])}`,
      message:
        `${formatBytes(num(row['redundant_bytes']))} recoverable: its columns are already the left prefix of ` +
        `${text(row['covered_by'])}, which can serve the same lookups.`,
      remediation:
        'Confirm that no query explicitly depends on the index (pg_stat_user_indexes.idx_scan) and then DROP INDEX CONCURRENTLY. Besides space, you save write work on every INSERT and UPDATE.',
      value: num(row['redundant_bytes']),
    })),
};

const unusedIndexes: CheckDefinition = {
  id: 'unused_indexes',
  title: 'Unused indexes',
  description: 'Large indexes that never recorded a scan',
  // Se excluyen los índices de PK/UNIQUE (respaldan integridad: no son
  // accionables) y los que ya reporta redundant_index_prefix, para no decir
  // dos veces lo mismo del mismo objeto.
  sql: () => `
    with idx as (
      select i.indexrelid, i.indrelid, i.indisunique,
             (i.indpred is not null)  as is_partial,
             (i.indexprs is not null) as has_expression,
             (select array_agg(k.attnum order by k.ord)
                from unnest(i.indkey) with ordinality k(attnum, ord)) as cols
        from pg_index i
       where i.indisvalid
    ),
    redundant as (
      select a.indexrelid
        from idx a
        join idx b
          on a.indrelid = b.indrelid
         and a.indexrelid <> b.indexrelid
         and array_length(a.cols, 1) <= array_length(b.cols, 1)
         and b.cols[1:array_length(a.cols, 1)] = a.cols
       where not a.indisunique
         and not a.is_partial and not b.is_partial
         and not a.has_expression and not b.has_expression
    )
    select s.schemaname, s.relname, s.indexrelname,
           pg_relation_size(s.indexrelid) as bytes
      from pg_stat_user_indexes s
      join pg_index i on i.indexrelid = s.indexrelid
     where s.idx_scan = 0
       and not i.indisprimary
       and not i.indisunique
       and pg_relation_size(s.indexrelid) > 10 * 1024 * 1024
       and s.indexrelid not in (select indexrelid from redundant)
     order by pg_relation_size(s.indexrelid) desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['schemaname'])}.${text(row['relname'])}.${text(row['indexrelname'])}`,
      message: `${formatBytes(num(row['bytes']))} with no scans recorded.`,
      remediation:
        'Review before dropping: counters reset with pg_stat_reset and it may be an index used by infrequent processes (month-end closes, reports) or by replicas.',
      value: num(row['bytes']),
    })),
};

const tempSpill: CheckDefinition = {
  id: 'temp_spill',
  title: 'Spill to temp files',
  description: 'Queries that do not fit in work_mem and spill to disk',
  sql: () => `
    select datname, temp_files, temp_bytes
      from pg_stat_database
     where temp_bytes > 64 * 1024 * 1024
     order by temp_bytes desc`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: text(row['datname']),
      message: `${formatBytes(num(row['temp_bytes']))} spilled to ${num(row['temp_files'])} temp files.`,
      remediation:
        'Raise work_mem (per session or per role, not globally: it multiplies by connection and by plan node) or fix queries that sort or group without an index. log_temp_files identifies which ones.',
      value: num(row['temp_bytes']),
    })),
};

const cacheHit: CheckDefinition = {
  id: 'cache_hit',
  title: 'Low cache hit ratio',
  description: 'Share of blocks served from shared_buffers',
  sql: () => `
    select datname, blks_hit, blks_read
      from pg_stat_database
     where blks_read + blks_hit > 100000
     order by blks_read desc`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const hits = num(row['blks_hit']);
      const reads = num(row['blks_read']);
      const pct = (hits / (hits + reads)) * 100;
      if (pct >= 95) continue;
      findings.push({
        severity: pct < 90 ? 'warning' : 'info',
        object: text(row['datname']),
        message: `Cache hit of ${formatPct(pct)} since the last statistics reset.`,
        remediation:
          'This is a coarse indicator (the OS also caches). Before raising shared_buffers, look at which queries do the reads with pg_stat_statements and whether an index is missing.',
        value: pct,
      });
    }
    return findings;
  },
};

const inactiveSlots: CheckDefinition = {
  id: 'inactive_replication_slot',
  title: 'Inactive replication slot',
  description: 'Slots without a consumer: they retain WAL and can fill the disk',
  sql: () => `
    select slot_name, slot_type, active, coalesce(wal_status, 'unknown') as wal_status,
           safe_wal_size
      from pg_replication_slots
     where not active or wal_status in ('extended', 'unreserved', 'lost')`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: text(row['wal_status']) === 'lost' ? ('critical' as const) : ('warning' as const),
      object: text(row['slot_name']),
      message: `Inactive ${text(row['slot_type'])} slot, wal_status = ${text(row['wal_status'])}.`,
      remediation:
        'A slot without a consumer retains WAL indefinitely until the disk fills and also blocks XID freeze. If the consumer no longer exists: SELECT pg_drop_replication_slot(...). If it is still alive, fix the replica or CDC connector.',
    })),
};

const tablesWithoutPk: CheckDefinition = {
  id: 'tables_without_pk',
  title: 'Tables without primary key',
  description: 'Large tables without a PK',
  sql: () => `
    select n.nspname as schema_name, c.relname as table_name, c.reltuples::bigint as est_rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname not in ('pg_catalog', 'information_schema')
       and c.reltuples > 1000
       and not exists (
             select 1 from pg_constraint k
              where k.conrelid = c.oid and k.contype = 'p')
     order by c.reltuples desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['schema_name'])}.${text(row['table_name'])}`,
      message: `~${num(row['est_rows']).toLocaleString('en-US')} rows without a primary key.`,
      remediation:
        'Without a PK there is no cheap way to identify a row: it complicates targeted UPDATE/DELETE, logical replication (REPLICA IDENTITY), and CDC. Add a PK or at least a unique index.',
      value: num(row['est_rows']),
    })),
};

const longRunningQueries: CheckDefinition = {
  id: 'long_running_queries',
  title: 'Long-running queries',
  description: 'Active queries above the threshold',
  sql: () => `
    select pid, coalesce(application_name, '(unnamed)') as application_name,
           extract(epoch from (now() - query_start)) as running_seconds,
           left(coalesce(query, ''), 120) as query
      from pg_stat_activity
     where state = 'active'
       and backend_type = 'client backend'
       and query_start < now() - interval '5 minutes'
     order by query_start
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: `pid ${text(row['pid'])} (${text(row['application_name'])})`,
      message: `Running for ${formatDuration(num(row['running_seconds']))}: ${text(row['query'], '(hidden)')}`,
      remediation:
        'Review the plan with EXPLAIN (ANALYZE, BUFFERS). To prevent repeats, set statement_timeout per role for interactive workloads.',
      value: num(row['running_seconds']),
    })),
};

/**
 * El caso "precargada pero sin CREATE EXTENSION" es el más común y el más
 * satisfactorio de arreglar: se activa sin reiniciar el servidor.
 */
const statStatementsState: CheckDefinition = {
  id: 'pg_stat_statements_state',
  title: 'pg_stat_statements status',
  description: 'Query analysis availability',
  sql: () => null,
  evaluate: (_rows, caps) => {
    if (caps.statStatements === 'active') return [];
    if (caps.statStatements === 'preloaded_not_created') {
      return [
        {
          severity: 'warning',
          message:
            'The library is already in shared_preload_libraries but the extension is not created: you are paying the overhead without getting any data.',
          remediation: 'CREATE EXTENSION pg_stat_statements; — does not require a server restart.',
        },
      ];
    }
    return [
      {
        severity: 'info',
        message: 'pg_stat_statements is not preloaded, so there is no query analysis.',
        remediation:
          "Add 'pg_stat_statements' to shared_preload_libraries and restart; then CREATE EXTENSION. It is the best value/risk change on an uninstrumented PostgreSQL.",
      },
    ];
  },
};

const configCoherence: CheckDefinition = {
  id: 'config_coherence',
  title: 'Incoherent memory configuration',
  description: 'shared_buffers versus effective_cache_size and track_io_timing',
  sql: () => `
    select (select setting::bigint * 8192 from pg_settings where name = 'shared_buffers')       as shared_buffers_bytes,
           (select setting::bigint * 8192 from pg_settings where name = 'effective_cache_size') as effective_cache_bytes,
           (select setting::bigint * 1024 from pg_settings where name = 'work_mem')             as work_mem_bytes,
           (select setting from pg_settings where name = 'track_io_timing')                     as track_io_timing`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];
    const shared = num(row['shared_buffers_bytes']);
    const effective = num(row['effective_cache_bytes']);

    if (shared > 0 && effective > 0 && effective / shared >= 16) {
      findings.push({
        severity: 'warning',
        message:
          `shared_buffers is at ${formatBytes(shared)} while effective_cache_size declares ${formatBytes(effective)}: ` +
          'the instance was left at the container default.',
        remediation:
          'With dedicated RAM, shared_buffers is usually around 25% and effective_cache_size 50–75%. effective_cache_size does not reserve memory, it only informs the planner, so leaving it high with minimal shared_buffers yields optimistic plans without real cache.',
        value: effective / shared,
      });
    }

    if (String(row['track_io_timing']) !== 'on') {
      findings.push({
        severity: 'info',
        message: 'track_io_timing = off: no I/O timings, only block counts.',
        remediation:
          'Enable without restart: ALTER SYSTEM SET track_io_timing = on; SELECT pg_reload_conf(); Measure overhead first with pg_test_timing.',
      });
    }

    return findings;
  },
};

const frequentCheckpoints: CheckDefinition = {
  id: 'frequent_checkpoints',
  title: 'Checkpoints forced by WAL volume',
  description: 'Share of checkpoints requested by max_wal_size versus scheduled ones',
  // PG17 movió estos contadores de pg_stat_bgwriter a pg_stat_checkpointer y
  // les cambió el nombre; PG18 los quitó de bgwriter.
  sql: (caps) =>
    caps.hasStatCheckpointer
      ? `select num_timed as timed, num_requested as requested,
                (select setting::bigint * 1024 * 1024 from pg_settings where name = 'max_wal_size') as max_wal_bytes,
                (select setting::int from pg_settings where name = 'checkpoint_timeout') as checkpoint_timeout
           from pg_stat_checkpointer`
      : `select checkpoints_timed as timed, checkpoints_req as requested,
                (select setting::bigint * 1024 * 1024 from pg_settings where name = 'max_wal_size') as max_wal_bytes,
                (select setting::int from pg_settings where name = 'checkpoint_timeout') as checkpoint_timeout
           from pg_stat_bgwriter`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const timed = num(row['timed']);
    const requested = num(row['requested']);
    const total = timed + requested;
    // Con pocos checkpoints el porcentaje es ruido estadístico.
    if (total < 20) return [];

    const pct = (requested / total) * 100;
    if (pct < 30) return [];

    return [
      {
        severity: pct >= 60 ? 'warning' : 'info',
        message:
          `${formatPct(pct)} of checkpoints were forced by WAL volume (${requested} of ${total}), ` +
          `with max_wal_size at ${formatBytes(num(row['max_wal_bytes']))}.`,
        remediation:
          'Raise max_wal_size so checkpoint_timeout governs checkpoints instead of WAL fill. Forced checkpoints concentrate writes and trigger full page writes; the cost of raising it is more pg_wal space and longer recovery after a crash.',
        value: pct,
      },
    ];
  },
};

const walArchiveFailing: CheckDefinition = {
  id: 'wal_archive_failing',
  title: 'WAL archiving failing',
  description: 'archive_mode on with a failing archiver: WAL accumulates and there is no valid backup',
  sql: () => `
    select current_setting('archive_mode')                        as archive_mode,
           nullif(trim(current_setting('archive_command')), '')    as archive_command,
           a.archived_count, a.failed_count,
           a.last_archived_time, a.last_failed_time,
           a.last_failed_wal
      from pg_stat_archiver a`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    if (String(row['archive_mode']) === 'off') return [];

    const findings: Finding[] = [];
    const failed = num(row['failed_count']);
    const lastFailed = row['last_failed_time'] ? new Date(String(row['last_failed_time'])) : null;
    const lastArchived = row['last_archived_time'] ? new Date(String(row['last_archived_time'])) : null;

    if (!row['archive_command']) {
      findings.push({
        severity: 'critical',
        message: 'archive_mode is on but archive_command is empty: WAL is never archived and pg_wal grows without bound.',
        remediation:
          'Define archive_command (or archive_library) and verify with pg_switch_wal(). While empty, PostgreSQL retains every segment waiting to archive until the disk fills.',
      });
    }

    // Lo que importa no es que alguna vez falló, sino que el último intento
    // fallara: si después hubo un archivado exitoso, el problema ya pasó.
    const failingNow = failed > 0 && lastFailed !== null && (lastArchived === null || lastFailed > lastArchived);
    if (failingNow) {
      findings.push({
        severity: 'critical',
        message:
          `Archiving has been failing since ${text(row['last_failed_wal'])} (${failed} failed attempts). ` +
          'WAL is accumulating in pg_wal and the backup chain is incomplete.',
        remediation:
          'Check the archive_command destination (permissions, space, network). Until a segment archives successfully, PostgreSQL does not release any following ones: the immediate risk is filling the disk, and the background risk is not being able to recover to a point in time.',
        value: failed,
      });
    }

    return findings;
  },
};

const unsafeDurability: CheckDefinition = {
  id: 'unsafe_durability',
  title: 'Durability settings at risk',
  description: 'fsync, full_page_writes, and synchronous_commit disabled',
  // Búho no toca ninguno de estos cuatro en su sesión, así que current_setting
  // dice la verdad. (Los timeouts son otra historia: ver missing_timeouts.)
  sql: () => `
    select current_setting('fsync')               as fsync,
           current_setting('full_page_writes')     as full_page_writes,
           current_setting('data_checksums')       as data_checksums,
           current_setting('synchronous_commit')   as synchronous_commit`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];

    if (String(row['fsync']) === 'off') {
      findings.push({
        severity: 'critical',
        message: 'fsync = off: a power loss or kernel crash can leave the database unrecoverable.',
        remediation:
          'Set fsync = on (requires restart). off only makes sense during an initial load that can be repeated from scratch. It is not "faster with small risk": it is silent corruption, not loss of the latest transactions.',
      });
    }
    if (String(row['full_page_writes']) === 'off') {
      findings.push({
        severity: 'critical',
        message: 'full_page_writes = off: a crash during a write can leave pages torn and unreadable.',
        remediation:
          'Set full_page_writes = on. It can only be disabled if storage guarantees atomic page writes, which almost no filesystem promises.',
      });
    }
    if (String(row['synchronous_commit']) === 'off') {
      findings.push({
        severity: 'warning',
        message: 'synchronous_commit = off: commits acknowledge before WAL reaches disk.',
        remediation:
          'Unlike fsync, this does not corrupt data: you lose the latest committed transactions on a crash. It is a valid choice if someone made it on purpose; confirm that is the case and not an inherited default.',
      });
    }
    if (String(row['data_checksums']) === 'off') {
      findings.push({
        severity: 'info',
        message: 'data_checksums = off: on-disk data corruption is not detected on read.',
        remediation:
          'It can be enabled without dump/restore using pg_checksums --enable, but requires the instance to be stopped. Worth planning in the next maintenance window.',
      });
    }

    return findings;
  },
};

const autovacuumDisabled: CheckDefinition = {
  id: 'autovacuum_disabled',
  title: 'Tables with autovacuum disabled',
  description: 'Tables with autovacuum_enabled = false in reloptions',
  sql: () => `
    select n.nspname as schema_name, c.relname as table_name,
           coalesce(s.n_dead_tup, 0)  as dead_tuples,
           coalesce(s.n_live_tup, 0)  as live_tuples,
           s.last_autovacuum, s.last_vacuum,
           pg_total_relation_size(c.oid) as bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
     where c.relkind in ('r', 'p')
       and n.nspname not in ('pg_catalog', 'information_schema')
       and array_to_string(c.reloptions, ',') like '%autovacuum_enabled=false%'
     order by pg_total_relation_size(c.oid) desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => {
      const dead = num(row['dead_tuples']);
      const manual = row['last_vacuum'] !== null && row['last_vacuum'] !== undefined;
      return {
        severity: dead > 100_000 ? ('critical' as const) : ('warning' as const),
        object: `${text(row['schema_name'])}.${text(row['table_name'])}`,
        message:
          `Autovacuum disabled on the table (${formatBytes(num(row['bytes']))}, ${dead.toLocaleString('en-US')} dead tuples). ` +
          (manual ? 'Manual vacuum has been recorded.' : 'No manual vacuum has been recorded.'),
        remediation:
          'If it was for a bulk load, revert it: ALTER TABLE ... RESET (autovacuum_enabled). A table without vacuum not only accumulates dead space, it also stops advancing relfrozenxid and drags wraparound risk for the whole database.',
        value: dead,
      };
    }),
};

const staleStatistics: CheckDefinition = {
  id: 'stale_statistics',
  title: 'Stale planner statistics',
  description: 'Tables with many rows modified since the last ANALYZE',
  sql: () => `
    select schemaname as schema_name, relname as table_name,
           n_mod_since_analyze as modified,
           n_live_tup          as live_tuples,
           greatest(last_analyze, last_autoanalyze) as analyzed_at
      from pg_stat_user_tables
     where n_mod_since_analyze > greatest(10000, n_live_tup * 0.2)
       and n_live_tup > 1000
     order by n_mod_since_analyze desc
     limit 15`,
  evaluate: (rows) =>
    rows.map((row) => {
      const modified = num(row['modified']);
      const live = num(row['live_tuples']);
      const pct = live > 0 ? (modified / live) * 100 : 0;
      const analyzed = row['analyzed_at'];
      return {
        severity: pct >= 100 ? ('warning' as const) : ('info' as const),
        object: `${text(row['schema_name'])}.${text(row['table_name'])}`,
        message:
          `${modified.toLocaleString('en-US')} rows modified since the last ANALYZE (${formatPct(pct)} of the table), ` +
          (analyzed ? `last analyzed ${new Date(String(analyzed)).toISOString().slice(0, 16).replace('T', ' ')}.` : 'never analyzed.'),
        remediation:
          'Run ANALYZE on the table. Stale statistics make the planner misestimate row counts and choose seq scan where it should use an index, or nested loop where it should use hash join: the query degrades without any SQL change.',
        value: pct,
      };
    }),
};

const replicationLag: CheckDefinition = {
  id: 'replication_lag',
  title: 'Replication lag',
  description: 'Standby lag in bytes and seconds (or replay lag if this instance is a standby)',
  // Dos preguntas distintas según el rol: en el primario interesa cuánto le
  // falta a cada standby; en un standby, cuánto hace que no aplica nada.
  sql: (caps) =>
    caps.inRecovery
      ? `select 'standby' as scope,
                extract(epoch from (now() - pg_last_xact_replay_timestamp())) as replay_seconds,
                null::bigint as lag_bytes, null::text as client, null::text as state`
      : `select 'primary' as scope,
                extract(epoch from replay_lag) as replay_seconds,
                pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes,
                coalesce(application_name, host(client_addr)::text, '(unknown)') as client,
                state
           from pg_stat_replication`,
  evaluate: (rows) => {
    const findings: Finding[] = [];

    for (const row of rows) {
      const seconds = num(row['replay_seconds']);
      const bytes = num(row['lag_bytes']);

      if (String(row['scope']) === 'standby') {
        // Un standby sin tráfico también muestra "retraso": el aviso es por
        // minutos sin aplicar nada, no por segundos.
        if (seconds < 300) continue;
        findings.push({
          severity: seconds >= 1800 ? 'critical' : 'warning',
          message: `This standby has not applied changes for ${formatDuration(seconds)}.`,
          remediation:
            'Verify the connection to the primary (pg_stat_wal_receiver) and whether the primary is still generating WAL. A lagging standby is less useful for failover and, if it serves read queries, is already returning stale data.',
          value: seconds,
        });
        continue;
      }

      if (bytes < 64 * 1024 * 1024 && seconds < 60) continue;
      findings.push({
        severity: bytes >= 512 * 1024 * 1024 || seconds >= 300 ? 'critical' : 'warning',
        object: text(row['client']),
        message:
          `Standby is ${formatBytes(bytes)} behind` +
          (seconds > 0 ? ` (${formatDuration(seconds)} replay lag)` : '') +
          `, state ${text(row['state'])}.`,
        remediation:
          'Review standby network and I/O capacity. If lag grows steadily, the primary will eventually retain WAL for the slot and fill pg_wal.',
        value: bytes,
      });
    }

    return findings;
  },
};

const missingTimeouts: CheckDefinition = {
  id: 'missing_timeouts',
  title: 'No per-session time limits',
  description: 'statement_timeout and idle_in_transaction_session_timeout unset',
  // Este check no puede preguntarle a su propia sesión.
  //
  // El pool de Búho fija statement_timeout e idle_in_transaction_session_timeout
  // como parámetros del paquete de arranque, y eso contamina las dos vistas
  // obvias: `current_setting()` devuelve el valor del monitor, y `reset_val`
  // también, porque RESET vuelve al valor de arranque de la sesión, no al del
  // archivo de configuración. Medido: reset_val devolvía 5000 y 10000, que son
  // exactamente los valores que pone Búho.
  //
  // La fuente honesta es la configuración en disco (`pg_file_settings`, legible
  // con pg_monitor). Los overrides por rol o por base se cuentan aparte para
  // no afirmar de más.
  appliesTo: (caps) => caps.hasPgMonitor || caps.isSuperuser,
  sql: () => `
    select coalesce(
             (select f.setting from pg_file_settings f
               where f.name = 'statement_timeout' and f.applied
               order by f.seqno desc limit 1),
             (select boot_val from pg_settings where name = 'statement_timeout')
           ) as statement_timeout,
           coalesce(
             (select f.setting from pg_file_settings f
               where f.name = 'idle_in_transaction_session_timeout' and f.applied
               order by f.seqno desc limit 1),
             (select boot_val from pg_settings where name = 'idle_in_transaction_session_timeout')
           ) as idle_in_transaction_timeout,
           (select count(*) from pg_db_role_setting) as scoped_overrides`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];

    const overrides = num(row['scoped_overrides']);
    const caveat =
      overrides > 0
        ? ` There are ${overrides} role- or database-level setting(s) this check does not evaluate: if the limit is there, ignore this warning.`
        : '';

    if (String(row['idle_in_transaction_timeout']) === '0') {
      findings.push({
        severity: 'warning',
        message:
          'idle_in_transaction_session_timeout = 0 in configuration: a forgotten transaction can stay open forever.' +
          caveat,
        remediation:
          'Set a limit (for example 15min) at server or role level. It is the only automatic defense against the most common disaster pattern: an open transaction that stalls vacuum for the whole database and pushes XID toward wraparound.',
      });
    }
    if (String(row['statement_timeout']) === '0') {
      findings.push({
        severity: 'critical',
        message: 'statement_timeout = 0 in configuration: there is no ceiling on how long a query can run.' + caveat,
        remediation:
          'Set a server-wide ceiling (for example 15min) with ALTER SYSTEM, then reload. Tune per role for apps that need longer runs.',
      });
    }

    return findings;
  },
};

const weakPasswordEncryption: CheckDefinition = {
  id: 'weak_password_encryption',
  title: 'Obsolete password encryption',
  description: 'password_encryption set to md5 or roles with stored md5 hashes',
  // El conteo de hashes exige superusuario (pg_authid): con pg_monitor la
  // consulta fallaría entera, así que la parte sensible se incluye sólo si se
  // puede leer.
  sql: (caps) =>
    caps.isSuperuser
      ? `select current_setting('password_encryption') as password_encryption,
                (select count(*) from pg_authid
                  where rolpassword like 'md5%' and rolcanlogin) as md5_roles`
      : `select current_setting('password_encryption') as password_encryption,
                null::bigint as md5_roles`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];

    if (String(row['password_encryption']) === 'md5') {
      findings.push({
        severity: 'warning',
        message: 'password_encryption = md5: new passwords are stored with an obsolete scheme.',
        remediation:
          "Switch to scram-sha-256 (ALTER SYSTEM SET password_encryption = 'scram-sha-256'; SELECT pg_reload_conf()). PostgreSQL's md5 hash uses the username as salt and is vulnerable to offline brute force if someone obtains the hash; PG18 already marks it obsolete.",
      });
    }

    const md5Roles = row['md5_roles'];
    if (md5Roles !== null && md5Roles !== undefined && num(md5Roles) > 0) {
      findings.push({
        severity: 'warning',
        message: `${num(md5Roles)} login role(s) still have passwords stored as md5.`,
        remediation:
          'Change password_encryption and then reset each role password (\\password in psql): the hash does not convert on its own, it is rewritten only when the password is set again. Also verify that pg_hba.conf no longer requests md5.',
        value: num(md5Roles),
      });
    }

    return findings;
  },
};

/**
 * Fuera del catálogo 1:1 con MariaDB/SQL Server: sólo PostgreSQL tiene
 * suscripciones lógicas. Un suscriptor no tiene slots; el apply worker caído
 * es el hallazgo (pid vacío en pg_stat_subscription).
 */
const logicalSubscriptionDown: CheckDefinition = {
  id: 'logical_subscription_down',
  title: 'Logical subscription not applying',
  description: 'Subscriber apply worker is down',
  sql: () => `
    select subname
      from pg_stat_subscription
     group by subname
    having not bool_or(pid is not null)`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'critical' as const,
      object: text(row['subname']),
      message: `Subscription ${text(row['subname'])} has no apply worker (pid is empty). It is not applying.`,
      remediation:
        'On the subscriber, check pg_stat_subscription and the log for the apply worker. Confirm the publisher slot (subslotname) still exists, the subscription is enabled, and max_logical_replication_workers is not exhausted. ALTER SUBSCRIPTION … DISABLE / ENABLE restarts the worker after the cause is fixed.',
    })),
};

export const POSTGRES_ONLY_CHECKS: CheckDefinition[] = [logicalSubscriptionDown];

export const CHECKS: CheckDefinition[] = [
  connectionSaturation,
  idleInTransaction,
  blockingChain,
  xidWraparound,
  xidWraparoundTable,
  deadTuples,
  redundantIndexes,
  unusedIndexes,
  tempSpill,
  cacheHit,
  inactiveSlots,
  tablesWithoutPk,
  longRunningQueries,
  statStatementsState,
  configCoherence,
  frequentCheckpoints,
  walArchiveFailing,
  unsafeDurability,
  autovacuumDisabled,
  staleStatistics,
  replicationLag,
  missingTimeouts,
  weakPasswordEncryption,
];
