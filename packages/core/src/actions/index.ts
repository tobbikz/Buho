/**
 * Gated destructive / mutative actions for Búho Deep Platform.
 * Always require actions.enabled on the instance; caller must audit.
 */
import type { Pool } from 'pg';
import type { InstanceConfig } from '../types';
import { tagged } from '../tag';

export type ActionKind =
  | 'kill_session'
  | 'cancel_query'
  | 'pause_dag'
  | 'unpause_dag'
  | 'clear_ti'
  | 'rewind_consumer';

export interface ActionRequest {
  kind: ActionKind;
  instance: InstanceConfig;
  actor: string;
  reason: string;
  /** PG/MSSQL backend pid or session id */
  pid?: number;
  /** Airflow */
  dagId?: string;
  taskId?: string;
  dagRunId?: string;
  /** Kafka */
  groupId?: string;
  topic?: string;
  partition?: number;
  offset?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

function assertEnabled(instance: InstanceConfig, flag: keyof NonNullable<InstanceConfig['actions']>) {
  const a = instance.actions;
  if (!a?.enabled) {
    throw new Error('Actions disabled on this instance (set actions.enabled=true)');
  }
  if (flag !== 'enabled' && a[flag] === false) {
    throw new Error(`Action not permitted: ${String(flag)}`);
  }
}

export async function killPostgresSession(
  pool: Pool,
  instance: InstanceConfig,
  pid: number,
): Promise<ActionResult> {
  assertEnabled(instance, 'allowKillSession');
  const rows = await pool.query<{ ok: boolean }>(
    tagged(`select pg_terminate_backend($1) as ok`),
    [pid],
  );
  const ok = Boolean(rows.rows[0]?.ok);
  return {
    ok,
    message: ok ? `Terminated backend ${pid}` : `pg_terminate_backend(${pid}) returned false`,
  };
}

export async function cancelPostgresQuery(
  pool: Pool,
  instance: InstanceConfig,
  pid: number,
): Promise<ActionResult> {
  assertEnabled(instance, 'allowCancelQuery');
  const rows = await pool.query<{ ok: boolean }>(
    tagged(`select pg_cancel_backend($1) as ok`),
    [pid],
  );
  const ok = Boolean(rows.rows[0]?.ok);
  return {
    ok,
    message: ok ? `Cancelled query on backend ${pid}` : `pg_cancel_backend(${pid}) returned false`,
  };
}

export async function pauseAirflowDag(
  instance: InstanceConfig,
  dagId: string,
  pause: boolean,
): Promise<ActionResult> {
  assertEnabled(instance, 'allowAirflowDagPause');
  const { createAirflowHandle } = await import('../airflow/client');
  const handle = createAirflowHandle(instance, 10_000);
  try {
    const body = await handle.command({
      airflow: pause ? 'pauseDag' : 'unpauseDag',
      dagId,
    });
    return { ok: true, message: `${pause ? 'Paused' : 'Unpaused'} DAG ${dagId}`, detail: body };
  } finally {
    await handle.close();
  }
}

export async function runAction(req: ActionRequest, pool?: Pool): Promise<ActionResult> {
  switch (req.kind) {
    case 'kill_session':
      if (!pool || req.pid == null) throw new Error('kill_session requires pool + pid');
      return killPostgresSession(pool, req.instance, req.pid);
    case 'cancel_query':
      if (!pool || req.pid == null) throw new Error('cancel_query requires pool + pid');
      return cancelPostgresQuery(pool, req.instance, req.pid);
    case 'pause_dag':
      if (!req.dagId) throw new Error('pause_dag requires dagId');
      return pauseAirflowDag(req.instance, req.dagId, true);
    case 'unpause_dag':
      if (!req.dagId) throw new Error('unpause_dag requires dagId');
      return pauseAirflowDag(req.instance, req.dagId, false);
    case 'clear_ti':
      throw new Error('clear_ti not implemented yet — use Airflow UI / API manually');
    case 'rewind_consumer':
      throw new Error(
        'rewind_consumer requires dual-control confirmation — not enabled in this build',
      );
    default:
      throw new Error(`Unknown action: ${(req as ActionRequest).kind}`);
  }
}
