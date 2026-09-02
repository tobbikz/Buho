import { query } from './db';
import { getFlow } from './flow';
import type { OrmLink, OrmModel, OrmNode, OrmSchema, OrmTable } from './orm-types';
import { schemaNodeId, tableNodeId } from './orm-types';
import type { FlowWeight } from '@buho/core';

export type { OrmModel, OrmSchema, OrmTable, OrmNode, OrmLink, OrmLayer } from './orm-types';
export { formatBytesShort, schemaNodeId, tableNodeId } from './orm-types';

export async function getOrmModel(
  instanceId: number,
  minutes: number,
  weight: FlowWeight,
  engine = 'postgres',
): Promise<OrmModel> {
  const [catalog, fks, flow] = await Promise.all([
    query<{
      schema_name: string;
      table_name: string;
      live_tuples: number;
      dead_tuples: number;
      size_bytes: number;
    }>(
      `select schema_name, table_name, live_tuples, dead_tuples, size_bytes
         from buho.vacuum_tables
        where instance_id = $1
          and schema_name not in ('pg_catalog', 'information_schema', 'pg_toast')
        order by size_bytes desc nulls last`,
      [instanceId],
    ),
    query<{
      from_schema: string;
      from_table: string;
      to_schema: string;
      to_table: string;
    }>(
      `select from_schema, from_table, to_schema, to_table
         from buho.table_fks
        where instance_id = $1`,
      [instanceId],
    ).catch(() => []),
    getFlow(instanceId, minutes, weight, 'both', engine, 'aplicacion', 14),
  ]);

  const heatByRelation = new Map(
    flow.allTables.map((tabla) => [
      tabla.relation,
      {
        write: tabla.writeWeight,
        read: tabla.readWeight,
        apps: tabla.roles,
      },
    ]),
  );

  const porSchema = new Map<string, OrmTable[]>();

  const upsertTable = (tabla: OrmTable) => {
    const lista = porSchema.get(tabla.schema) ?? [];
    const idx = lista.findIndex((t) => t.relation === tabla.relation);
    if (idx >= 0) lista[idx] = tabla;
    else lista.push(tabla);
    porSchema.set(tabla.schema, lista);
  };

  for (const fila of catalog) {
    const relation = `${fila.schema_name}.${fila.table_name}`;
    const heat = heatByRelation.get(relation);
    const writeHeat = heat?.write ?? 0;
    const readHeat = heat?.read ?? 0;
    upsertTable({
      schema: fila.schema_name,
      name: fila.table_name,
      relation,
      liveTuples: Number(fila.live_tuples),
      deadTuples: Number(fila.dead_tuples),
      sizeBytes: Number(fila.size_bytes),
      writeHeat,
      readHeat,
      heat: writeHeat + readHeat,
      attributed: writeHeat + readHeat > 0,
      apps: heat?.apps ?? [],
    });
  }

  for (const tabla of flow.allTables) {
    if ((porSchema.get(tabla.schema) ?? []).some((t) => t.relation === tabla.relation)) continue;
    const name = tabla.relation.split('.').slice(1).join('.') || tabla.relation;
    upsertTable({
      schema: tabla.schema,
      name,
      relation: tabla.relation,
      liveTuples: 0,
      deadTuples: 0,
      sizeBytes: 0,
      writeHeat: tabla.writeWeight,
      readHeat: tabla.readWeight,
      heat: tabla.writeWeight + tabla.readWeight,
      attributed: true,
      apps: tabla.roles,
    });
  }

  const schemas: OrmSchema[] = [...porSchema.entries()]
    .map(([name, tables]) => {
      const sorted = tables.sort((a, b) => b.sizeBytes - a.sizeBytes || b.heat - a.heat);
      return {
        name,
        tables: sorted,
        heat: sorted.reduce((suma, t) => suma + t.heat, 0),
        tableCount: sorted.length,
        sizeBytes: sorted.reduce((suma, t) => suma + t.sizeBytes, 0),
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes || b.tableCount - a.tableCount);

  const allTables = schemas.flatMap((s) => s.tables);
  const tableByRelation = new Map(allTables.map((t) => [t.relation, t]));
  const maxSize = Math.max(...allTables.map((t) => t.sizeBytes), 1);
  const maxHeat = Math.max(...allTables.map((t) => t.heat), 0.001);

  const nodes: OrmNode[] = [];
  for (const schema of schemas) {
    nodes.push({
      id: schemaNodeId(schema.name),
      kind: 'schema',
      label: schema.name,
      sizeBytes: schema.sizeBytes,
      liveTuples: schema.tables.reduce((s, t) => s + t.liveTuples, 0),
      writeHeat: schema.tables.reduce((s, t) => s + t.writeHeat, 0),
      readHeat: schema.tables.reduce((s, t) => s + t.readHeat, 0),
      heat: schema.heat,
    });
    for (const tabla of schema.tables) {
      nodes.push({
        id: tableNodeId(tabla.relation),
        kind: 'table',
        label: tabla.name,
        schema: tabla.schema,
        sizeBytes: tabla.sizeBytes,
        liveTuples: tabla.liveTuples,
        writeHeat: tabla.writeHeat,
        readHeat: tabla.readHeat,
        heat: tabla.heat,
        table: tabla,
      });
    }
  }

  const links: OrmLink[] = [];

  for (const tabla of allTables) {
    links.push({
      source: tableNodeId(tabla.relation),
      target: schemaNodeId(tabla.schema),
      kind: 'membership',
      traffic: 0,
      writeTraffic: 0,
      readTraffic: 0,
    });
  }

  for (const fk of fks) {
    const fromRel = `${fk.from_schema}.${fk.from_table}`;
    const toRel = `${fk.to_schema}.${fk.to_table}`;
    if (!tableByRelation.has(fromRel) && !tableByRelation.has(toRel)) continue;

    const child = tableByRelation.get(fromRel);
    const parent = tableByRelation.get(toRel);
    const traffic = (child?.heat ?? 0) + (parent?.heat ?? 0);
    const writeTraffic = (child?.writeHeat ?? 0) + (parent?.writeHeat ?? 0);
    const readTraffic = (child?.readHeat ?? 0) + (parent?.readHeat ?? 0);

    links.push({
      source: tableNodeId(fromRel),
      target: tableNodeId(toRel),
      kind: 'fk',
      traffic,
      writeTraffic,
      readTraffic,
    });

    if (traffic > 0) {
      links.push({
        source: tableNodeId(fromRel),
        target: tableNodeId(toRel),
        kind: 'traffic',
        traffic,
        writeTraffic,
        readTraffic,
      });
    }
  }

  const maxTraffic = Math.max(...links.map((l) => l.traffic), 0.001);

  return {
    schemas,
    nodes,
    links,
    totalTables: allTables.length,
    foreignKeys: fks.length,
    attributedTables: allTables.filter((t) => t.attributed).length,
    maxSize,
    maxHeat,
    maxTraffic,
  };
}
