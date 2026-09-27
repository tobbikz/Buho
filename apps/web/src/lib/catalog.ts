import { query } from './db';
import { schemaNodeId, tableNodeId, type OrmModel, type OrmTable } from './orm-types';

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

/** Structure only: every schema and table, no traffic weights. */
export function catalogModel(rows: CatalogRow[]): OrmModel {
  const bySchema = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const list = bySchema.get(row.schema) ?? [];
    list.push(row);
    bySchema.set(row.schema, list);
  }
  const schemas = [...bySchema.entries()].map(([name, tables]) => {
    const mapped: OrmTable[] = tables.map((table) => ({
      schema: table.schema,
      name: table.table,
      relation: `${table.schema}.${table.table}`,
      liveTuples: 0,
      deadTuples: 0,
      sizeBytes: table.sizeBytes,
      writeHeat: 0,
      readHeat: 0,
      heat: 0,
      attributed: false,
      apps: [],
    }));
    return {
      name,
      tables: mapped,
      heat: 0,
      tableCount: tables.length,
      sizeBytes: tables.reduce((sum, table) => sum + table.sizeBytes, 0),
    };
  });
  let maxSize = 1;
  const nodes: OrmModel['nodes'] = [];
  const links: OrmModel['links'] = [];
  for (const schema of schemas) {
    nodes.push({
      id: schemaNodeId(schema.name),
      kind: 'schema',
      label: schema.name,
      sizeBytes: schema.sizeBytes,
      liveTuples: 0,
      writeHeat: 0,
      readHeat: 0,
      heat: 0,
    });
    for (const table of schema.tables) {
      maxSize = Math.max(maxSize, table.sizeBytes);
      nodes.push({
        id: tableNodeId(table.relation),
        kind: 'table',
        label: table.name,
        schema: schema.name,
        sizeBytes: table.sizeBytes,
        liveTuples: 0,
        writeHeat: 0,
        readHeat: 0,
        heat: 0,
        table,
      });
      links.push({
        source: schemaNodeId(schema.name),
        target: tableNodeId(table.relation),
        kind: 'membership',
        traffic: 0,
        writeTraffic: 0,
        readTraffic: 0,
      });
    }
  }
  return {
    schemas,
    nodes,
    links,
    totalTables: rows.length,
    foreignKeys: 0,
    attributedTables: 0,
    maxSize,
    maxHeat: 0,
    maxTraffic: 0,
  };
}
