import type { EngineClient } from '../engine';
import type { IndexObject, IndexSnapshot, IndexStatus } from '../indexes';
import type { ForeignCaps } from './types';
import { num, str } from './types';

export interface MssqlHeapPressureRow {
  schema: string;
  table: string;
  forwardedFetchCount: number;
  writeCount: number;
}

export interface MssqlIndexFragmentationRow {
  schema: string;
  table: string;
  indexName: string;
  fragmentationPct: number;
  pageCount: number;
}

export interface MssqlMaintenanceSnapshot {
  heaps: MssqlHeapPressureRow[];
  fragmentation: MssqlIndexFragmentationRow[];
}

type IndexAcc = {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  isPrimary: boolean;
  isUnique: boolean;
  isValid: boolean;
  isPartial: boolean;
  hasExpression: boolean;
  typeDesc: string;
  sizeBytes: number;
  idxScan: number;
  userUpdates: number;
};

/**
 * Index inventory for SQL Server — sys.indexes, dm_db_index_usage_stats, partitions.
 * Unused when seeks+scans+lookups=0 (not PK / unique clustered). Prefix redundancy like MariaDB.
 */
export async function sampleMssqlIndexes(client: EngineClient, _caps: ForeignCaps): Promise<IndexSnapshot> {
  const rows = await client.query(`
    with sizes as (
      select i.object_id,
             i.index_id,
             schema_name(t.schema_id) as schema_name,
             t.name as table_name,
             i.name as index_name,
             i.is_primary_key as is_primary,
             i.is_unique,
             i.is_disabled,
             i.has_filter,
             i.type_desc,
             sum(a.total_pages) * 8192 as size_bytes
        from sys.indexes i
        join sys.tables t on t.object_id = i.object_id
        join sys.partitions p on p.object_id = i.object_id and p.index_id = i.index_id
        join sys.allocation_units a on a.container_id = p.partition_id
       where t.is_ms_shipped = 0
         and i.type > 0
         and schema_name(t.schema_id) not in ('sys')
       group by i.object_id, i.index_id, schema_name(t.schema_id), t.name, i.name,
                i.is_primary_key, i.is_unique, i.is_disabled, i.has_filter, i.type_desc
    ),
    cols as (
      select ic.object_id,
             ic.index_id,
             string_agg(c.name, ',') within group (order by ic.key_ordinal) as column_list,
             max(case when c.is_computed = 1 then 1 else 0 end) as has_computed
        from sys.index_columns ic
        join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
       where ic.is_included_column = 0
       group by ic.object_id, ic.index_id
    )
    select s.schema_name,
           s.table_name,
           s.index_name,
           s.is_primary,
           s.is_unique,
           s.is_disabled,
           s.has_filter,
           s.type_desc,
           s.size_bytes,
           coalesce(us.user_seeks, 0) + coalesce(us.user_scans, 0) + coalesce(us.user_lookups, 0) as idx_scan,
           coalesce(us.user_updates, 0) as user_updates,
           coalesce(c.column_list, '') as column_list,
           coalesce(c.has_computed, 0) as has_computed
      from sizes s
      left join cols c on c.object_id = s.object_id and c.index_id = s.index_id
      left join sys.dm_db_index_usage_stats us
        on us.database_id = db_id()
       and us.object_id = s.object_id
       and us.index_id = s.index_id
     order by s.size_bytes desc`);

  const byKey = new Map<string, IndexAcc>();
  for (const row of rows) {
    const schema = str(row['schema_name']);
    const table = str(row['table_name']);
    const name = str(row['index_name']);
    const key = `${schema}.${table}.${name}`;
    const columns = str(row['column_list'], '')
      .split(',')
      .map((col) => col.trim())
      .filter(Boolean);
    byKey.set(key, {
      schema,
      table,
      name,
      columns,
      isPrimary: row['is_primary'] === true || row['is_primary'] === 1,
      isUnique: row['is_unique'] === true || row['is_unique'] === 1,
      isValid: !(row['is_disabled'] === true || row['is_disabled'] === 1),
      isPartial: row['has_filter'] === true || row['has_filter'] === 1,
      hasExpression: num(row['has_computed']) > 0,
      typeDesc: str(row['type_desc'], 'NONCLUSTERED'),
      sizeBytes: num(row['size_bytes']),
      idxScan: num(row['idx_scan']),
      userUpdates: num(row['user_updates']),
    });
  }

  const perTable = new Map<string, IndexAcc[]>();
  for (const acc of byKey.values()) {
    const tkey = `${acc.schema}.${acc.table}`;
    const list = perTable.get(tkey) ?? [];
    list.push(acc);
    perTable.set(tkey, list);
  }

  const indexes: IndexObject[] = [];
  for (const acc of byKey.values()) {
    const isUniqueClustered =
      acc.isUnique && acc.typeDesc.toUpperCase().includes('CLUSTERED');
    let status: IndexStatus = acc.isValid ? 'ok' : 'invalid';
    let coveredBy: string | null = null;

    if (status === 'ok') {
      const siblings = perTable.get(`${acc.schema}.${acc.table}`) ?? [];
      for (const other of siblings) {
        if (other.name === acc.name) continue;
        if (acc.isPrimary || acc.isUnique) continue;
        if (acc.isPartial || other.isPartial || acc.hasExpression || other.hasExpression) continue;
        if (
          other.columns.length >= acc.columns.length &&
          acc.columns.length > 0 &&
          acc.columns.every((col, index) => other.columns[index] === col) &&
          other.columns.length > acc.columns.length
        ) {
          status = 'redundant';
          coveredBy = other.name;
          break;
        }
      }
    }

    if (
      status === 'ok' &&
      acc.idxScan === 0 &&
      !acc.isPrimary &&
      !isUniqueClustered
    ) {
      status = 'unused';
    }

    indexes.push({
      schema: acc.schema,
      table: acc.table,
      name: acc.name,
      sizeBytes: acc.sizeBytes,
      idxScan: acc.idxScan,
      idxTupRead: acc.userUpdates,
      idxTupFetch: 0,
      isPrimary: acc.isPrimary,
      isUnique: acc.isUnique,
      isValid: acc.isValid,
      isPartial: acc.isPartial,
      hasExpression: acc.hasExpression,
      columns: acc.columns,
      definition: `${acc.typeDesc} (${acc.columns.join(', ')})`,
      status,
      coveredBy,
    });
  }

  indexes.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { indexes };
}

