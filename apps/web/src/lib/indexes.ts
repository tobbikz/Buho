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
