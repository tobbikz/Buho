import type { FlowLink, FlowNode, FlowTable } from './flow';

export function tableWeight(table: FlowTable, weight: 'rows' | 'time' | 'calls'): number {
  if (weight === 'calls') return table.calls;
  if (weight === 'time') return table.execMs;
  return table.rows;
}

export function tableHeat(table: FlowTable, weight: 'rows' | 'time' | 'calls'): number {
  return table.writeWeight + table.readWeight;
}

/** Writes/Reads → schema → table (shared schema and table nodes). */
export function buildHotTablesSankey(
  tables: FlowTable[],
  topTables: number,
  weight: 'rows' | 'time' | 'calls',
): { nodes: FlowNode[]; links: FlowLink[] } {
  const ranked = [...tables]
    .filter((t) => t.writeWeight > 0 || t.readWeight > 0)
    .sort((a, b) => tableHeat(b, weight) - tableHeat(a, weight))
    .slice(0, topTables);

  const nodos: FlowNode[] = [];
  const indice = new Map<string, number>();
  const nodo = (clave: string, depth: number, label: string): number => {
    const existente = indice.get(clave);
    if (existente !== undefined) return existente;
    const nuevo = nodos.length;
    nodos.push({ name: clave, depth, label });
    indice.set(clave, nuevo);
    return nuevo;
  };

  const nombresRepetidos = new Set<string>();
  const vistos = new Set<string>();
  for (const tabla of ranked) {
    const corto = tabla.relation.split('.').slice(1).join('.') || tabla.relation;
    if (vistos.has(corto)) nombresRepetidos.add(corto);
    vistos.add(corto);
  }
  const etiquetaTabla = (relacion: string): string => {
    const corto = relacion.split('.').slice(1).join('.') || relacion;
    return nombresRepetidos.has(corto) ? relacion : corto;
  };

  const writes = nodo('traffic:writes', 0, 'Writes');
  const reads = nodo('traffic:reads', 0, 'Reads');

  const writeToSchema = new Map<string, number>();
  const readToSchema = new Map<string, number>();
  const writeSchemaTable = new Map<string, number>();
  const readSchemaTable = new Map<string, number>();

  for (const tabla of ranked) {
    const esquema = tabla.schema;
    if (tabla.writeWeight > 0) {
      writeToSchema.set(esquema, (writeToSchema.get(esquema) ?? 0) + tabla.writeWeight);
      writeSchemaTable.set(
        `${esquema}\u0000${tabla.relation}`,
        (writeSchemaTable.get(`${esquema}\u0000${tabla.relation}`) ?? 0) + tabla.writeWeight,
      );
    }
    if (tabla.readWeight > 0) {
      readToSchema.set(esquema, (readToSchema.get(esquema) ?? 0) + tabla.readWeight);
      readSchemaTable.set(
        `${esquema}\u0000${tabla.relation}`,
        (readSchemaTable.get(`${esquema}\u0000${tabla.relation}`) ?? 0) + tabla.readWeight,
      );
    }
  }

  const enlaces: FlowLink[] = [];

  for (const [esquema, peso] of writeToSchema) {
    enlaces.push({
      source: writes,
      target: nodo(`schema:${esquema}`, 1, esquema),
      value: peso,
      kind: 'write',
    });
  }
  for (const [esquema, peso] of readToSchema) {
    enlaces.push({
      source: reads,
      target: nodo(`schema:${esquema}`, 1, esquema),
      value: peso,
      kind: 'read',
    });
  }
  for (const [clave, peso] of writeSchemaTable) {
    const [esquema = '', relacion = ''] = clave.split('\u0000');
    enlaces.push({
      source: nodo(`schema:${esquema}`, 1, esquema),
      target: nodo(`table:${relacion}`, 2, etiquetaTabla(relacion)),
      value: peso,
      kind: 'write',
    });
  }
  for (const [clave, peso] of readSchemaTable) {
    const [esquema = '', relacion = ''] = clave.split('\u0000');
    enlaces.push({
      source: nodo(`schema:${esquema}`, 1, esquema),
      target: nodo(`table:${relacion}`, 2, etiquetaTabla(relacion)),
      value: peso,
      kind: 'read',
    });
  }

  return { nodes: nodos, links: enlaces };
}

