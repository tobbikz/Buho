import { getFlow, type FlowActor, type FlowDirection, type FlowLink, type FlowNode } from './flow';
import { buildFleetHotTablesSankey, tableHeat } from './flow-graph';
import { query } from './db';
import type { FlowWeight } from '@buho/core';

export interface FleetFlowTable {
  instanceId: number;
  alias: string;
  engine: string;
  relation: string;
  schema: string;
  weight: number;
  writeWeight: number;
  readWeight: number;
  rows: number;
  calls: number;
  execMs: number;
  byOperation: Record<string, number | undefined>;
  actors: string[];
}

export interface FleetFlowResult {
  nodes: FlowNode[];
  links: FlowLink[];
  tables: FleetFlowTable[];
  instances: number;
  withTraffic: number;
  silent: { alias: string; engine: string; statements: number }[];
  weightAttributed: number;
  weightTotal: number;
  writeTotal: number;
  readTotal: number;
}

async function fleetInstances(): Promise<{ instanceId: number; alias: string; engine: string }[]> {
  const rows = await query<{ instance_id: number; alias: string; engine: string }>(
    `select instance_id, alias, coalesce(engine, 'postgres') as engine
       from buho.instances
      order by alias`,
  );
  return rows.map((fila) => ({
    instanceId: Number(fila.instance_id),
    alias: fila.alias,
    engine: fila.engine,
  }));
}

export async function getFleetFlow(
  minutes: number,
  weight: FlowWeight,
  topTables = 20,
): Promise<FleetFlowResult> {
  const instancias = await fleetInstances();

  const flujos = await Promise.all(
    instancias.map(async (instancia) => ({
      instancia,
      flujo: await getFlow(instancia.instanceId, minutes, weight, 'both', instancia.engine, 'aplicacion', 60),
    })),
  );

  const tablas: FleetFlowTable[] = [];
  const silent: FleetFlowResult['silent'] = [];
  let pesoAtribuido = 0;
  let pesoTotal = 0;
  let writeTotal = 0;
  let readTotal = 0;
  let conTrafico = 0;

  for (const { instancia, flujo } of flujos) {
    pesoAtribuido += flujo.weightAttributed;
    pesoTotal += flujo.weightTotal;
    writeTotal += flujo.writeTotal;
    readTotal += flujo.readTotal;

    if (flujo.tables.length === 0) {
      silent.push({
        alias: instancia.alias,
        engine: instancia.engine,
        statements: flujo.statements,
      });
      continue;
    }
    conTrafico += 1;

    for (const tabla of flujo.tables) {
      const heat = tableHeat(tabla, weight);
      if (heat <= 0) continue;
      tablas.push({
        instanceId: instancia.instanceId,
        alias: instancia.alias,
        engine: instancia.engine,
        relation: tabla.relation,
        schema: tabla.schema,
        weight: heat,
        writeWeight: tabla.writeWeight,
        readWeight: tabla.readWeight,
        rows: tabla.rows,
        calls: tabla.calls,
        execMs: tabla.execMs,
        byOperation: tabla.byOperation as Record<string, number | undefined>,
        actors: tabla.roles,
      });
    }
  }

  tablas.sort((a, b) => b.weight - a.weight);
  const visibles = tablas.slice(0, topTables);
  const graph = buildFleetHotTablesSankey(visibles, topTables);

  return {
    nodes: graph.nodes,
    links: graph.links,
    tables: visibles,
    instances: instancias.length,
    withTraffic: conTrafico,
    silent,
    weightAttributed: pesoAtribuido,
    weightTotal: pesoTotal,
    writeTotal,
    readTotal,
  };
}

/** @deprecated direction ignored — kept for topology snapshots */
export type { FlowActor, FlowDirection };
