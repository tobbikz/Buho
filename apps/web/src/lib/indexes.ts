import { query } from './db';
import type { IndexStatus } from '@buho/core';

export interface IndexRow {
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
  coveredBy: string | null;
  capturedAt: Date;
}

export interface IndexSummary {
  total: number;
  totalBytes: number;
  unused: number;
  redundant: number;
  invalid: number;
  capturedAt: Date | null;
}

function toRow(row: Record<string, unknown>): IndexRow {
  return {
    schema: String(row['schema_name']),
    table: String(row['table_name']),
    name: String(row['index_name']),
    sizeBytes: Number(row['size_bytes'] ?? 0),
    idxScan: Number(row['idx_scan'] ?? 0),
    idxTupRead: Number(row['idx_tup_read'] ?? 0),
    idxTupFetch: Number(row['idx_tup_fetch'] ?? 0),
    isPrimary: row['is_primary'] === true,
    isUnique: row['is_unique'] === true,
    isValid: row['is_valid'] !== false,
    isPartial: row['is_partial'] === true,
    hasExpression: row['has_expression'] === true,
    columns: Array.isArray(row['columns']) ? row['columns'].map(String) : [],
    definition: row['definition'] ? String(row['definition']) : null,
    status: String(row['status']) as IndexStatus,
    coveredBy: row['covered_by'] ? String(row['covered_by']) : null,
    capturedAt: new Date(row['captured_at'] as string),
  };
}

export async function getIndexSummary(instanceId: number): Promise<IndexSummary> {
  const rows = await query<{
    total: string;
    total_bytes: string;
    unused: string;
    redundant: string;
    invalid: string;
    captured_at: Date | null;
  }>(
    `select count(*)::bigint as total,
            coalesce(sum(size_bytes), 0)::bigint as total_bytes,
            count(*) filter (where status = 'unused')::bigint as unused,
            count(*) filter (where status = 'redundant')::bigint as redundant,
            count(*) filter (where status = 'invalid')::bigint as invalid,
            max(captured_at) as captured_at
       from buho.index_objects
      where instance_id = $1`,
    [instanceId],
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
    unused: Number(row?.unused ?? 0),
    redundant: Number(row?.redundant ?? 0),
    invalid: Number(row?.invalid ?? 0),
    capturedAt: row?.captured_at ?? null,
  };
}

export interface IndexSchemaGroup {
  schema: string;
  indexes: number;
  bytes: number;
  flagged: number;
}

export interface IndexTableGroup {
  schema: string;
  table: string;
  indexes: number;
  bytes: number;
  flagged: number;
  scans: number;
}

export async function getIndexSchemaGroups(instanceId: number): Promise<IndexSchemaGroup[]> {
  const rows = await query<{ schema_name: string; indexes: string; bytes: string; flagged: string }>(
    `select schema_name,
            count(*)::bigint as indexes,
            coalesce(sum(size_bytes), 0)::bigint as bytes,
            count(*) filter (where status <> 'ok')::bigint as flagged
       from buho.index_objects
      where instance_id = $1
      group by schema_name
      order by bytes desc, indexes desc`,
    [instanceId],
  );
  return rows.map((row) => ({
    schema: row.schema_name,
    indexes: Number(row.indexes),
    bytes: Number(row.bytes),
    flagged: Number(row.flagged),
  }));
}

