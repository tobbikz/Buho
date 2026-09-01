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
  replication_slots_total: 'Replication slots',
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
]) {
  CUMULATIVE.add(base);
}

export const FAMILY_ORDER = [
  'Host',
  'Connections',
  'Activity',
  'Database',
  'WAL',
  'Checkpoints',
  'I/O',
  'Tables',
  'Waits',
  'Replication',
];

/** Punto de partida cuando se entra sin métricas elegidas. */
export const DEFAULT_METRICS = ['host_cpu_pct', 'connections_active'];

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
