import { query } from './db';
import { logConsoleEvent } from './users';
import type { PlanFinding, PlanNode } from '@buho/core';

/**
 * Planes de ejecución vistos desde la consola.
 *
 * La consola **encarga** el EXPLAIN y espera el resultado; no se conecta a la
 * instancia monitoreada. Ver el comentario de `plan_requests` en el schema del
 * store para el porqué.
 */

export type PlanMode = 'estimate' | 'generic' | 'analyze';
export type PlanState = 'pendiente' | 'corriendo' | 'listo' | 'error';

export const MODE_LABEL: Record<PlanMode, string> = {
  estimate: 'Plan estimado',
  generic: 'Plan genérico',
  analyze: 'Ejecutado con ANALYZE',
};

export const MODE_HINT: Record<PlanMode, string> = {
  estimate: 'Planifica sin ejecutar. Necesita una consulta con valores concretos.',
  generic:
    'Planifica el texto normalizado con sus $1, sin ejecutar nada. Requiere PostgreSQL 16 o superior.',
  analyze:
    'Ejecuta la consulta de verdad para traer filas reales, tiempos y derrames a disco. Sólo lectura, y siempre dentro de una transacción que se revierte.',
};

export interface PlanRequest {
  requestId: number;
  instanceId: number;
  queryid: string | null;
  sql: string;
  mode: PlanMode;
  state: PlanState;
  requestedBy: string;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  plan: PlanNode | null;
  planText: string | null;
  findings: PlanFinding[];
  planningMs: number | null;
  executionMs: number | null;
  totalCost: number | null;
}

function toRequest(row: Record<string, unknown>): PlanRequest {
  return {
    requestId: Number(row['request_id']),
    instanceId: Number(row['instance_id']),
    queryid: row['queryid'] === null || row['queryid'] === undefined ? null : String(row['queryid']),
    sql: String(row['sql']),
    mode: String(row['mode']) as PlanMode,
    state: String(row['state']) as PlanState,
    requestedBy: String(row['requested_by']),
    requestedAt: new Date(row['requested_at'] as string),
    startedAt: row['started_at'] ? new Date(row['started_at'] as string) : null,
    finishedAt: row['finished_at'] ? new Date(row['finished_at'] as string) : null,
    error: row['error'] ? String(row['error']) : null,
    plan: (row['plan'] as PlanNode | null) ?? null,
    planText: row['plan_text'] ? String(row['plan_text']) : null,
    findings: (row['findings'] as PlanFinding[] | null) ?? [],
    planningMs: row['planning_ms'] === null ? null : Number(row['planning_ms']),
    executionMs: row['execution_ms'] === null ? null : Number(row['execution_ms']),
    totalCost: row['total_cost'] === null ? null : Number(row['total_cost']),
  };
}

const COLUMNS = `request_id, instance_id, queryid, sql, mode, state, requested_by, requested_at,
                 started_at, finished_at, error, plan, plan_text, findings, planning_ms,
                 execution_ms, total_cost`;

/**
 * Encola un EXPLAIN.
 *
 * Se reutiliza un encargo idéntico y reciente en vez de crear otro: apretar dos
 * veces el botón, o que el navegador reintente el envío, no debe correr dos
 * EXPLAIN ANALYZE contra la base del cliente.
 */
export async function requestPlan(
  instanceId: number,
  sql: string,
  mode: PlanMode,
  username: string,
  queryid?: string | null,
): Promise<number> {
  const pending = await query(
    `select request_id from buho.plan_requests
      where instance_id = $1 and sql = $2 and mode = $3
        and (state in ('pendiente', 'corriendo')
             or (state = 'listo' and finished_at > now() - interval '20 seconds'))
      order by requested_at desc limit 1`,
    [instanceId, sql, mode],
  );
  const existing = pending[0];
  if (existing) return Number(existing['request_id']);

  const rows = await query(
    `insert into buho.plan_requests (instance_id, queryid, sql, mode, requested_by)
          values ($1, $2, $3, $4, $5)
       returning request_id`,
    [instanceId, queryid ?? null, sql, mode, username],
  );

  await logConsoleEvent(
    username,
    `explain:${mode}`,
    `instancia ${instanceId}${queryid ? ` · consulta ${queryid}` : ''}`,
  );

  return Number(rows[0]?.['request_id']);
}

export async function getPlanRequest(requestId: number): Promise<PlanRequest | null> {
  const rows = await query(`select ${COLUMNS} from buho.plan_requests where request_id = $1`, [
    requestId,
  ]);
  const row = rows[0];
  return row ? toRequest(row) : null;
}