export async function getIndexTableGroups(
  instanceId: number,
  opts: { schema?: string | null; q?: string; page?: number; size?: number } = {},
): Promise<{ rows: IndexTableGroup[]; total: number }> {
  const size = Math.min(Math.max(opts.size ?? 20, 1), 100);
  const page = Math.max(opts.page ?? 1, 1);
  const where = ['instance_id = $1'];
  const params: unknown[] = [instanceId];
  if (opts.schema) {
    params.push(opts.schema);
    where.push(`schema_name = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where.push(`(schema_name ilike $${params.length} or table_name ilike $${params.length})`);
  }
  const filter = where.join(' and ');
  const counted = await query<{ total: string }>(
    `select count(*)::bigint as total
       from (
         select schema_name, table_name
           from buho.index_objects
          where ${filter}
          group by schema_name, table_name
       ) grouped`,
    params,
  );
  const total = Number(counted[0]?.total ?? 0);
  const limitAt = params.length + 1;
  const offsetAt = params.length + 2;
  const rows = await query<{
    schema_name: string;
    table_name: string;
    indexes: string;
    bytes: string;
    flagged: string;
    scans: string;
  }>(
    `select schema_name, table_name,
            count(*)::bigint as indexes,
            coalesce(sum(size_bytes), 0)::bigint as bytes,
            count(*) filter (where status <> 'ok')::bigint as flagged,
            coalesce(sum(idx_scan), 0)::bigint as scans
       from buho.index_objects
      where ${filter}
      group by schema_name, table_name
      order by bytes desc
      limit $${limitAt} offset $${offsetAt}`,
    [...params, size, (page - 1) * size],
  );
  return {
    total,
    rows: rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      indexes: Number(row.indexes),
      bytes: Number(row.bytes),
      flagged: Number(row.flagged),
      scans: Number(row.scans),
    })),
  };
}

const INDEX_SORT = {
  size: 'size_bytes',
  scans: 'idx_scan',
  name: 'index_name',
  table: 'schema_name, table_name',
} as const;

export async function getIndexPage(
  instanceId: number,
  filter: 'all' | IndexStatus,
  schema: string | null,
  q: string,
  sort: keyof typeof INDEX_SORT,
  dir: 'asc' | 'desc',
  page: number,
  size: number,
): Promise<{ rows: IndexRow[]; total: number }> {
  const order = INDEX_SORT[sort];
  const direction = dir === 'asc' ? 'asc' : 'desc';
  const offset = Math.max(0, page - 1) * size;
  const needle = q ? `%${q}%` : null;
  const [countRows, rows] = await Promise.all([
    query<{ total: string }>(
      `select count(*)::bigint as total
         from buho.index_objects
        where instance_id = $1
          and ($2::text = 'all' or status = $2)
          and ($3::text is null or schema_name = $3)
          and ($4::text is null or index_name ilike $4 or table_name ilike $4 or schema_name ilike $4)`,
      [instanceId, filter, schema, needle],
    ),
    query(
      `select *
         from buho.index_objects
        where instance_id = $1
          and ($2::text = 'all' or status = $2)
          and ($3::text is null or schema_name = $3)
          and ($4::text is null or index_name ilike $4 or table_name ilike $4 or schema_name ilike $4)
        order by ${order} ${direction}
        limit $5 offset $6`,
      [instanceId, filter, schema, needle, size, offset],
    ),
  ]);
  return { rows: rows.map(toRow), total: Number(countRows[0]?.total ?? 0) };
}

/** Secondary indexes at least twice the heap and over 64 MB. PostgreSQL has no leaf-fragmentation counter. */
export async function getBloatedIndexes(instanceId: number, limit = 40): Promise<IndexRow[]> {
  const rows = await query(
    `select i.*
       from buho.index_objects i
       join buho.vacuum_tables t
         on t.instance_id = i.instance_id
        and t.schema_name = i.schema_name
        and t.table_name = i.table_name
      where i.instance_id = $1
        and not i.is_primary
        and t.heap_bytes > 0
        and i.size_bytes > 64 * 1024 * 1024
        and i.size_bytes > t.heap_bytes * 2
      order by i.size_bytes desc
      limit $2`,
    [instanceId, limit],
  );
  return rows.map(toRow);
}

export async function getIndexInventory(
  instanceId: number,
  filter: 'all' | IndexStatus = 'all',
  limit?: number,
): Promise<IndexRow[]> {
  const rows = await query(
    `select *
       from buho.index_objects
      where instance_id = $1
        and ($2::text = 'all' or status = $2)
      order by size_bytes desc
      limit coalesce($3::int, 100000)`,
    [instanceId, filter, limit ?? null],
  );
  return rows.map(toRow);
}
