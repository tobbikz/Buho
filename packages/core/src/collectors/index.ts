import type { Capabilities, MetricCollector, Sample } from '../types';

/** pg devuelve bigint y numeric como string; nunca confiar en el tipo crudo. */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown, fallback = '(desconocido)'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function resetMarker(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

const availability: MetricCollector = {
  id: 'availability',
  tier: 'fast',
  description: 'Uptime del servidor',
  sql: () => `select extract(epoch from (now() - pg_postmaster_start_time())) as uptime_seconds`,
  toSamples: (rows) => [{ metric: 'uptime_seconds', value: num(rows[0]?.['uptime_seconds']) }],
};

const connections: MetricCollector = {
  id: 'connections',
  tier: 'fast',
  description: 'Sesiones por estado, saturación y transacciones más viejas',
  sql: () => `
    select current_setting('max_connections')::int as max_connections,
           count(*)                                                              as total,
           count(*) filter (where state = 'active')                              as active,
           count(*) filter (where state = 'idle')                                as idle,
           count(*) filter (where state = 'idle in transaction')                 as idle_in_transaction,
           count(*) filter (where state = 'idle in transaction (aborted)')       as idle_in_transaction_aborted,
           coalesce(max(extract(epoch from (now() - xact_start))), 0)            as oldest_xact_seconds,
           coalesce(max(extract(epoch from (now() - query_start)))
                    filter (where state = 'active'), 0)                          as longest_active_query_seconds,
           coalesce(max(extract(epoch from (now() - state_change)))
                    filter (where state like 'idle in transaction%'), 0)         as longest_idle_in_tx_seconds
      from pg_stat_activity
     where backend_type = 'client backend'`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const max = num(row['max_connections']);
    const total = num(row['total']);
    return [
      { metric: 'connections_max', value: max },
      { metric: 'connections_total', value: total },
      { metric: 'connections_active', value: num(row['active']) },
      { metric: 'connections_idle', value: num(row['idle']) },
      { metric: 'connections_idle_in_transaction', value: num(row['idle_in_transaction']) },
      { metric: 'connections_idle_in_transaction_aborted', value: num(row['idle_in_transaction_aborted']) },
      { metric: 'connections_used_pct', value: max > 0 ? (total / max) * 100 : 0 },
      { metric: 'oldest_xact_seconds', value: num(row['oldest_xact_seconds']) },
      { metric: 'longest_active_query_seconds', value: num(row['longest_active_query_seconds']) },
      { metric: 'longest_idle_in_tx_seconds', value: num(row['longest_idle_in_tx_seconds']) },
    ];
  },
};

const waitEvents: MetricCollector = {
  id: 'wait_events',
  tier: 'fast',
  description: 'Muestreo de wait events de sesiones activas',
  sql: () => `
    select coalesce(wait_event_type, 'CPU') as wait_event_type,
           coalesce(wait_event, 'CPU')      as wait_event,
           count(*)                          as sessions
      from pg_stat_activity
     where backend_type = 'client backend'
       and state = 'active'
     group by 1, 2`,
  toSamples: (rows) =>
    rows.map((row) => ({
      metric: 'wait_event_sessions',
      value: num(row['sessions']),
      labels: {
        wait_event_type: str(row['wait_event_type']),
        wait_event: str(row['wait_event']),
      },
    })),
};

const blocking: MetricCollector = {
  id: 'blocking',
  tier: 'fast',
  description: 'Sesiones bloqueadas y duración del bloqueo',
  sql: () => `
    select count(*)                                                     as blocked_sessions,
           coalesce(max(extract(epoch from (now() - query_start))), 0)   as max_blocked_seconds
      from pg_stat_activity
     where cardinality(pg_blocking_pids(pid)) > 0`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    return [
      { metric: 'blocked_sessions', value: num(row['blocked_sessions']) },
      { metric: 'max_blocked_seconds', value: num(row['max_blocked_seconds']) },
    ];
  },
};