/** Heap forwarded-record pressure + index fragmentation (sampled physical stats). */
export async function sampleMssqlMaintenance(client: EngineClient): Promise<MssqlMaintenanceSnapshot> {
  let heaps: MssqlHeapPressureRow[] = [];
  try {
    const heapRows = await client.query(`
      select top 20
             object_schema_name(s.object_id) as schema_name,
             object_name(s.object_id) as table_name,
             s.forwarded_fetch_count as forwarded,
             s.leaf_insert_count + s.leaf_update_count as writes
        from sys.dm_db_index_operational_stats(db_id(), null, null, null) s
        join sys.indexes i on i.object_id = s.object_id and i.index_id = s.index_id
       where i.type = 0
       order by s.forwarded_fetch_count desc`);
    heaps = heapRows.map((row) => ({
      schema: str(row['schema_name']),
      table: str(row['table_name']),
      forwardedFetchCount: num(row['forwarded']),
      writeCount: num(row['writes']),
    }));
  } catch {
    heaps = [];
  }

  let fragmentation: MssqlIndexFragmentationRow[] = [];
  try {
    const fragRows = await client.query(`
      select top 25
             schema_name(t.schema_id) as schema_name,
             t.name as table_name,
             i.name as index_name,
             ps.avg_fragmentation_in_percent as fragmentation_pct,
             ps.page_count
        from sys.dm_db_index_physical_stats(db_id(), null, null, null, 'SAMPLED') ps
        join sys.indexes i on i.object_id = ps.object_id and i.index_id = ps.index_id
        join sys.tables t on t.object_id = ps.object_id
       where ps.index_id > 0
         and t.is_ms_shipped = 0
         and ps.page_count >= 512
         and ps.avg_fragmentation_in_percent >= 10
       order by ps.avg_fragmentation_in_percent desc, ps.page_count desc`);
    fragmentation = fragRows.map((row) => ({
      schema: str(row['schema_name']),
      table: str(row['table_name']),
      indexName: str(row['index_name']),
      fragmentationPct: num(row['fragmentation_pct']),
      pageCount: num(row['page_count']),
    }));
  } catch {
    fragmentation = [];
  }

  return { heaps, fragmentation };
}
