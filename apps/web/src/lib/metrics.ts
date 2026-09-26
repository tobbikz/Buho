import type { Unit } from '@/components/TimeseriesPanel';

/**
 * Catálogo de métricas para la pantalla de Análisis.
 *
 * El store guarda 93 series distintas por instancia. Un selector con 93 nombres
 * crudos tipo `db_tup_hot_updated_per_sec` no es un selector, es un examen. Acá
 * cada métrica recibe familia, nombre legible y **unidad**, que es el dato que
 * evita el error clásico de graficar sessions y segundos en el mismo eje.
 *
 * La unidad y la familia se derivan del nombre por convención (`_pct`,
 * `_per_sec`, `_bytes`, `_seconds`) y sólo se listan a mano las excepciones. Así
 * una métrica nueva del colector aparece con sentido sin tocar este archivo.
 */

export interface MetricMeta {
  metric: string;
  label: string;
  family: string;
  unit: Unit;
  /** Etiquetas por las que se puede desglosar, en orden de utilidad. */
  labelKeys: string[];
  /** Agregación por defecto entre etiquetas: los ratios never se suman. */
  defaultAgg: 'sum' | 'avg' | 'min' | 'max';
  /** true = acumulado desde el arranque; casi siempre se quiere la tasa. */
  cumulative: boolean;
}

const FAMILIES: { prefix: string; family: string; labelKeys: string[] }[] = [
  { prefix: 'host_', family: 'Host', labelKeys: ['mount'] },
  { prefix: 'connections_', family: 'Connections', labelKeys: [] },
  { prefix: 'mongo_', family: 'MongoDB', labelKeys: ['database'] },
  { prefix: 'redis_', family: 'Redis', labelKeys: ['database'] },
  { prefix: 'oracle_', family: 'Oracle', labelKeys: ['database'] },
  { prefix: 'cassandra_', family: 'Cassandra', labelKeys: ['database', 'pool', 'cache'] },
  { prefix: 'es_', family: 'Elasticsearch', labelKeys: ['node', 'database'] },
  { prefix: 'buffer_pool_', family: 'InnoDB / buffer', labelKeys: [] },
  { prefix: 'innodb_', family: 'InnoDB / buffer', labelKeys: [] },
  { prefix: 'page_life_', family: 'SQL Server', labelKeys: [] },
  { prefix: 'file_', family: 'SQL Server', labelKeys: ['database', 'file'] },
  { prefix: 'mssql_', family: 'SQL Server', labelKeys: [] },
  { prefix: 'memory_grants_', family: 'SQL Server', labelKeys: [] },
  { prefix: 'queries_', family: 'Activity', labelKeys: [] },
  { prefix: 'binlog_', family: 'Replication', labelKeys: [] },
  { prefix: 'replica_', family: 'Replication', labelKeys: [] },
  { prefix: 'db_', family: 'Database', labelKeys: ['database'] },
  { prefix: 'database_', family: 'Database', labelKeys: ['database'] },
  { prefix: 'xid_', family: 'Database', labelKeys: ['database'] },
  { prefix: 'wal_', family: 'WAL', labelKeys: [] },
  { prefix: 'checkpoint_', family: 'Checkpoints', labelKeys: [] },
  { prefix: 'io_', family: 'I/O', labelKeys: ['backend_type', 'context', 'object'] },
  { prefix: 'table_', family: 'Tables', labelKeys: ['schema', 'table'] },
  { prefix: 'wait_event_', family: 'Waits', labelKeys: ['wait_event_type', 'wait_event'] },
  { prefix: 'replication_', family: 'Replication', labelKeys: [] },
];