const databaseStats: MetricCollector = {
  id: 'database_stats',
  tier: 'normal',
  description: 'Contadores de pg_stat_database (stats_reset es por base de datos)',
  sql: () => `
    select datname, numbackends, xact_commit, xact_rollback, blks_hit, blks_read,
           tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
           deadlocks, temp_files, temp_bytes, conflicts, stats_reset
      from pg_stat_database
     where datname is not null
       and datname not like 'template%'`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { database: str(row['datname']) };
      const statsReset = resetMarker(row['stats_reset']);
      const hits = num(row['blks_hit']);
      const reads = num(row['blks_read']);

      samples.push({ metric: 'db_backends', value: num(row['numbackends']), labels });
      if (hits + reads > 0) {
        samples.push({ metric: 'db_cache_hit_pct', value: (hits / (hits + reads)) * 100, labels });
      }

      const counters: Record<string, unknown> = {
        db_xact_commit: row['xact_commit'],
        db_xact_rollback: row['xact_rollback'],
        db_blks_hit: row['blks_hit'],
        db_blks_read: row['blks_read'],
        db_tup_returned: row['tup_returned'],
        db_tup_fetched: row['tup_fetched'],
        db_tup_inserted: row['tup_inserted'],
        db_tup_updated: row['tup_updated'],
        db_tup_deleted: row['tup_deleted'],
        db_deadlocks: row['deadlocks'],
        db_temp_files: row['temp_files'],
        db_temp_bytes: row['temp_bytes'],
        db_conflicts: row['conflicts'],
      };
      for (const [metric, raw] of Object.entries(counters)) {
        samples.push({ metric, value: num(raw), labels, counter: true, statsReset });
      }
    }
    return samples;
  },
};

const databaseSizes: MetricCollector = {
  id: 'database_sizes',
  tier: 'slow',
  description: 'Tamaño de cada base de datos',
  sql: () => `
    select datname, pg_database_size(datname) as bytes
      from pg_database
     where datallowconn`,
  toSamples: (rows) =>
    rows.map((row) => ({
      metric: 'database_size_bytes',
      value: num(row['bytes']),
      labels: { database: str(row['datname']) },
    })),
};

const wraparound: MetricCollector = {
  id: 'wraparound',
  tier: 'slow',
  description: 'Edad de los XID frente a autovacuum_freeze_max_age',
  sql: () => `
    select datname,
           age(datfrozenxid)                                        as xid_age,
           current_setting('autovacuum_freeze_max_age')::bigint      as freeze_max_age
      from pg_database
     where datallowconn`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { database: str(row['datname']) };
      const age = num(row['xid_age']);
      const max = num(row['freeze_max_age']);
      samples.push({ metric: 'xid_age', value: age, labels });
      if (max > 0) samples.push({ metric: 'xid_age_pct', value: (age / max) * 100, labels });
    }
    return samples;
  },
};

const deadTuples: MetricCollector = {
  id: 'dead_tuples',
  tier: 'slow',
  description: 'Tuplas muertas y antigüedad del último vacuum (base conectada)',
  sql: (caps) => `
    select schemaname, relname, n_live_tup, n_dead_tup, autovacuum_count,
           extract(epoch from (now() - greatest(last_autovacuum, last_vacuum))) as seconds_since_vacuum
           ${caps.hasLastScanColumns ? ', last_seq_scan, last_idx_scan' : ''}
      from pg_stat_user_tables
     where n_dead_tup > 0
     order by n_dead_tup desc
     limit 20`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { schema: str(row['schemaname']), table: str(row['relname']) };
      const live = num(row['n_live_tup']);
      const dead = num(row['n_dead_tup']);
      samples.push({ metric: 'table_dead_tuples', value: dead, labels });
      samples.push({ metric: 'table_live_tuples', value: live, labels });
      if (live + dead > 0) {
        samples.push({ metric: 'table_dead_pct', value: (dead / (live + dead)) * 100, labels });
      }
      if (row['seconds_since_vacuum'] !== null && row['seconds_since_vacuum'] !== undefined) {
        samples.push({ metric: 'table_seconds_since_vacuum', value: num(row['seconds_since_vacuum']), labels });
      }
    }
    return samples;
  },
};

/**
 * Actividad por tabla: quién se lleva las escrituras y las lecturas.
 *
 * `pg_stat_database` dice cuántas filas se insertaron en la base; esto dice en
 * *qué tabla*. Es la pieza que convierte "la base escribe mucho" en "el 80 % de
 * las escrituras cae en esta tabla", que es la única forma de la pregunta que se
 * puede accionar.
 *
 * Son contadores acumulados desde el último `stats_reset`, así que van marcados
 * como tales y el store calcula la tasa. El `limit` ordena por actividad
 * acumulada, no por la del último intervalo: una tabla que fue muy caliente el
 * mes pasado sigue apareciendo con tasa cero, y eso es preferible a que las
 * tablas entren y salgan de la lista entre muestras y rompan las series.
 */
