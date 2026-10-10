import { query } from './db';

export interface MssqlHeapPressureRow {
  schema: string;
  table: string;
  forwardedFetchCount: number;
  writeCount: number;
  capturedAt: Date;
}

export interface MssqlIndexFragmentationRow {
  schema: string;
  table: string;
  indexName: string;
  fragmentationPct: number;
  pageCount: number;
  capturedAt: Date;
}

export interface MssqlMaintenanceTotals {
  heapRows: number;
  forwardedTotal: number;
  heapsOver10k: number;
  fragmentationRows: number;
  worstFragmentationPct: number | null;
  capturedAt: Date | null;
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getMssqlHeapPressure(instanceId: number, limit = 20): Promise<MssqlHeapPressureRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select schema_name, table_name, forwarded_fetch_count, write_count, captured_at
       from buho.mssql_heap_pressure
      where instance_id = $1
      order by forwarded_fetch_count desc
      limit $2`,
    [instanceId, limit],
  );
  return rows.map((row) => ({
    schema: String(row['schema_name']),
    table: String(row['table_name']),
    forwardedFetchCount: num(row['forwarded_fetch_count']),
    writeCount: num(row['write_count']),
    capturedAt: row['captured_at'] as Date,
  }));
}

export async function getMssqlIndexFragmentation(
  instanceId: number,
  limit = 25,
): Promise<MssqlIndexFragmentationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select schema_name, table_name, index_name, fragmentation_pct, page_count, captured_at
       from buho.mssql_index_fragmentation
      where instance_id = $1
      order by fragmentation_pct desc, page_count desc
      limit $2`,
    [instanceId, limit],
  );
  return rows.map((row) => ({
    schema: String(row['schema_name']),
    table: String(row['table_name']),
    indexName: String(row['index_name']),
    fragmentationPct: num(row['fragmentation_pct']),
    pageCount: num(row['page_count']),
    capturedAt: row['captured_at'] as Date,
  }));
}

export async function getMssqlMaintenanceTotals(instanceId: number): Promise<MssqlMaintenanceTotals> {
  const rows = await query<Record<string, unknown>>(
    `select
        (select count(*)::int from buho.mssql_heap_pressure where instance_id = $1) as heap_rows,
        (select coalesce(sum(forwarded_fetch_count), 0)::bigint from buho.mssql_heap_pressure where instance_id = $1) as forwarded_total,
        (select count(*)::int from buho.mssql_heap_pressure where instance_id = $1 and forwarded_fetch_count > 10000) as heaps_over_10k,
        (select count(*)::int from buho.mssql_index_fragmentation where instance_id = $1) as frag_rows,
        (select max(fragmentation_pct) from buho.mssql_index_fragmentation where instance_id = $1) as worst_frag,
        (select max(captured_at) from (
           select captured_at from buho.mssql_heap_pressure where instance_id = $1
           union all
           select captured_at from buho.mssql_index_fragmentation where instance_id = $1
         ) s) as captured_at`,
    [instanceId],
  );
  const row = rows[0] ?? {};
  return {
    heapRows: num(row['heap_rows']),
    forwardedTotal: num(row['forwarded_total']),
    heapsOver10k: num(row['heaps_over_10k']),
    fragmentationRows: num(row['frag_rows']),
    worstFragmentationPct: row['worst_frag'] === null ? null : num(row['worst_frag']),
    capturedAt: (row['captured_at'] as Date | null) ?? null,
  };
}
