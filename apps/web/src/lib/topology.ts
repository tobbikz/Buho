import { query } from './db';
import { getFlow, type FlowActor, type FlowDirection } from './flow';

/**
 * Topología app ↔ tabla persistida semana a semana.
 *
 * El flujo vivo ya sabe quién toca qué. Aquí se congela un snapshot semanal
 * para poder preguntar "¿cambió el grafo desde el deploy?" sin rehacer el
 * análisis léxico sobre meses de statement_stats.
 */

export interface TopologyEdge {
  weekStart: Date;
  actor: string;
  schemaName: string;
  relation: string;
  direction: FlowDirection;
  weight: number;
  samples: number;
}

export interface TopologyWeek {
  weekStart: Date;
  edges: TopologyEdge[];
  actors: number;
  tables: number;
  totalWeight: number;
}

/** Lunes 00:00 UTC de la semana que contiene `at`. */
export function weekStartOf(at = new Date()): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay(); // 0=domingo
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Materializa el flujo de la última semana en `buho.topology_edges`.
 *
 * Idempotente por (instance, week, actor, schema, relation, direction).
 * Pensado para correrse desde el mantenimiento del collector una vez al día.
 */
export async function snapshotTopologyWeek(
  instanceId: number,
  engine = 'postgres',
  actorKind: FlowActor = 'aplicacion',
  at = new Date(),
): Promise<number> {
  const weekStart = weekStartOf(at);
  // Ventana: desde el lunes hasta ahora (o 7 días si estamos mid-week con poco dato).
  const minutes = Math.max(
    60,
    Math.min(10_080, Math.round((at.getTime() - weekStart.getTime()) / 60_000) || 10_080),
  );

  let written = 0;
  for (const direction of ['escritura', 'lectura'] as FlowDirection[]) {
    const flow = await getFlow(instanceId, minutes, 'time', direction, engine, actorKind, 40);
    // Reconstruir aristas actor→tabla desde nodes/links es frágil; mejor desde tables.
    for (const table of flow.tables) {
      for (const role of table.roles) {
        const weight = table.execMs / Math.max(1, table.roles.length);
        await query(
          `insert into buho.topology_edges
             (instance_id, week_start, actor, schema_name, relation, direction, weight, samples)
           values ($1, $2::date, $3, $4, $5, $6, $7, $8)
           on conflict (instance_id, week_start, actor, schema_name, relation, direction)
           do update set weight = excluded.weight, samples = excluded.samples, captured_at = now()`,
          [
            instanceId,
            weekStart.toISOString().slice(0, 10),
            role,
            table.schema,
            table.relation,
            direction,
            weight,
            Math.max(1, Math.round(table.calls)),
          ],
        );
        written += 1;
      }
    }
  }
  return written;
}

export async function listTopologyWeeks(instanceId: number, limit = 12): Promise<Date[]> {
  const rows = await query<{ week_start: Date }>(
    `select distinct week_start
       from buho.topology_edges
      where instance_id = $1
      order by week_start desc
      limit $2`,
    [instanceId, limit],
  );
  return rows.map((r) => r.week_start);
}

export async function getTopologyWeek(
  instanceId: number,
  weekStart: Date,
  direction: FlowDirection = 'escritura',
): Promise<TopologyWeek> {
  const rows = await query<{
    week_start: Date;
    actor: string;
    schema_name: string;
    relation: string;
    direction: FlowDirection;
    weight: number;
    samples: number;
  }>(
    `select week_start, actor, schema_name, relation, direction, weight, samples
       from buho.topology_edges
      where instance_id = $1
        and week_start = $2::date
        and direction = $3
      order by weight desc
      limit 200`,
    [instanceId, weekStart.toISOString().slice(0, 10), direction],
  );

  const edges: TopologyEdge[] = rows.map((r) => ({
    weekStart: r.week_start,
    actor: r.actor,
    schemaName: r.schema_name,
    relation: r.relation,
    direction: r.direction,
    weight: Number(r.weight),
    samples: Number(r.samples),
  }));

  const actors = new Set(edges.map((e) => e.actor)).size;
  const tables = new Set(edges.map((e) => `${e.schemaName}.${e.relation}`)).size;
  const totalWeight = edges.reduce((s, e) => s + e.weight, 0);

  return {
    weekStart,
    edges,
    actors,
    tables,
    totalWeight,
  };
}

/**
 * Diff entre dos semanas: aristas nuevas, desaparecidas y con cambio > 2×.
 */
export async function diffTopologyWeeks(
  instanceId: number,
  newer: Date,
  older: Date,
  direction: FlowDirection = 'escritura',
): Promise<{
  added: TopologyEdge[];
  removed: TopologyEdge[];
  grown: { edge: TopologyEdge; before: number; ratio: number }[];
}> {
  const [a, b] = await Promise.all([
    getTopologyWeek(instanceId, newer, direction),
    getTopologyWeek(instanceId, older, direction),
  ]);
  const key = (e: TopologyEdge) => `${e.actor}|${e.schemaName}.${e.relation}`;
  const mapA = new Map(a.edges.map((e) => [key(e), e]));
  const mapB = new Map(b.edges.map((e) => [key(e), e]));

  const added: TopologyEdge[] = [];
  const removed: TopologyEdge[] = [];
  const grown: { edge: TopologyEdge; before: number; ratio: number }[] = [];

  for (const [k, edge] of mapA) {
    const prev = mapB.get(k);
    if (!prev) added.push(edge);
    else if (prev.weight > 0 && edge.weight / prev.weight >= 2) {
      grown.push({ edge, before: prev.weight, ratio: edge.weight / prev.weight });
    }
  }
  for (const [k, edge] of mapB) {
    if (!mapA.has(k)) removed.push(edge);
  }

  return { added, removed, grown: grown.sort((x, y) => y.ratio - x.ratio) };
}
