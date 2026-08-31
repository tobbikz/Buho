import type { Pool } from 'pg';
import type { Capabilities, Sample } from './types';
import { tagged } from './tag';

/**
 * Estado de vacuum y estimación de bloat.
 *
 * Las tuplas muertas ya se muestrean como métrica, pero una serie de tiempo no
 * contesta las preguntas que hace un DBA cuando una tabla va mal: ¿cuándo pasó
 * el autovacuum por última vez, cuánto falta para que se dispare solo, y cuánto
 * espacio hay tirado? Eso es tabular y con marcas de tiempo, no una curva.
 *
 * Del bloat hay que decir una cosa por delante: sin `pgstattuple` no se mide,
 * se estima. La estimación compara las páginas que la tabla ocupa contra las
 * que necesitaría según el ancho promedio de sus columnas. Sirve para ordenar
 * de peor a mejor y para descartar, pero no es un número exacto, y se presenta
 * como lo que es.
 */

export interface VacuumTable {
  schema: string;
  table: string;
  liveTuples: number;
  deadTuples: number;
  deadPct: number | null;
  lastAutovacuum: Date | null;
  lastVacuum: Date | null;
  lastAutoanalyze: Date | null;
  lastAnalyze: Date | null;
  autovacuumCount: number;
  analyzeCount: number;
  /** Tuplas muertas necesarias para que el autovacuum se dispare solo. */
  threshold: number | null;
  /** Cuántas tuplas muertas faltan. Negativo: ya debería estar corriendo. */
  remaining: number | null;
  autovacuumEnabled: boolean;
  sizeBytes: number;
  /** Sólo el heap. El porcentaje de bloat se calcula sobre esto y no sobre el
   *  total, porque la estimación no dice nada de los índices ni del TOAST. */
  heapBytes: number;
  /** Espacio estimado desperdiciado. Nulo si la tabla no tiene estadísticas. */
  bloatBytes: number | null;
  bloatPct: number | null;
  /** Por qué no se pudo estimar, cuando no se pudo. */
  bloatNote: string | null;
}

export interface VacuumProgress {
  pid: number;
  schema: string;
  table: string;
  phase: string;
  kind: 'vacuum' | 'analyze';
  heapBlksTotal: number | null;
  heapBlksScanned: number | null;
  heapBlksVacuumed: number | null;
  indexVacuumCount: number | null;
  deadTupleBytes: number | null;
  maxDeadTupleBytes: number | null;
  startedAt: Date | null;
  /** Avance sobre el heap, la única fase con progreso medible. */
  progressPct: number | null;
}

export interface VacuumSnapshot {
  tables: VacuumTable[];
  progress: VacuumProgress[];
}

const VACUUM_SQL = `
with ajustes as (
  select
    (select setting::numeric from pg_settings where name = 'autovacuum_vacuum_threshold')     as base,
    (select setting::numeric from pg_settings where name = 'autovacuum_vacuum_scale_factor') as factor,
    (select setting::numeric from pg_settings where name = 'block_size')                     as block_size
),
-- Ancho promedio de la tupla según las estadísticas del planificador. Es la
-- pieza que convierte "páginas ocupadas" en "páginas necesarias".
anchos as (
  select s.schemaname, s.tablename,
         sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) as ancho,
         count(*) as columnas
    from pg_stats s
   group by 1, 2
)
select
  st.schemaname                                  as schema,
  st.relname                                     as "table",
  st.n_live_tup                                  as live_tuples,
  st.n_dead_tup                                  as dead_tuples,
  st.last_autovacuum,
  st.last_vacuum,
  st.last_autoanalyze,
  st.last_analyze,
  st.autovacuum_count,
  st.analyze_count,
  pg_total_relation_size(c.oid)                  as size_bytes,
  pg_relation_size(c.oid)                        as heap_bytes,
  c.reltuples                                    as rel_tuples,
  c.relpages                                     as rel_pages,
  a.ancho                                        as tuple_width,
  a.columnas                                     as column_count,
  (select block_size from ajustes)               as block_size,
  -- Umbral efectivo del autovacuum. Las opciones por tabla ganan sobre las
  -- globales, y son justamente las que un DBA cambia en la tabla problemática.
  coalesce(
    (select option_value::numeric from pg_options_to_table(c.reloptions)
      where option_name = 'autovacuum_vacuum_threshold'),
    (select base from ajustes)
  ) +
  coalesce(
    (select option_value::numeric from pg_options_to_table(c.reloptions)
      where option_name = 'autovacuum_vacuum_scale_factor'),
    (select factor from ajustes)
  ) * greatest(c.reltuples, 0)                   as threshold,
  coalesce(
    (select option_value from pg_options_to_table(c.reloptions)
      where option_name = 'autovacuum_enabled'),
    'true'
  )                                              as autovacuum_enabled,
  -- El factor de llenado cambia cuántas tuplas caben por página; ignorarlo
  -- inventa bloat en tablas configuradas a propósito para dejar espacio.
  coalesce(
    (select option_value::numeric from pg_options_to_table(c.reloptions)
      where option_name = 'fillfactor'),
    100
  )                                              as fillfactor
from pg_stat_user_tables st
join pg_class c on c.oid = st.relid
left join anchos a on a.schemaname = st.schemaname and a.tablename = st.relname
order by st.n_dead_tup desc, pg_total_relation_size(c.oid) desc
limit 100`;