const tableActivity: MetricCollector = {
  id: 'table_activity',
  tier: 'normal',
  description: 'DML y escaneos por tabla (base conectada)',
  sql: () => `
    select schemaname, relname,
           n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd,
           seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
           (select stats_reset from pg_stat_database where datname = current_database()) as stats_reset
      from pg_stat_user_tables
     where n_tup_ins + n_tup_upd + n_tup_del > 0
        or seq_scan > 0
        or coalesce(idx_scan, 0) > 0
     order by (n_tup_ins + n_tup_upd + n_tup_del) desc,
              (seq_scan + coalesce(idx_scan, 0)) desc
     limit 30`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { schema: str(row['schemaname']), table: str(row['relname']) };
      const statsReset = resetMarker(row['stats_reset']);
      const counters: Record<string, unknown> = {
        table_tup_inserted: row['n_tup_ins'],
        table_tup_updated: row['n_tup_upd'],
        table_tup_deleted: row['n_tup_del'],
        // HOT: la actualización que no tocó ningún índice. La proporción sobre
        // el total de updates es el indicador más directo de si los índices
        // están encareciendo las escrituras.
        table_tup_hot_updated: row['n_tup_hot_upd'],
        table_seq_scans: row['seq_scan'],
        table_seq_tup_read: row['seq_tup_read'],
        table_idx_scans: row['idx_scan'],
        table_idx_tup_fetched: row['idx_tup_fetch'],
      };
      for (const [metric, raw] of Object.entries(counters)) {
        if (raw === null || raw === undefined) continue;
        samples.push({ metric, value: num(raw), labels, counter: true, statsReset });
      }
    }
    return samples;
  },
};

const tableSizes: MetricCollector = {
  id: 'table_sizes',
  tier: 'slow',
  description: 'Tablas más grandes de la base conectada, con las particiones sumadas en el padre',
  sql: (caps) => {
    // pg_partition_tree exists since PostgreSQL 12. Leaves are the relations
    // that actually store rows, so a monthly partition is not its own table.
    const sizeExpr =
      caps.versionNum >= 120_000
        ? `coalesce((
             select sum(pg_total_relation_size(t.relid))
               from pg_partition_tree(c.oid) t
              where t.isleaf
           ), 0)`
        : `pg_total_relation_size(c.oid) + coalesce((
             select sum(pg_total_relation_size(i.inhrelid))
               from pg_inherits i
              where i.inhparent = c.oid
           ), 0)`;
    const indexExpr =
      caps.versionNum >= 120_000
        ? `coalesce((
             select sum(pg_indexes_size(t.relid))
               from pg_partition_tree(c.oid) t
              where t.isleaf
           ), 0)`
        : `pg_indexes_size(c.oid) + coalesce((
             select sum(pg_indexes_size(i.inhrelid))
               from pg_inherits i
              where i.inhparent = c.oid
           ), 0)`;
    const partsExpr =
      caps.versionNum >= 120_000
        ? `(select count(*) from pg_partition_tree(c.oid) t where t.relid <> c.oid)`
        : `(select count(*) from pg_inherits i where i.inhparent = c.oid)`;
    return `
    select n.nspname as schema, c.relname as table,
           ${sizeExpr}  as total_bytes,
           ${indexExpr} as index_bytes,
           ${partsExpr} as partitions
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and not c.relispartition
       and n.nspname not in ('pg_catalog', 'information_schema')
     order by 3 desc
     limit 20`;
  },
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const parts = num(row['partitions']);
      const labels: Record<string, string> = { schema: str(row['schema']), table: str(row['table']) };
      if (parts > 1) labels['partitions'] = String(parts);
      samples.push({ metric: 'table_total_bytes', value: num(row['total_bytes']), labels });
      samples.push({ metric: 'table_index_bytes', value: num(row['index_bytes']), labels });
    }
    return samples;
  },
};

const replication: MetricCollector = {
  id: 'replication',
  tier: 'normal',
  description: 'Lag de standbys conectados',
  sql: () => `
    select coalesce(
             case
               when application_name in ('walreceiver', 'postgres', '') then null
               else nullif(application_name, '')
             end,
             nullif(client_hostname, ''),
             host(client_addr)::text,
             coalesce(nullif(application_name, ''), '(unnamed)')
           ) as standby_name,
           state,
           coalesce(extract(epoch from write_lag), 0)  as write_lag_seconds,
           coalesce(extract(epoch from flush_lag), 0)  as flush_lag_seconds,
           coalesce(extract(epoch from replay_lag), 0) as replay_lag_seconds
      from pg_stat_replication`,
  toSamples: (rows) => {
    const samples: Sample[] = [{ metric: 'replication_standbys', value: rows.length }];
    for (const row of rows) {
      const labels = { standby: str(row['standby_name']), state: str(row['state']) };
      samples.push({ metric: 'replication_write_lag_seconds', value: num(row['write_lag_seconds']), labels });
      samples.push({ metric: 'replication_flush_lag_seconds', value: num(row['flush_lag_seconds']), labels });
      samples.push({ metric: 'replication_replay_lag_seconds', value: num(row['replay_lag_seconds']), labels });
    }
    return samples;
  },
};

