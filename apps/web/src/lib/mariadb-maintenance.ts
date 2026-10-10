import { query } from './db';

const SCHEMA_EXPR = `coalesce(labels->>'schema', labels->>'db', '(default)')`;
const TABLE_EXPR = `coalesce(labels->>'table', labels->>'tabla', '(unknown)')`;

export type MariaDbMaintenanceOrder = 'size' | 'free' | 'bloat';

export interface MariaDbMaintenanceTableRow {
  schema: string;
  table: string;
  sizeBytes: number;
  indexBytes: number | null;
  freeBytes: number | null;
  bloatPct: number | null;
  liveRows: number | null;
  capturedAt: Date | null;
}

export interface MariaDbMaintenanceTotals {
  tables: number;
  totalSizeBytes: number;
  totalFreeBytes: number;
  historyListLength: number | null;
  capturedAt: Date | null;
}

/** Checks surfaced on the Maintenance tab (InnoDB analogue of vacuum / analyze themes). */
export const MARIADB_MAINTENANCE_CHECK_IDS = new Set([
  'mariadb_history_list',
  'mariadb_table_bloat',
  'mariadb_undo_pressure',
  'mariadb_stale_statistics',
  'mariadb_stats_auto_disabled',
]);

const ORDER_SQL: Record<MariaDbMaintenanceOrder, string> = {
  size: 'size_bytes desc',
  free: 'free_bytes desc nulls last, size_bytes desc',
  bloat: 'bloat_pct desc nulls last, free_bytes desc nulls last',
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function latestScalarMetric(instanceId: number, metric: string): Promise<number | null> {
  const rows = await query<Record<string, unknown>>(
    `select value
       from buho.metric_samples
      where instance_id = $1
        and metric = $2
        and ts > now() - interval '7 days'
      order by ts desc
      limit 1`,
    [instanceId, metric],
  );
  return num(rows[0]?.['value']);
}

export async function getMariaDbMaintenanceTables(
  instanceId: number,
  order: MariaDbMaintenanceOrder,
  limit = 40,
): Promise<MariaDbMaintenanceTableRow[]> {
  const rows = await query<Record<string, unknown>>(
    `with samples as (
       select metric,
              ${SCHEMA_EXPR} as schema,
              ${TABLE_EXPR} as table_name,
              value,
              ts,
              row_number() over (
                partition by metric, ${SCHEMA_EXPR}, ${TABLE_EXPR}
                order by ts desc
              ) as rn
         from buho.metric_samples
        where instance_id = $1
          and metric in (
            'table_total_bytes', 'table_index_bytes', 'table_free_bytes',
            'table_bloat_pct', 'table_live_tuples'
          )
          and ts > now() - interval '7 days'
     ),
     pivoted as (
       select schema,
              table_name,
              max(value) filter (where metric = 'table_total_bytes' and rn = 1) as size_bytes,
              max(value) filter (where metric = 'table_index_bytes' and rn = 1) as index_bytes,
              max(value) filter (where metric = 'table_free_bytes' and rn = 1) as free_bytes,
              max(value) filter (where metric = 'table_bloat_pct' and rn = 1) as bloat_pct,
              max(value) filter (where metric = 'table_live_tuples' and rn = 1) as live_rows,
              max(ts) filter (where rn = 1) as captured_at
         from samples
        group by schema, table_name
     )
     select schema, table_name, size_bytes, index_bytes, free_bytes, bloat_pct, live_rows, captured_at
       from pivoted
      where size_bytes is not null and size_bytes > 0
      order by ${ORDER_SQL[order]}
      limit $2`,
    [instanceId, limit],
  );

  return rows.map((row) => ({
    schema: String(row['schema']),
    table: String(row['table_name']),
    sizeBytes: num(row['size_bytes']) ?? 0,
    indexBytes: num(row['index_bytes']),
    freeBytes: num(row['free_bytes']),
    bloatPct: num(row['bloat_pct']),
    liveRows: num(row['live_rows']),
    capturedAt: date(row['captured_at']),
  }));
}

export async function getMariaDbMaintenanceTotals(instanceId: number): Promise<MariaDbMaintenanceTotals> {
  const [tables, historyListLength] = await Promise.all([
    getMariaDbMaintenanceTables(instanceId, 'size', 500),
    latestScalarMetric(instanceId, 'innodb_history_list_length'),
  ]);

  let totalSizeBytes = 0;
  let totalFreeBytes = 0;
  let capturedAt: Date | null = null;
  for (const row of tables) {
    totalSizeBytes += row.sizeBytes;
    totalFreeBytes += row.freeBytes ?? 0;
    if (row.capturedAt && (!capturedAt || row.capturedAt > capturedAt)) {
      capturedAt = row.capturedAt;
    }
  }

  return {
    tables: tables.length,
    totalSizeBytes,
    totalFreeBytes,
    historyListLength,
    capturedAt,
  };
}