/** Fleet: Writes/Reads → instance·schema → table. */
export function buildFleetHotTablesSankey(
  tables: {
    alias: string;
    schema: string;
    relation: string;
    writeWeight: number;
    readWeight: number;
  }[],
  topTables: number,
): { nodes: FlowNode[]; links: FlowLink[] } {
  const ranked = [...tables]
    .filter((t) => t.writeWeight > 0 || t.readWeight > 0)
    .sort((a, b) => b.writeWeight + b.readWeight - (a.writeWeight + a.readWeight))
    .slice(0, topTables);

  const nodos: FlowNode[] = [];
  const indice = new Map<string, number>();
  const nodo = (clave: string, depth: number, label: string): number => {
    const existente = indice.get(clave);
    if (existente !== undefined) return existente;
    const nuevo = nodos.length;
    nodos.push({ name: clave, depth, label });
    indice.set(clave, nuevo);
    return nuevo;
  };

  const writes = nodo('traffic:writes', 0, 'Writes');
  const reads = nodo('traffic:reads', 0, 'Reads');

  const writeToSchema = new Map<string, number>();
  const readToSchema = new Map<string, number>();
  const writeSchemaTable = new Map<string, number>();
  const readSchemaTable = new Map<string, number>();

  for (const tabla of ranked) {
    const schemaKey = `${tabla.alias}\u0000${tabla.schema}`;
    const schemaNode = `schema:${schemaKey}`;
    const tableNode = `table:${tabla.alias}.${tabla.relation}`;
    const schemaLabel = `${tabla.alias} · ${tabla.schema}`;
    const tableLabel = `${tabla.alias} · ${tabla.relation.split('.').slice(1).join('.') || tabla.relation}`;

    nodo(schemaNode, 1, schemaLabel);
    nodo(tableNode, 2, tableLabel);

    if (tabla.writeWeight > 0) {
      writeToSchema.set(schemaKey, (writeToSchema.get(schemaKey) ?? 0) + tabla.writeWeight);
      writeSchemaTable.set(
        `${schemaKey}\u0001${tableNode}`,
        (writeSchemaTable.get(`${schemaKey}\u0001${tableNode}`) ?? 0) + tabla.writeWeight,
      );
    }
    if (tabla.readWeight > 0) {
      readToSchema.set(schemaKey, (readToSchema.get(schemaKey) ?? 0) + tabla.readWeight);
      readSchemaTable.set(
        `${schemaKey}\u0001${tableNode}`,
        (readSchemaTable.get(`${schemaKey}\u0001${tableNode}`) ?? 0) + tabla.readWeight,
      );
    }
  }

  const enlaces: FlowLink[] = [];
  for (const [schemaKey, peso] of writeToSchema) {
    const [alias = '', esquema = ''] = schemaKey.split('\u0000');
    enlaces.push({
      source: writes,
      target: nodo(`schema:${schemaKey}`, 1, `${alias} · ${esquema}`),
      value: peso,
      kind: 'write',
    });
  }
  for (const [schemaKey, peso] of readToSchema) {
    const [alias = '', esquema = ''] = schemaKey.split('\u0000');
    enlaces.push({
      source: reads,
      target: nodo(`schema:${schemaKey}`, 1, `${alias} · ${esquema}`),
      value: peso,
      kind: 'read',
    });
  }
  for (const [clave, peso] of writeSchemaTable) {
    const [schemaKey = '', tableNode = ''] = clave.split('\u0001');
    const [alias = '', esquema = ''] = schemaKey.split('\u0000');
    enlaces.push({
      source: nodo(`schema:${schemaKey}`, 1, `${alias} · ${esquema}`),
      target: nodo(tableNode, 2, tableNode.replace(/^table:/, '').replace('.', ' · ')),
      value: peso,
      kind: 'write',
    });
  }
  for (const [clave, peso] of readSchemaTable) {
    const [schemaKey = '', tableNode = ''] = clave.split('\u0001');
    const [alias = '', esquema = ''] = schemaKey.split('\u0000');
    enlaces.push({
      source: nodo(`schema:${schemaKey}`, 1, `${alias} · ${esquema}`),
      target: nodo(tableNode, 2, tableNode.replace(/^table:/, '').replace('.', ' · ')),
      value: peso,
      kind: 'read',
    });
  }

  return { nodes: nodos, links: enlaces };
}
