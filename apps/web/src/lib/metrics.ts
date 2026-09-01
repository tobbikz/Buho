import type { Unit } from '@/components/TimeseriesPanel';

/**
 * Catálogo de métricas para la pantalla de Análisis.
 *
 * El store guarda 93 series distintas por instancia. Un selector con 93 nombres
 * crudos tipo `db_tup_hot_updated_per_sec` no es un selector, es un examen. Acá
 * cada métrica recibe familia, nombre legible y **unidad**, que es el dato que
 * evita el error clásico de graficar sesiones y segundos en el mismo eje.
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
  /** Agregación por defecto entre etiquetas: los ratios nunca se suman. */
  defaultAgg: 'sum' | 'avg' | 'min' | 'max';
  /** true = acumulado desde el arranque; casi siempre se quiere la tasa. */
  cumulative: boolean;
}

const FAMILIES: { prefix: string; family: string; labelKeys: string[] }[] = [
  { prefix: 'host_', family: 'Host', labelKeys: ['mount'] },
  { prefix: 'connections_', family: 'Conexiones', labelKeys: [] },
  { prefix: 'mongo_', family: 'MongoDB', labelKeys: ['database'] },
  { prefix: 'db_', family: 'Base de datos', labelKeys: ['database'] },
  { prefix: 'database_', family: 'Base de datos', labelKeys: ['database'] },
  { prefix: 'xid_', family: 'Base de datos', labelKeys: ['database'] },
  { prefix: 'wal_', family: 'WAL', labelKeys: [] },
  { prefix: 'checkpoint_', family: 'Checkpoints', labelKeys: [] },
  { prefix: 'io_', family: 'I/O', labelKeys: ['backend_type', 'context', 'object'] },
  { prefix: 'table_', family: 'Tablas', labelKeys: ['schema', 'table'] },
  { prefix: 'wait_event_', family: 'Esperas', labelKeys: ['wait_event_type', 'wait_event'] },
  { prefix: 'replication_', family: 'Replicación', labelKeys: [] },
];