/** Nombres que la convención no puede adivinar bien. */
const LABELS: Record<string, string> = {
  blocked_sessions: 'Blocked sessions',
  max_blocked_seconds: 'Max lock wait',
  oldest_xact_seconds: 'Oldest open transaction',
  longest_active_query_seconds: 'Longest active query',
  longest_idle_in_tx_seconds: 'Longest idle in transaction',
  probe_latency_ms: 'Probe latency',
  uptime_seconds: 'Uptime',
  connections_used_pct: 'Connections used',
  connections_max: 'max_connections',
  connections_total: 'Total connections',
  connections_active: 'Active connections',
  connections_idle: 'Idle connections',
  connections_idle_in_transaction: 'Idle-in-transaction connections',
  connections_idle_in_transaction_aborted: 'Idle-in-transaction connections (aborted)',
  db_cache_hit_pct: 'Cache hit',
  db_backends: 'Connected sessions',
  db_conflicts: 'Recovery conflicts',
  db_deadlocks: 'Deadlocks',
  db_tup_inserted: 'Tuples inserted',
  db_tup_updated: 'Tuples updated',
  db_tup_deleted: 'Tuples deleted',
  db_blks_hit: 'Blocks from cache',
  db_blks_read: 'Blocks read from disk',
  db_tup_returned: 'Tuples returned by scans',
  db_tup_fetched: 'Tuples fetched',
  db_xact_commit: 'Commits',
  db_xact_rollback: 'Rollbacks',
  db_temp_bytes: 'Temp file bytes',
  db_temp_files: 'Temp files',
  database_size_bytes: 'Database size',
  mongo_op_insert: 'Ops insert',
  mongo_op_query: 'Ops query',
  mongo_op_update: 'Ops update',
  mongo_op_delete: 'Ops delete',
  mongo_op_getmore: 'Ops getmore',
  mongo_op_command: 'Ops command',
  mongo_mem_resident_mb: 'Resident RAM (MB)',
  mongo_mem_virtual_mb: 'Virtual RAM (MB)',
  mongo_cursors_open: 'Open cursors',
  mongo_net_in_bytes: 'Network in',
  mongo_net_out_bytes: 'Network out',
  mongo_data_size_bytes: 'Mongo data',
  mongo_index_size_bytes: 'Mongo indexes',
  mongo_collections: 'Collections',
  mongo_objects: 'Documents',
  mongo_repl_members: 'Replica set members',
  mongo_repl_state: 'Replica state',
  mongo_wt_cache_used_pct: 'WiredTiger cache used',
  mongo_wt_cache_used_bytes: 'WiredTiger cache bytes',
  mongo_wt_cache_max_bytes: 'WiredTiger cache max',
  mongo_tickets_read_used_pct: 'Read tickets used',
  mongo_tickets_write_used_pct: 'Write tickets used',
  mongo_tickets_read_out: 'Read tickets out',
  mongo_tickets_write_out: 'Write tickets out',
  mongo_global_lock_queue: 'Global lock queue',
  mongo_global_lock_readers: 'Global lock readers queued',
  mongo_global_lock_writers: 'Global lock writers queued',
  mongo_active_clients: 'Active clients',
  mongo_ops_active: 'Active ops',
  mongo_ops_waiting_lock: 'Ops waiting lock',
  mongo_ops_slow: 'Slow ops (≥1s)',
  redis_instantaneous_ops: 'Redis ops/s',
  redis_used_memory_bytes: 'Redis memory',
  redis_keys_total: 'Redis keys',
  redis_blocked_clients: 'Redis blocked clients',
  oracle_execute_count: 'Oracle executes',
  oracle_sga_bytes: 'Oracle SGA',
  oracle_pga_bytes: 'Oracle PGA',
  oracle_user_commits: 'Oracle commits',
  cassandra_clients: 'Cassandra clients',
  cassandra_pools_active: 'Cassandra pool active',
  cassandra_pools_pending: 'Cassandra pool pending',
  cassandra_cluster_nodes: 'Cassandra nodes',
  cassandra_sstable_tasks: 'Cassandra SSTable tasks',
  cassandra_total_data_bytes: 'Cassandra data bytes',
  es_cluster_status: 'ES cluster status',
  es_unassigned_shards: 'ES unassigned shards',
  es_jvm_heap_used_pct_avg: 'ES JVM heap %',
  es_store_bytes: 'ES store bytes',
  es_docs_count: 'ES docs',
  es_search_query_total: 'ES search queries',
  es_indexing_index_total: 'ES index ops',
  mongo_ops_longest_seconds: 'Longest op (s)',
  mongo_asserts_regular: 'Asserts regular',
  mongo_asserts_warning: 'Asserts warning',
  mongo_asserts_msg: 'Asserts msg',
  mongo_asserts_user: 'Asserts user',
  mongo_scanned_objects: 'Scanned objects',
  mongo_scanned_keys: 'Scanned index keys',
  mongo_ns_total_time: 'Namespace time',
  innodb_history_list_length: 'InnoDB history list length',
  threads_running: 'Threads running',
  worker_threads_current: 'Worker threads (current)',
  worker_threads_active: 'Worker threads (active)',
  worker_work_queue: 'Worker work queue',
  worker_max_load_factor: 'Scheduler max load factor',
  worker_schedulers_online: 'Online schedulers',
  buffer_pool_dirty_pct: 'Buffer pool dirty',
  buffer_pool_free_pct: 'Buffer pool free',
  page_life_expectancy_seconds: 'Page life expectancy',
  memory_grants_pending: 'Memory grants pending',
  aborted_connects: 'Aborted connects',
  aborted_clients: 'Aborted clients',
  logins: 'Logins',
  logouts: 'Logouts',
  mssql_process_memory_bytes: 'SQL Server process memory',
  mssql_process_memory_pct: 'SQL Server process memory',
  mssql_server_memory_pct: 'SQL Server buffer vs target',
  mssql_low_memory_signal: 'SQL Server low-memory signal',
  mssql_cpu_ms: 'SQL Server CPU time',
  host_cpu_count: 'CPU cores',
  total_server_memory_bytes: 'SQL Server total memory',
  target_server_memory_bytes: 'SQL Server target memory',
  write_transactions: 'Write transactions',
  sql_recompilations: 'SQL recompilations',
  pages_written: 'Pages written',
  lazy_writes: 'Lazy writes',
  lock_timeouts: 'Lock timeouts',
  lock_wait_time_ms: 'Lock wait time',
  page_splits: 'Page splits',
  index_searches: 'Index searches',
  workfiles_created: 'Workfiles created',
  worktables_created: 'Worktables created',
  temp_tables_created: 'Temp tables created',
  log_flush_waits: 'Log flush waits',
  log_growths: 'Log growths',
  log_shrinks: 'Log shrinks',
  slow_queries: 'Slow queries',
  slow_digest_count: 'Slow digests',
  mariadb_memory_used_bytes: 'MariaDB memory used',
  mariadb_memory_growth_bytes: 'MariaDB memory growth',
  buffer_pool_data_bytes: 'Buffer pool data',
  buffer_pool_dirty_bytes: 'Buffer pool dirty',
  connections_by_user: 'Connections by user',
  ps_wait_ms: 'P_S wait time',
  ps_wait_count: 'P_S wait count',
  ps_table_io_ops: 'P_S table I/O ops',
  ps_table_io_ms: 'P_S table I/O time',
  ps_stage_ms: 'P_S stage time',
  ps_stage_count: 'P_S stage count',
  rg_active_requests: 'RG active requests',
  rg_total_requests: 'RG total requests',
  rg_cpu_ms: 'RG CPU ms',
  rg_reduced_memgrant: 'RG reduced mem grants',
  xid_age: 'XID age',
  xid_age_pct: 'XID age vs limit',
  wal_bytes: 'WAL generated',
  wal_fpi: 'Full page images',
  wal_buffers_full: 'WAL buffers full',
  wal_records: 'WAL records',
  checkpoint_num_timed: 'Timed checkpoints',
  checkpoint_num_requested: 'Requested checkpoints',
  checkpoint_buffers_written: 'Buffers written by checkpoint',
  checkpoint_write_time: 'Checkpoint write time',
  checkpoint_sync_time: 'Checkpoint sync time',
  table_dead_pct: 'Dead tuples (%)',
  table_dead_tuples: 'Dead tuples',
  table_live_tuples: 'Live tuples',
  table_total_bytes: 'Total table size',
  table_index_bytes: 'Index size',
  table_seconds_since_vacuum: 'Time since last vacuum',
  wait_event_sessions: 'Waiting sessions',
  wait_event_ms: 'Wait time (ms)',
  replication_slots_total: 'Replication slots',
  replication_subscriptions_total: 'Logical subscriptions',
  replication_subscription_worker: 'Subscription apply worker',
  replication_subscription_lag_seconds: 'Subscription apply lag',
  replication_standbys: 'Connected standbys',
  host_cpu_pct: 'Host CPU',
  host_cpu_iowait_pct: 'CPU waiting on I/O',
  host_cpu_steal_pct: 'CPU stolen by hypervisor',
  host_mem_used_pct: 'Memory used',
  host_mem_available_bytes: 'Memory available',
  host_mem_total_bytes: 'Total memory',
  host_swap_used_pct: 'Swap used',
  host_load1_per_core: 'Load per core',
  host_cores: 'Cores',
  host_disk_used_pct: 'Disk used',
  host_disk_free_bytes: 'Disk free',
  io_hits: 'I/O cache hits',
  io_reads: 'Reads',
  io_writes: 'Writes',
  io_evictions: 'Evictions',
  io_fsyncs: 'fsyncs',
  file_read_latency_ms: 'File read latency',
  file_write_latency_ms: 'File write latency',
  queries_total: 'Queries / batch requests',
  lock_waits: 'Lock waits',
  full_scans: 'Full scans',
  sql_compilations: 'SQL compilations',
  innodb_row_lock_waits: 'InnoDB row lock waits',
  binlog_bytes: 'Binlog bytes',
  replica_seconds_behind: 'Replica lag',
};