/**
 * Retraso visto desde el standby.
 *
 * `pg_stat_replication` sólo existe en el primario, y mide lo que el primario
 * cree que pasó. Desde el standby la pregunta es otra y más directa: cuánto
 * tiempo de datos me falta. `pg_last_xact_replay_timestamp()` la contesta, y es
 * la única fuente cuando el primario no se puede monitorear —el caso típico de
 * una réplica de lectura de un proveedor administrado.
 */
const replicationStandby: MetricCollector = {
  id: 'replication_standby',
  tier: 'normal',
  description: 'Retraso de recuperación medido desde el standby',
  appliesTo: (caps) => caps.inRecovery,
  sql: () => `
    select coalesce(extract(epoch from (now() - pg_last_xact_replay_timestamp())), 0) as replay_delay_seconds,
           pg_last_xact_replay_timestamp()                                            as last_replay_at,
           coalesce(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0) as pending_bytes,
           pg_is_wal_replay_paused()                                                  as replay_paused`,
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [];

    const samples: Sample[] = [
      { metric: 'standby_replay_delay_seconds', value: num(row['replay_delay_seconds']) },
      { metric: 'standby_pending_bytes', value: num(row['pending_bytes']) },
      { metric: 'standby_replay_paused', value: row['replay_paused'] === true ? 1 : 0 },
    ];

    // Sin actividad en el primario, el "retraso" crece aunque no falte nada por
    // aplicar. Los bytes pendientes son lo que distingue un standby atrasado de
    // uno al día en un sistema quieto, y por eso ambos se guardan.
    return samples;
  },
};

/**
 * Suscripciones lógicas vistas desde el suscriptor.
 *
 * Los slots viven en el publicador. Un servidor que sólo recibe (logical
 * replication) tiene `pg_stat_subscription` y cero slots: decir "no hay
 * réplica" es falso. `pid` vacío es el apply worker caído — el mismo síntoma
 * que "apply worker pid is empty".
 */
const logicalSubscriptions: MetricCollector = {
  id: 'logical_subscriptions',
  tier: 'normal',
  description: 'Suscripciones lógicas y si el apply worker está vivo',
  sql: () => `
    select subname,
           bool_or(pid is not null) as worker_up,
           max(latest_end_time) as latest_end_time,
           max(pg_wal_lsn_diff(received_lsn, latest_end_lsn))
             filter (where received_lsn is not null and latest_end_lsn is not null) as pending_bytes
      from pg_stat_subscription
     group by subname`,
  toSamples: (rows) => {
    const samples: Sample[] = [{ metric: 'replication_subscriptions_total', value: rows.length }];
    for (const row of rows) {
      const labels = { subscription: str(row['subname']) };
      const up = row['worker_up'] === true;
      samples.push({ metric: 'replication_subscription_worker', value: up ? 1 : 0, labels });
      const pending = row['pending_bytes'];
      const pendingBytes = pending === null || pending === undefined ? null : num(pending);
      if (pendingBytes !== null) {
        samples.push({
          metric: 'replication_subscription_pending_bytes',
          value: Math.max(0, pendingBytes),
          labels,
        });
      }
      // Caught up means the apply LSN has reached the received LSN. Clock
      // distance from latest_end_time grows on an idle publisher and is not lag.
      if (pendingBytes === 0) {
        samples.push({ metric: 'replication_subscription_lag_seconds', value: 0, labels });
        continue;
      }
      if (pendingBytes !== null && pendingBytes > 0) {
        const ended = row['latest_end_time'];
        const at = ended instanceof Date ? ended : ended ? new Date(String(ended)) : null;
        if (at && !Number.isNaN(at.getTime())) {
          samples.push({
            metric: 'replication_subscription_lag_seconds',
            value: Math.max(0, (Date.now() - at.getTime()) / 1000),
            labels,
          });
        }
      }
    }
    return samples;
  },
};

