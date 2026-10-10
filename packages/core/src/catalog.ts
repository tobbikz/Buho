import type { Pool } from 'pg';
import { tagged } from './tag';

export interface CatalogTable {
  schema: string;
  table: string;
  sizeBytes: number;
  partitions: number;
}

export interface CatalogColumn {
  schema: string;
  table: string;
  column: string;
  dataType: string;
  notNull: boolean;
  position: number;
}

export interface CatalogSnapshot {
  tables: CatalogTable[];
  columns: CatalogColumn[];
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every user table, with partitions rolled into the parent. Topology reads this
 * so the map is the catalog, not the tables that happened to have traffic.
 */
export async function sampleCatalog(pool: Pool, versionNum: number): Promise<CatalogSnapshot> {
  const sizeExpr =
    versionNum >= 120_000
      ? `coalesce((
           select sum(pg_total_relation_size(t.relid))
             from pg_partition_tree(c.oid) t
            where t.isleaf
         ), 0)`
      : `pg_total_relation_size(c.oid)`;
  const partsExpr =
    versionNum >= 120_000
      ? `(select count(*)::int from pg_partition_tree(c.oid) t where t.relid <> c.oid)`
      : `0`;
  const result = await pool.query(
    tagged(`
      select n.nspname as schema,
             c.relname as table,
             ${sizeExpr} as size_bytes,
             ${partsExpr} as partitions
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p')
         and not c.relispartition
         and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
       order by 3 desc
    `),
  );
  const tables = result.rows.map((row: Record<string, unknown>) => ({
    schema: String(row['schema']),
    table: String(row['table']),
    sizeBytes: num(row['size_bytes']),
    partitions: num(row['partitions']),
  }));
  let columns: CatalogColumn[] = [];
  try {
    const cols = await pool.query(
      tagged(`
        select n.nspname as schema,
               c.relname as table,
               a.attname as column,
               pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
               a.attnotnull as not_null,
               a.attnum as position
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid
         where c.relkind in ('r', 'p')
           and not c.relispartition
           and a.attnum > 0
           and not a.attisdropped
           and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
         order by 1, 2, 6
      `),
    );
    columns = cols.rows.map((row: Record<string, unknown>) => ({
      schema: String(row['schema']),
      table: String(row['table']),
      column: String(row['column']),
      dataType: String(row['data_type'] ?? ''),
      notNull: row['not_null'] === true,
      position: num(row['position']),
    }));
  } catch {
    columns = [];
  }
  return { tables, columns };
}