const WORDS: Record<string, string> = {
  tup: 'tuples',
  xact: 'transactions',
  blks: 'blocks',
  db: 'database',
  io: 'I/O',
  wal: 'WAL',
  fpi: 'full page images',
  pct: '%',
};

function humanize(metric: string): string {
  const words = metric.split('_').map((word) => WORDS[word] ?? word);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Una tasa hereda el nombre de su contador. Sin esto, `db_tup_inserted` se
 * llamaba "Tuplas insertadas" y su tasa quedaba como "Base tuplas inserted":
 * dos nombres distintos para la misma cosa, y el feo justo en la métrica que
 * más se grafica.
 */
function labelFor(metric: string): string {
  const explicit = LABELS[metric];
  if (explicit) return explicit;

  if (metric.endsWith('_per_sec')) {
    const base = metric.slice(0, -'_per_sec'.length);
    return `${LABELS[base] ?? humanize(base)} per second`;
  }
  return humanize(metric);
}

function unitOf(metric: string): Unit {
  if (metric.endsWith('_pct')) return 'pct';
  if (metric.endsWith('_bytes_per_sec')) return 'bytes';
  if (metric.endsWith('_bytes')) return 'bytes';
  if (metric.endsWith('_per_sec')) return 'rate';
  if (metric.endsWith('_seconds') || metric.endsWith('_seconds_since_vacuum')) return 'seconds';
  if (metric.endsWith('_ms')) return 'count';
  // Los tiempos acumulados de checkpoint vienen en milisegundos.
  if (metric.startsWith('checkpoint_') && metric.includes('_time')) return 'count';
  return 'count';
}

/**
 * Ratios donde **más es mejor**. La distinción importa: el worst case de un
 * porcentaje no es siempre el min. Con 99 % y 80 % de cache hit en dos bases,
 * el worst case es 80 (el min); con 5 % y 40 % de tuplas muertas, es 40 (el
 * max). Tratar a todos los porcentajes igual esconde justo el problema que se
 * está buscando.
 */
const HIGHER_IS_BETTER = new Set(['db_cache_hit_pct']);

function defaultAggFor(metric: string, unit: Unit): MetricMeta['defaultAgg'] {
  // Sumar porcentajes entre etiquetas da 397 %: el error ya ocurrió una vez.
  if (unit === 'pct') return HIGHER_IS_BETTER.has(metric) ? 'min' : 'max';
  // Edades y esperas: la suma no significa nada, el max es el síntoma.
  if (unit === 'seconds' || metric.startsWith('xid_age') || metric.endsWith('_ms')) return 'max';
  return 'sum';
}

export function describeMetric(metric: string, labelKeys: string[] = []): MetricMeta {
  const match = FAMILIES.find((entry) => metric.startsWith(entry.prefix));
  const unit = unitOf(metric);
  const isRate = metric.endsWith('_per_sec');

  return {
    metric,
    label: labelFor(metric),
    family: match?.family ?? 'Activity',
    unit,
    // Se prefieren las etiquetas que existen de verdad en el store; el catálogo
    // sólo aporta el orden.
    labelKeys:
      labelKeys.length > 0
        ? [...(match?.labelKeys ?? [])].filter((key) => labelKeys.includes(key)).concat(
            labelKeys.filter((key) => !(match?.labelKeys ?? []).includes(key)),
          )
        : [],
    defaultAgg: defaultAggFor(metric, unit),
    cumulative: !isRate && !metric.endsWith('_pct') && CUMULATIVE.has(metric),
  };
}

/**
 * Contadores acumulados desde el arranque del servidor. La UI ofrece su versión
 * `_per_sec` en su lugar: graficar el acumulado da una recta que sólo dice que
 * el servidor sigue vivo.
 */
const CUMULATIVE = new Set<string>();
for (const base of [
  'db_blks_hit',
  'db_blks_read',
  'db_conflicts',
  'db_deadlocks',
  'db_temp_bytes',
  'db_temp_files',
  'db_tup_deleted',
  'db_tup_fetched',
  'db_tup_inserted',
  'db_tup_returned',
  'db_tup_updated',
  'db_xact_commit',
  'db_xact_rollback',
  'wal_bytes',
  'wal_fpi',
  'wal_records',
  'wal_buffers_full',
  'checkpoint_num_timed',
  'checkpoint_num_requested',
  'checkpoint_buffers_written',
  'checkpoint_write_time',
  'checkpoint_sync_time',
  'io_hits',
  'io_reads',
  'io_writes',
  'io_evictions',
  'io_fsyncs',
  // SQL Server counters (dm_os_performance_counters · cntr_type acumulado)
  'queries_total',
  'write_transactions',
  'sql_compilations',
  'sql_recompilations',
  'pages_written',
  'lazy_writes',
  'logins',
  'logouts',
  'lock_waits',
  'lock_timeouts',
  'full_scans',
  'index_searches',
  'page_splits',
  'workfiles_created',
  'worktables_created',
  'temp_tables_created',
  'log_flush_waits',
  'aborted_connects',
  'aborted_clients',
  'innodb_row_lock_waits',
]) {
  CUMULATIVE.add(base);
}

export const FAMILY_ORDER = [
  'Host',
  'Connections',
  'Activity',
  'Database',
  'SQL Server',
  'InnoDB / buffer',
  'WAL',
  'Checkpoints',
  'I/O',
  'Tables',
  'Waits',
  'Replication',
  'MongoDB',
];

/** Punto de partida cuando se entra sin métricas elegidas (PostgreSQL / host). */
export const DEFAULT_METRICS = ['host_cpu_pct', 'connections_active'];

/** Defaults per engine so Analysis is useful without host metrics. */
export function defaultMetricsForEngine(engine: string): string[] {
  switch (engine) {
    case 'mssql':
      return [
        'host_cpu_pct',
        'host_mem_used_pct',
        'queries_total_per_sec',
        'db_xact_commit_per_sec',
        'page_life_expectancy_seconds',
        'lock_waits_per_sec',
      ];
    case 'mariadb':
      return ['db_cache_hit_pct', 'connections_active', 'buffer_pool_dirty_pct', 'queries_total_per_sec'];
    case 'mongodb':
      return [
        'mongo_op_query',
        'mongo_mem_resident_mb',
        'connections_active',
        'mongo_wt_cache_used_pct',
        'mongo_ops_active',
        'mongo_ops_slow',
        'replication_lag_seconds',
      ];
    case 'redis':
      return [
        'redis_instantaneous_ops',
        'redis_used_memory_bytes',
        'connections_total',
        'db_cache_hit_pct',
        'redis_keys_total',
        'redis_blocked_clients',
      ];
    case 'oracle':
      return [
        'connections_active',
        'oracle_execute_count_per_sec',
        'db_cache_hit_pct',
        'oracle_sga_bytes',
        'blocked_sessions',
        'oracle_physical_reads_per_sec',
      ];
    case 'cassandra':
      return [
        'connections_total',
        'cassandra_pools_active',
        'cassandra_pools_pending',
        'db_cache_hit_pct',
        'cassandra_cluster_nodes',
        'cassandra_sstable_tasks',
      ];
    case 'elasticsearch':
      return [
        'es_cluster_status',
        'es_jvm_heap_used_pct_avg',
        'es_unassigned_shards',
        'es_store_bytes',
        'es_search_query_total_per_sec',
        'connections_total',
      ];
    default:
      return DEFAULT_METRICS;
  }
}

/**
 * Paleta estable por posición: el color de una serie no debe cambiar al agregar
 * otra métrica, o la comparación entre dos capturas de pantalla miente.
 */
export const SERIES_COLORS = [
  '#005eb8',
  '#0a6e42',
  '#9a4a00',
  '#b01818',
  '#6b3fa0',
  '#00707f',
  '#8a6d00',
  '#c2185b',
];