const replicationSlots: MetricCollector = {
  id: 'replication_slots',
  tier: 'normal',
  description: 'Estado de los slots (un slot inactivo puede llenar el disco)',
  sql: () => `
    select slot_name, slot_type, active, coalesce(wal_status, 'unknown') as wal_status,
           coalesce(safe_wal_size, 0) as safe_wal_size
      from pg_replication_slots`,
  toSamples: (rows) => {
    const samples: Sample[] = [{ metric: 'replication_slots_total', value: rows.length }];
    for (const row of rows) {
      const labels = {
        slot: str(row['slot_name']),
        slot_type: str(row['slot_type']),
        wal_status: str(row['wal_status']),
      };
      samples.push({ metric: 'replication_slot_active', value: row['active'] ? 1 : 0, labels });
      samples.push({ metric: 'replication_slot_safe_wal_size_bytes', value: num(row['safe_wal_size']), labels });
    }
    return samples;
  },
};

/**
 * PG18 eliminó wal_write, wal_sync, wal_write_time y wal_sync_time de
 * pg_stat_wal (esos datos ahora salen de pg_stat_io), así que sólo se piden
 * las columnas estables entre PG14 y PG18.
 */
const wal: MetricCollector = {
  id: 'wal',
  tier: 'normal',
  description: 'Generación de WAL',
  appliesTo: (caps) => caps.hasStatWal,
  sql: () => `select wal_records, wal_fpi, wal_bytes, wal_buffers_full, stats_reset from pg_stat_wal`,
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const statsReset = resetMarker(row['stats_reset']);
    return (['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full'] as const).map((column) => ({
      metric: column,
      value: num(row[column]),
      counter: true,
      statsReset,
    }));
  },
};

/**
 * PG17 movió las estadísticas de checkpoint de pg_stat_bgwriter a
 * pg_stat_checkpointer. El mismo colector sirve para las dos formas.
 */
const checkpointer: MetricCollector = {
  id: 'checkpointer',
  tier: 'normal',
  description: 'Checkpoints y buffers escritos',
  sql: (caps) =>
    caps.hasStatCheckpointer
      ? `select num_timed, num_requested, write_time, sync_time, buffers_written, stats_reset
           from pg_stat_checkpointer`
      : `select checkpoints_timed     as num_timed,
                checkpoints_req       as num_requested,
                checkpoint_write_time as write_time,
                checkpoint_sync_time  as sync_time,
                buffers_checkpoint    as buffers_written,
                stats_reset
           from pg_stat_bgwriter`,
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const statsReset = resetMarker(row['stats_reset']);
    return (['num_timed', 'num_requested', 'write_time', 'sync_time', 'buffers_written'] as const).map((column) => ({
      metric: `checkpoint_${column}`,
      value: num(row[column]),
      counter: true,
      statsReset,
    }));
  },
};

/**
 * pg_stat_io devuelve NULL en las columnas que no aplican a cada combinación de
 * backend_type y context, así que todo pasa por num() antes de guardarse.
 */
const io: MetricCollector = {
  id: 'io',
  tier: 'normal',
  description: 'I/O por tipo de backend y contexto',
  appliesTo: (caps) => caps.hasStatIo,
  sql: () => `
    select backend_type, object, context,
           coalesce(reads, 0) as reads, coalesce(writes, 0) as writes,
           coalesce(hits, 0) as hits, coalesce(evictions, 0) as evictions,
           coalesce(fsyncs, 0) as fsyncs, stats_reset
      from pg_stat_io
     where coalesce(reads, 0) + coalesce(writes, 0) + coalesce(hits, 0) > 0`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = {
        backend_type: str(row['backend_type']),
        object: str(row['object']),
        context: str(row['context']),
      };
      const statsReset = resetMarker(row['stats_reset']);
      for (const column of ['reads', 'writes', 'hits', 'evictions', 'fsyncs'] as const) {
        samples.push({ metric: `io_${column}`, value: num(row[column]), labels, counter: true, statsReset });
      }
    }
    return samples;
  },
};

export const COLLECTORS: MetricCollector[] = [
  availability,
  connections,
  waitEvents,
  blocking,
  databaseStats,
  databaseSizes,
  wraparound,
  deadTuples,
  tableActivity,
  tableSizes,
  replication,
  replicationStandby,
  replicationSlots,
  logicalSubscriptions,
  wal,
  checkpointer,
  io,
];

export function collectorsFor(caps: Capabilities, tier?: string): MetricCollector[] {
  return COLLECTORS.filter(
    (collector) => (!tier || collector.tier === tier) && (!collector.appliesTo || collector.appliesTo(caps)),
  );
}