/** Último plan listo de una consulta, para abrir la pantalla con algo ya hecho. */
export async function getLatestPlan(
  instanceId: number,
  queryid: string,
): Promise<PlanRequest | null> {
  const rows = await query(
    `select ${COLUMNS} from buho.plan_requests
      where instance_id = $1 and queryid = $2 and state = 'listo'
      order by requested_at desc limit 1`,
    [instanceId, queryid],
  );
  const row = rows[0];
  return row ? toRequest(row) : null;
}

/**
 * Historial de planes de una consulta.
 *
 * Es el valor que justifica guardar los encargos: "esta consulta se puso lenta
 * el martes" se contesta comparando el costo y la forma del plan de antes con la
 * de ahora.
 */
export async function getPlanHistory(
  instanceId: number,
  queryid: string,
  limit = 12,
): Promise<PlanRequest[]> {
  const rows = await query(
    `select ${COLUMNS} from buho.plan_requests
      where instance_id = $1 and queryid = $2
      order by requested_at desc limit $3`,
    [instanceId, queryid, limit],
  );
  return rows.map(toRequest);
}

export async function getStatementText(
  instanceId: number,
  queryid: string,
): Promise<{
  query: string;
  truncated: boolean;
  database: string | null;
  username: string | null;
} | null> {
  // La base y el rol no están en statement_texts sino en los deltas: una misma
  // consulta normalizada puede venir de varias bases y varios roles, así que se
  // toma el último que la ejecutó.
  const rows = await query(
    `select t.query, t.truncated,
            (select s.database from buho.statement_stats s
              where s.instance_id = t.instance_id and s.queryid = t.queryid
              order by s.ts desc limit 1) as database,
            (select s.username from buho.statement_stats s
              where s.instance_id = t.instance_id and s.queryid = t.queryid
              order by s.ts desc limit 1) as username
       from buho.statement_texts t
      where t.instance_id = $1 and t.queryid = $2`,
    [instanceId, queryid],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    query: String(row['query']),
    truncated: row['truncated'] === true,
    database: row['database'] ? String(row['database']) : null,
    username: row['username'] ? String(row['username']) : null,
  };
}

/** Estadísticas acumuladas de la consulta, para el encabezado de la pantalla. */
export async function getStatementSummary(
  instanceId: number,
  queryid: string,
): Promise<{
  calls: number;
  execMs: number;
  meanMs: number;
  rows: number;
  tempWritten: number;
  sharedRead: number;
  sharedHit: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
} | null> {
  const rows = await query(
    `select sum(calls)::bigint as calls, sum(exec_ms) as exec_ms, sum(rows)::bigint as rows,
            sum(temp_written)::bigint as temp_written, sum(shared_read)::bigint as shared_read,
            sum(shared_hit)::bigint as shared_hit,
            min(ts) as first_seen_at, max(ts) as last_seen_at
       from buho.statement_stats
      where instance_id = $1 and queryid = $2`,
    [instanceId, queryid],
  );
  const row = rows[0];
  if (!row || row['calls'] === null) return null;

  const calls = Number(row['calls'] ?? 0);
  const execMs = Number(row['exec_ms'] ?? 0);
  return {
    calls,
    execMs,
    meanMs: calls > 0 ? execMs / calls : 0,
    rows: Number(row['rows'] ?? 0),
    tempWritten: Number(row['temp_written'] ?? 0),
    sharedRead: Number(row['shared_read'] ?? 0),
    sharedHit: Number(row['shared_hit'] ?? 0),
    firstSeenAt: row['first_seen_at'] ? new Date(row['first_seen_at'] as string) : null,
    lastSeenAt: row['last_seen_at'] ? new Date(row['last_seen_at'] as string) : null,
  };
}

/**
 * ¿Se puede pedir un plan genérico?
 *
 * `EXPLAIN (GENERIC_PLAN)` llegó en PostgreSQL 16. Antes de eso, explicar el
 * texto normalizado con `$1` no era posible sin inventar valores, y sin esta
 * comprobación el botón fallaría con un error de sintaxis que no explica nada.
 */
export async function supportsGenericPlan(instanceId: number): Promise<boolean> {
  const rows = await query(
    'select version_num from buho.instance_capabilities where instance_id = $1',
    [instanceId],
  );
  const version = Number(rows[0]?.['version_num'] ?? 0);
  return version >= 160_000;
}

/** El texto trae `$1`, así que sólo se puede explicar en modo genérico. */
export function isParameterized(sql: string): boolean {
  return /\$\d+/.test(sql);
}
