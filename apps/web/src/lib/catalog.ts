import { query } from './db';

export interface CatalogRow {
  schema: string;
  table: string;
  sizeBytes: number;
  partitions: number;
}

export async function getCatalog(instanceId: number): Promise<CatalogRow[]> {
  const rows = await query<{
    schema_name: string;
    table_name: string;
    size_bytes: string;
    partitions: string;
  }>(
    `select schema_name, table_name, size_bytes, partitions
       from buho.catalog_tables
      where instance_id = $1
      order by schema_name, size_bytes desc`,
    [instanceId],
  );
  if (rows.length > 0) {
    return rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      sizeBytes: Number(row.size_bytes),
      partitions: Number(row.partitions),
    }));
  }
  const fallback = await query<{ schema_name: string; table_name: string; size_bytes: string }>(
    `select schema_name, table_name, size_bytes
       from buho.vacuum_tables
      where instance_id = $1
      order by schema_name, size_bytes desc`,
    [instanceId],
  );
  return fallback.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    sizeBytes: Number(row.size_bytes),
    partitions: 0,
  }));
}