/**
 * Convierte las cifras del catálogo en una estimación de espacio desperdiciado.
 *
 * Se devuelve `null` con una nota en lugar de un cero cuando no hay base para
 * estimar. Un cero diría "esta tabla está bien" y eso es exactamente lo que no
 * se sabe.
 */
function estimateBloat(
  relTuples: number,
  liveTuples: number,
  relPages: number,
  tupleWidth: number | null,
  columnCount: number,
  blockSize: number,
  fillfactor: number,
  sizeBytes: number,
): { bytes: number | null; pct: number | null; note: string | null } {
  // `reltuples = -1` significa que la tabla nunca se analizó. Tomarlo como 0
  // haría parecer que todas sus páginas son basura.
  if (relTuples < 0) {
    return { bytes: null, pct: null, note: 'sin estadísticas: falta un ANALYZE' };
  }
  if (relPages <= 0) return { bytes: null, pct: null, note: 'tabla vacía' };
  // Cero tuplas en el catálogo pero filas vivas en las estadísticas de
  // actividad: el ANALYZE quedó atrás. Sin esta salida, la estimación dice que
  // el 100% de la tabla es basura, que es la clase de número que hace perder la
  // confianza en la pantalla entera.
  if (relTuples === 0 && liveTuples > 0) {
    return { bytes: null, pct: null, note: 'estadísticas desactualizadas: falta un ANALYZE' };
  }
  if (tupleWidth === null || tupleWidth <= 0) {
    return { bytes: null, pct: null, note: 'sin estadísticas de columnas' };
  }

  // Cabecera de tupla (23 bytes) más el mapa de nulos, alineado a 8 bytes.
  const nullBitmap = Math.ceil(columnCount / 8);
  const headerBytes = Math.ceil((23 + nullBitmap) / 8) * 8;
  const perTuple = headerBytes + Math.ceil(tupleWidth / 8) * 8 + 4; // +4: puntero en la página

  const usable = (blockSize - 24) * (fillfactor / 100);
  const tuplesPerPage = Math.floor(usable / perTuple);
  if (tuplesPerPage <= 0) {
    return { bytes: null, pct: null, note: 'tuplas más anchas que una página (TOAST)' };
  }

  const expectedPages = Math.ceil(relTuples / tuplesPerPage);
  const wastedPages = relPages - expectedPages;
  if (wastedPages <= 0) return { bytes: 0, pct: 0, note: null };

  const bytes = wastedPages * blockSize;
  // El porcentaje se calcula sobre el heap y no sobre el tamaño total, porque
  // los índices y el TOAST no entran en esta estimación.
  const heapBytes = relPages * blockSize;
  const pct = heapBytes > 0 ? (bytes / heapBytes) * 100 : null;

  return {
    bytes: Math.min(bytes, sizeBytes),
    pct: pct === null ? null : Math.min(pct, 100),
    note: null,
  };
}

/**
 * Vacuums y analyzes en curso.
 *
 * PostgreSQL 17 renombró las columnas de tuplas muertas a bytes
 * (`dead_tuple_bytes`), así que la consulta cambia según la versión en vez de
 * fallar en la mitad de las instalaciones.
 */
function progressSql(caps: Capabilities): string {
  const bytesColumns =
    caps.versionNum >= 170000
      ? 'p.dead_tuple_bytes, p.max_dead_tuple_bytes'
      : 'p.num_dead_tuples * 6 as dead_tuple_bytes, p.max_dead_tuples * 6 as max_dead_tuple_bytes';

  return `
    select 'vacuum' as kind, p.pid, p.phase,
           n.nspname as schema, c.relname as "table",
           p.heap_blks_total, p.heap_blks_scanned, p.heap_blks_vacuumed,
           p.index_vacuum_count, ${bytesColumns},
           a.query_start as started_at
      from pg_stat_progress_vacuum p
      left join pg_class c on c.oid = p.relid
      left join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_activity a on a.pid = p.pid
    union all
    select 'analyze' as kind, p.pid, p.phase,
           n.nspname as schema, c.relname as "table",
           null::bigint, null::bigint, null::bigint,
           null::bigint, null::bigint, null::bigint,
           a.query_start as started_at
      from pg_stat_progress_analyze p
      left join pg_class c on c.oid = p.relid
      left join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_activity a on a.pid = p.pid`;
}

