import { query } from './db';

export interface VacuumTableRow {
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
  threshold: number | null;
  remaining: number | null;
  autovacuumEnabled: boolean;
  sizeBytes: number;
  heapBytes: number;
  bloatBytes: number | null;
  bloatPct: number | null;
  bloatNote: string | null;
  capturedAt: Date;
}

export interface VacuumProgressRow {
  pid: number;
  kind: 'vacuum' | 'analyze';
  schema: string | null;
  table: string | null;
  phase: string | null;
  heapBlksTotal: number | null;
  heapBlksScanned: number | null;
  heapBlksVacuumed: number | null;
  indexVacuumCount: number | null;
  deadTupleBytes: number | null;
  maxDeadTupleBytes: number | null;
  progressPct: number | null;
  startedAt: Date | null;
}

export interface VacuumTotals {
  tables: number;
  deadTuples: number;
  bloatBytes: number;
  /** Tablas cuya estimación no se pudo hacer, y por qué falta. */
  unestimated: number;
  missingAnalyze: number;
  autovacuumDisabled: number;
  /** Tablas que ya pasaron su umbral y siguen esperando turno. */
  overdue: number;
  oldestAutovacuum: Date | null;
  capturedAt: Date | null;
}

export type VacuumOrder = 'muertas' | 'bloat' | 'antiguedad' | 'tamano';

const ORDER_SQL: Record<VacuumOrder, string> = {
  muertas: 'dead_tuples desc, size_bytes desc',
  bloat: 'bloat_bytes desc nulls last',
  // `nulls first` a propósito: una tabla que nunca tuvo autovacuum es el caso
  // más grave de "antigüedad", no el menos.
  antiguedad: 'greatest(last_autovacuum, last_vacuum) asc nulls first',
  tamano: 'size_bytes desc',
};

function toRow(row: Record<string, unknown>): VacuumTableRow {
  const number = (value: unknown): number => Number(value ?? 0);
  const maybe = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    schema: String(row['schema_name'] ?? ''),
    table: String(row['table_name'] ?? ''),
    liveTuples: number(row['live_tuples']),
    deadTuples: number(row['dead_tuples']),
    deadPct: maybe(row['dead_pct']),
    lastAutovacuum: (row['last_autovacuum'] as Date | null) ?? null,
    lastVacuum: (row['last_vacuum'] as Date | null) ?? null,
    lastAutoanalyze: (row['last_autoanalyze'] as Date | null) ?? null,
    lastAnalyze: (row['last_analyze'] as Date | null) ?? null,
    autovacuumCount: number(row['autovacuum_count']),
    analyzeCount: number(row['analyze_count']),
    threshold: maybe(row['threshold']),
    remaining: maybe(row['remaining']),
    autovacuumEnabled: Boolean(row['autovacuum_enabled']),
    sizeBytes: number(row['size_bytes']),
    heapBytes: number(row['heap_bytes']),
    bloatBytes: maybe(row['bloat_bytes']),
    bloatPct: maybe(row['bloat_pct']),
    bloatNote: (row['bloat_note'] as string | null) ?? null,
    capturedAt: row['captured_at'] as Date,
  };
}

export async function getVacuumTables(
  instanceId: number,
  order: VacuumOrder = 'muertas',
  limit = 40,
): Promise<VacuumTableRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select * from buho.vacuum_tables
      where instance_id = $1
      order by ${ORDER_SQL[order]}
      limit $2`,
    [instanceId, limit],
  );
  return rows.map(toRow);
}

export async function getVacuumProgress(instanceId: number): Promise<VacuumProgressRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select * from buho.vacuum_progress where instance_id = $1 order by started_at nulls last`,
    [instanceId],
  );

  return rows.map((row) => ({
    pid: Number(row['pid']),
    kind: row['kind'] === 'analyze' ? 'analyze' : 'vacuum',
    schema: (row['schema_name'] as string | null) ?? null,
    table: (row['table_name'] as string | null) ?? null,
    phase: (row['phase'] as string | null) ?? null,
    heapBlksTotal: row['heap_blks_total'] === null ? null : Number(row['heap_blks_total']),
    heapBlksScanned: row['heap_blks_scanned'] === null ? null : Number(row['heap_blks_scanned']),
    heapBlksVacuumed: row['heap_blks_vacuumed'] === null ? null : Number(row['heap_blks_vacuumed']),
    indexVacuumCount: row['index_vacuum_count'] === null ? null : Number(row['index_vacuum_count']),
    deadTupleBytes: row['dead_tuple_bytes'] === null ? null : Number(row['dead_tuple_bytes']),
    maxDeadTupleBytes:
      row['max_dead_tuple_bytes'] === null ? null : Number(row['max_dead_tuple_bytes']),
    progressPct: row['progress_pct'] === null ? null : Number(row['progress_pct']),
    startedAt: (row['started_at'] as Date | null) ?? null,
  }));
}

export async function getVacuumTotals(instanceId: number): Promise<VacuumTotals> {
  const rows = await query<Record<string, unknown>>(
    `select count(*)                                                    as tables,
            coalesce(sum(dead_tuples), 0)                               as dead_tuples,
            coalesce(sum(bloat_bytes), 0)                               as bloat_bytes,
            count(*) filter (where bloat_bytes is null)                 as unestimated,
            count(*) filter (where bloat_note like '%ANALYZE%')         as missing_analyze,
            count(*) filter (where not autovacuum_enabled)              as autovacuum_disabled,
            count(*) filter (where remaining < 0)                       as overdue,
            min(greatest(last_autovacuum, last_vacuum))                 as oldest_autovacuum,
            max(captured_at)                                            as captured_at
       from buho.vacuum_tables
      where instance_id = $1`,
    [instanceId],
  );

  const row = rows[0] ?? {};
  return {
    tables: Number(row['tables'] ?? 0),
    deadTuples: Number(row['dead_tuples'] ?? 0),
    bloatBytes: Number(row['bloat_bytes'] ?? 0),
    unestimated: Number(row['unestimated'] ?? 0),
    missingAnalyze: Number(row['missing_analyze'] ?? 0),
    autovacuumDisabled: Number(row['autovacuum_disabled'] ?? 0),
    overdue: Number(row['overdue'] ?? 0),
    oldestAutovacuum: (row['oldest_autovacuum'] as Date | null) ?? null,
    capturedAt: (row['captured_at'] as Date | null) ?? null,
  };
}