/** Nombres que la convención no puede adivinar bien. */
const LABELS: Record<string, string> = {
  blocked_sessions: 'Sesiones bloqueadas',
  max_blocked_seconds: 'Espera máxima por bloqueo',
  oldest_xact_seconds: 'Transacción abierta más vieja',
  longest_active_query_seconds: 'Consulta activa más larga',
  longest_idle_in_tx_seconds: 'Idle in transaction más largo',
  probe_latency_ms: 'Latencia del sondeo',
  uptime_seconds: 'Uptime',
  connections_used_pct: 'Conexiones usadas',
  connections_max: 'max_connections',
  connections_total: 'Conexiones totales',
  connections_active: 'Conexiones activas',
  connections_idle: 'Conexiones inactivas (idle)',
  connections_idle_in_transaction: 'Conexiones idle in transaction',
  connections_idle_in_transaction_aborted: 'Conexiones idle in transaction (abortadas)',
  db_cache_hit_pct: 'Cache hit',
  db_backends: 'Sesiones conectadas',
  db_conflicts: 'Conflictos de recuperación',
  db_deadlocks: 'Deadlocks',
  db_tup_inserted: 'Tuplas insertadas',
  db_tup_updated: 'Tuplas modificadas',
  db_tup_deleted: 'Tuplas borradas',
  db_blks_hit: 'Bloques desde caché',
  db_blks_read: 'Bloques leídos de disco',
  db_tup_returned: 'Tuplas devueltas por scans',
  db_tup_fetched: 'Tuplas obtenidas',
  db_xact_commit: 'Commits',
  db_xact_rollback: 'Rollbacks',
  db_temp_bytes: 'Bytes en archivos temporales',
  db_temp_files: 'Archivos temporales',
  database_size_bytes: 'Tamaño de la base',
  mongo_op_insert: 'Ops insert',
  mongo_op_query: 'Ops query',
  mongo_op_update: 'Ops update',
  mongo_op_delete: 'Ops delete',
  mongo_op_getmore: 'Ops getmore',
  mongo_op_command: 'Ops command',
  mongo_mem_resident_mb: 'RAM residente (MB)',
  mongo_mem_virtual_mb: 'RAM virtual (MB)',
  mongo_cursors_open: 'Cursores abiertos',
  mongo_net_in_bytes: 'Red entrante',
  mongo_net_out_bytes: 'Red saliente',
  mongo_data_size_bytes: 'Datos Mongo',
  mongo_index_size_bytes: 'Índices Mongo',
  mongo_collections: 'Colecciones',
  mongo_objects: 'Documentos',
  mongo_repl_members: 'Miembros del replica set',
  mongo_repl_state: 'Estado de réplica',
  xid_age: 'Edad del XID',
  xid_age_pct: 'Edad del XID sobre el límite',
  wal_bytes: 'WAL generado',
  wal_fpi: 'Full page images',
  wal_buffers_full: 'Buffers de WAL llenos',
  wal_records: 'Registros de WAL',
  checkpoint_num_timed: 'Checkpoints programados',
  checkpoint_num_requested: 'Checkpoints forzados',
  checkpoint_buffers_written: 'Buffers escritos por checkpoint',
  checkpoint_write_time: 'Tiempo de escritura de checkpoint',
  checkpoint_sync_time: 'Tiempo de sync de checkpoint',
  table_dead_pct: 'Tuplas muertas (%)',
  table_dead_tuples: 'Tuplas muertas',
  table_live_tuples: 'Tuplas vivas',
  table_total_bytes: 'Tamaño total de tabla',
  table_index_bytes: 'Tamaño de índices',
  table_seconds_since_vacuum: 'Tiempo desde el último vacuum',
  wait_event_sessions: 'Sesiones esperando',
  replication_slots_total: 'Slots de replicación',
  replication_standbys: 'Standbys conectados',
  host_cpu_pct: 'CPU del host',
  host_cpu_iowait_pct: 'CPU esperando I/O',
  host_cpu_steal_pct: 'CPU robada por el hipervisor',
  host_mem_used_pct: 'Memoria usada',
  host_mem_available_bytes: 'Memoria disponible',
  host_mem_total_bytes: 'Memoria total',
  host_swap_used_pct: 'Swap usado',
  host_load1_per_core: 'Carga por núcleo',
  host_cores: 'Núcleos',
  host_disk_used_pct: 'Disco usado',
  host_disk_free_bytes: 'Disco libre',
  io_hits: 'Aciertos de caché de I/O',
  io_reads: 'Lecturas',
  io_writes: 'Escrituras',
  io_evictions: 'Evictions',
  io_fsyncs: 'fsyncs',
};

const WORDS: Record<string, string> = {
  tup: 'tuplas',
  xact: 'transacciones',
  blks: 'bloques',
  db: 'base',
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
    return `${LABELS[base] ?? humanize(base)} por segundo`;
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
 * Ratios donde **más es mejor**. La distinción importa: el peor caso de un
 * porcentaje no es siempre el mínimo. Con 99 % y 80 % de cache hit en dos bases,
 * el peor caso es 80 (el mínimo); con 5 % y 40 % de tuplas muertas, es 40 (el
 * máximo). Tratar a todos los porcentajes igual esconde justo el problema que se
 * está buscando.
 */
const HIGHER_IS_BETTER = new Set(['db_cache_hit_pct']);

function defaultAggFor(metric: string, unit: Unit): MetricMeta['defaultAgg'] {
  // Sumar porcentajes entre etiquetas da 397 %: el error ya ocurrió una vez.
  if (unit === 'pct') return HIGHER_IS_BETTER.has(metric) ? 'min' : 'max';
  // Edades y esperas: la suma no significa nada, el máximo es el síntoma.
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
    family: match?.family ?? 'Actividad',
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
  'Conexiones',
  'Actividad',
  'Base de datos',
  'WAL',
  'Checkpoints',
  'I/O',
  'Tablas',
  'Esperas',
  'Replicación',
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