export async function sampleVacuum(pool: Pool, caps: Capabilities): Promise<VacuumSnapshot> {
  const [tablesResult, progressResult] = await Promise.all([
    pool.query<Record<string, unknown>>(tagged(VACUUM_SQL)),
    pool.query<Record<string, unknown>>(tagged(progressSql(caps))),
  ]);

  const number = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const maybeNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const date = (value: unknown): Date | null => (value instanceof Date ? value : null);

  const tables: VacuumTable[] = tablesResult.rows.map((row) => {
    const live = number(row['live_tuples']);
    const dead = number(row['dead_tuples']);
    const threshold = maybeNumber(row['threshold']);
    const sizeBytes = number(row['size_bytes']);

    const bloat = estimateBloat(
      number(row['rel_tuples']),
      live,
      number(row['rel_pages']),
      maybeNumber(row['tuple_width']),
      number(row['column_count']),
      number(row['block_size']) || 8192,
      number(row['fillfactor']) || 100,
      sizeBytes,
    );

    return {
      schema: String(row['schema'] ?? ''),
      table: String(row['table'] ?? ''),
      liveTuples: live,
      deadTuples: dead,
      deadPct: live + dead > 0 ? (dead / (live + dead)) * 100 : null,
      lastAutovacuum: date(row['last_autovacuum']),
      lastVacuum: date(row['last_vacuum']),
      lastAutoanalyze: date(row['last_autoanalyze']),
      lastAnalyze: date(row['last_analyze']),
      autovacuumCount: number(row['autovacuum_count']),
      analyzeCount: number(row['analyze_count']),
      threshold,
      remaining: threshold === null ? null : Math.round(threshold - dead),
      autovacuumEnabled: String(row['autovacuum_enabled'] ?? 'true') !== 'false',
      sizeBytes,
      heapBytes: number(row['heap_bytes']),
      bloatBytes: bloat.bytes,
      bloatPct: bloat.pct,
      bloatNote: bloat.note,
    };
  });

  const progress: VacuumProgress[] = progressResult.rows.map((row) => {
    const total = maybeNumber(row['heap_blks_total']);
    const scanned = maybeNumber(row['heap_blks_scanned']);
    return {
      pid: number(row['pid']),
      schema: String(row['schema'] ?? ''),
      table: String(row['table'] ?? ''),
      phase: String(row['phase'] ?? ''),
      kind: row['kind'] === 'analyze' ? 'analyze' : 'vacuum',
      heapBlksTotal: total,
      heapBlksScanned: scanned,
      heapBlksVacuumed: maybeNumber(row['heap_blks_vacuumed']),
      indexVacuumCount: maybeNumber(row['index_vacuum_count']),
      deadTupleBytes: maybeNumber(row['dead_tuple_bytes']),
      maxDeadTupleBytes: maybeNumber(row['max_dead_tuple_bytes']),
      startedAt: date(row['started_at']),
      progressPct: total && total > 0 && scanned !== null ? Math.min((scanned / total) * 100, 100) : null,
    };
  });

  return { tables, progress };
}

/**
 * Métricas derivadas, para que el bloat y el retraso del autovacuum tengan
 * serie de tiempo y no sólo una foto.
 */
export function vacuumSamples(snapshot: VacuumSnapshot): Sample[] {
  const samples: Sample[] = [];

  for (const table of snapshot.tables.slice(0, 25)) {
    const labels = { schema: table.schema, table: table.table };
    if (table.bloatBytes !== null) {
      samples.push({ metric: 'table_bloat_bytes', value: table.bloatBytes, labels });
    }
    if (table.bloatPct !== null) {
      samples.push({ metric: 'table_bloat_pct', value: table.bloatPct, labels });
    }
    if (table.remaining !== null) {
      samples.push({ metric: 'table_autovacuum_remaining', value: table.remaining, labels });
    }
  }

  samples.push({
    metric: 'vacuum_running',
    value: snapshot.progress.filter((entry) => entry.kind === 'vacuum').length,
  });
  samples.push({
    metric: 'analyze_running',
    value: snapshot.progress.filter((entry) => entry.kind === 'analyze').length,
  });

  const totalBloat = snapshot.tables.reduce((sum, table) => sum + (table.bloatBytes ?? 0), 0);
  samples.push({ metric: 'bloat_estimated_bytes', value: totalBloat });

  return samples;
}
