import type { EngineClient } from '../engine';
import type { IndexObject, IndexSnapshot, IndexStatus } from '../indexes';
import type { ForeignCaps } from './types';
import { num, str } from './types';

const ORACLE_INDEX_OWNERS_EXCLUDE = `
  ('SYS','SYSTEM','OUTLN','XDB','WMSYS','CTXSYS','MDSYS','ORDSYS','ORDDATA',
   'LBACSYS','DVSYS','AUDSYS','GSMADMIN_INTERNAL','OJVMSYS','DVF','DBSNMP',
   'APPQOSSYS','GSMCATUSER','GGSYS','ANONYMOUS','SYSBACKUP','SYSDG','SYSKM',
   'SYSRAC','GSMUSER','REMOTE_SCHEDULER_AGENT','DBSFWUSER','SI_INFORMTN_SCHEMA',
   'OLAPSYS','ORDPLUGINS','MDDATA','DIP','APEX_PUBLIC_USER','FLOWS_FILES')`;

/**
 * Index inventory for Oracle — ALL_INDEXES / ALL_IND_COLUMNS + optional V$OBJECT_USAGE.
 */
export async function sampleOracleIndexes(client: EngineClient, caps: ForeignCaps): Promise<IndexSnapshot> {
  if (caps.engine !== 'oracle') return { indexes: [] };

  const stats = await client.query(`
    select i.owner as schema_name,
           i.table_name,
           i.index_name,
           i.uniqueness,
           i.status,
           i.leaf_blocks,
           i.num_rows,
           ic.column_position,
           ic.column_name,
           (select to_number(value) from v$parameter where name = 'db_block_size') as block_size
      from all_indexes i
      join all_ind_columns ic
        on ic.index_owner = i.owner
       and ic.index_name = i.index_name
     where i.owner not in ${ORACLE_INDEX_OWNERS_EXCLUDE}
       and i.index_type <> 'LOB'
     order by i.owner, i.table_name, i.index_name, ic.column_position`);

  type Acc = {
    schema: string;
    table: string;
    name: string;
    columns: string[];
    isUnique: boolean;
    isPrimary: boolean;
    isValid: boolean;
    leafBlocks: number;
    blockSize: number;
  };
  const byKey = new Map<string, Acc>();
  for (const row of stats) {
    const schema = str(row['schema_name']);
    const table = str(row['table_name']);
    const name = str(row['index_name']);
    const key = `${schema}.${table}.${name}`;
    let acc = byKey.get(key);
    if (!acc) {
      const unique = str(row['uniqueness'], 'NONUNIQUE').toUpperCase() === 'UNIQUE';
      acc = {
        schema,
        table,
        name,
        columns: [],
        isUnique: unique,
        isPrimary: name.toUpperCase().startsWith('SYS_C') && unique,
        isValid: str(row['status'], 'VALID').toUpperCase() === 'VALID',
        leafBlocks: num(row['leaf_blocks']),
        blockSize: num(row['block_size']) || 8192,
      };
      byKey.set(key, acc);
    }
    const col = str(row['column_name']);
    if (col) acc.columns.push(col);
  }

  const usageByIndex = new Map<string, boolean>();
  try {
    const usage = await client.query(`
      select index_name, table_name, monitoring, used
        from v$object_usage`);
    for (const row of usage) {
      const key = `${str(row['table_name'])}.${str(row['index_name'])}`;
      usageByIndex.set(key, str(row['used'], 'NO').toUpperCase() === 'YES');
    }
  } catch {
    /* MONITORING USAGE not enabled / no privilege */
  }

  const indexes: IndexObject[] = [];
  const perTable = new Map<string, Acc[]>();
  for (const acc of byKey.values()) {
    const tkey = `${acc.schema}.${acc.table}`;
    const list = perTable.get(tkey) ?? [];
    list.push(acc);
    perTable.set(tkey, list);
  }

  for (const acc of byKey.values()) {
    const usageKey = `${acc.table}.${acc.name}`;
    const monitoredUsed = usageByIndex.get(usageKey);
    let status: IndexStatus = 'ok';
    let coveredBy: string | null = null;

    if (!acc.isValid) {
      status = 'invalid';
    } else if (monitoredUsed === false && !acc.isPrimary) {
      status = 'unused';
    }

    const siblings = perTable.get(`${acc.schema}.${acc.table}`) ?? [];
    for (const other of siblings) {
      if (other.name === acc.name) continue;
      if (acc.isPrimary || acc.isUnique) continue;
      if (
        other.columns.length >= acc.columns.length &&
        acc.columns.every((col, index) => other.columns[index] === col) &&
        other.columns.length > acc.columns.length
      ) {
        status = 'redundant';
        coveredBy = other.name;
        break;
      }
    }

    const sizeBytes = Math.max(8192, acc.leafBlocks * acc.blockSize);
    indexes.push({
      schema: acc.schema,
      table: acc.table,
      name: acc.name,
      sizeBytes,
      idxScan: monitoredUsed === true ? 1 : 0,
      idxTupRead: 0,
      idxTupFetch: 0,
      isPrimary: acc.isPrimary,
      isUnique: acc.isUnique,
      isValid: acc.isValid,
      isPartial: false,
      hasExpression: false,
      columns: acc.columns,
      definition: `(${acc.columns.join(', ')})`,
      status,
      coveredBy,
    });
  }

  indexes.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { indexes };
}
