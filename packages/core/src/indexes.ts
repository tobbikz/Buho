import type { Pool } from 'pg';
import { tagged } from './tag';

export type IndexStatus = 'ok' | 'unused' | 'redundant' | 'invalid';

export interface IndexObject {
  schema: string;
  table: string;
  name: string;
  sizeBytes: number;
  idxScan: number;
  idxTupRead: number;
  idxTupFetch: number;
  isPrimary: boolean;
  isUnique: boolean;
  isValid: boolean;
  isPartial: boolean;
  hasExpression: boolean;
  columns: string[];
  definition: string | null;
  status: IndexStatus;
  /** When status is redundant, the index that already covers this prefix. */
  coveredBy: string | null;
}

export interface IndexSnapshot {
  indexes: IndexObject[];
}

interface RawIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  indexrelid: number;
  size_bytes: number;
  idx_scan: number;
  idx_tup_read: number;
  idx_tup_fetch: number;
  is_primary: boolean;
  is_unique: boolean;
  is_valid: boolean;
  is_partial: boolean;
  has_expression: boolean;
  columns: string[] | null;
  definition: string | null;
  col_attnums: number[] | null;
}

const INDEX_SQL = `
select n.nspname  as schema_name,
       c.relname  as table_name,
       ir.relname as index_name,
       i.indexrelid,
       pg_relation_size(i.indexrelid) as size_bytes,
       coalesce(s.idx_scan, 0)::bigint      as idx_scan,
       coalesce(s.idx_tup_read, 0)::bigint  as idx_tup_read,
       coalesce(s.idx_tup_fetch, 0)::bigint as idx_tup_fetch,
       i.indisprimary  as is_primary,
       i.indisunique   as is_unique,
       i.indisvalid    as is_valid,
       (i.indpred is not null)  as is_partial,
       (i.indexprs is not null) as has_expression,
       (select array_agg(a.attname order by k.ord)
          from unnest(i.indkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where k.attnum > 0) as columns,
       (select array_agg(k.attnum order by k.ord)
          from unnest(i.indkey) with ordinality k(attnum, ord)
         where k.attnum > 0) as col_attnums,
       pg_get_indexdef(i.indexrelid) as definition
  from pg_index i
  join pg_class c  on c.oid = i.indrelid
  join pg_class ir on ir.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
 where c.relkind in ('r', 'p')
   and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
 order by pg_relation_size(i.indexrelid) desc`;

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function isRedundantPrefix(a: RawIndex, b: RawIndex): boolean {
  if (a.indexrelid === b.indexrelid) return false;
  if (a.schema_name !== b.schema_name || a.table_name !== b.table_name) return false;
  if (a.is_unique || a.is_partial || b.is_partial || a.has_expression || b.has_expression) return false;
  const aCols = a.col_attnums ?? [];
  const bCols = b.col_attnums ?? [];
  if (aCols.length === 0 || bCols.length === 0 || aCols.length > bCols.length) return false;
  return bCols.slice(0, aCols.length).every((col, index) => col === aCols[index]);
}

function classifyIndexes(raw: RawIndex[]): IndexObject[] {
  const redundantIds = new Map<number, string>();

  for (const a of raw) {
    if (a.is_unique || a.is_partial || a.has_expression) continue;
    for (const b of raw) {
      if (isRedundantPrefix(a, b)) {
        redundantIds.set(a.indexrelid, `${b.schema_name}.${b.table_name}.${b.index_name}`);
        break;
      }
    }
  }

  return raw.map((row) => {
    let status: IndexStatus = 'ok';
    let coveredBy: string | null = null;

    if (!row.is_valid) {
      status = 'invalid';
    } else if (redundantIds.has(row.indexrelid)) {
      status = 'redundant';
      coveredBy = redundantIds.get(row.indexrelid) ?? null;
    } else if (
      num(row.idx_scan) === 0 &&
      !row.is_primary &&
      !row.is_unique &&
      num(row.size_bytes) > 10 * 1024 * 1024 &&
      !redundantIds.has(row.indexrelid)
    ) {
      status = 'unused';
    }

    return {
      schema: text(row.schema_name),
      table: text(row.table_name),
      name: text(row.index_name),
      sizeBytes: num(row.size_bytes),
      idxScan: num(row.idx_scan),
      idxTupRead: num(row.idx_tup_read),
      idxTupFetch: num(row.idx_tup_fetch),
      isPrimary: row.is_primary === true,
      isUnique: row.is_unique === true,
      isValid: row.is_valid !== false,
      isPartial: row.is_partial === true,
      hasExpression: row.has_expression === true,
      columns: Array.isArray(row.columns) ? row.columns.map(String) : [],
      definition: row.definition ? String(row.definition) : null,
      status,
      coveredBy,
    };
  });
}

export async function sampleIndexes(pool: Pool): Promise<IndexSnapshot> {
  const { rows } = await pool.query(tagged(INDEX_SQL));
  return { indexes: classifyIndexes(rows as RawIndex[]) };
}
