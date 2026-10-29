import { NextResponse } from 'next/server';
import { createPool, runAction, type ActionKind, type InstanceConfig } from '@buho/core';
import { Store } from '@buho/store';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { storeUrl } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/actions — gated mutative actions for agents.
 * Requires Bearer + BUHO_API_ALLOW_WRITE=true + instance actions.enabled.
 */
export async function POST(req: Request) {
  if (!apiTokenConfigured()) {
    return NextResponse.json({ error: 'BUHO_API_TOKEN not configured' }, { status: 503 });
  }
  if (!verifyApiBearer(req.headers.get('authorization'))) {
    return unauthorizedJson();
  }
  if (process.env['BUHO_API_ALLOW_WRITE'] !== 'true') {
    return NextResponse.json(
      { error: 'Write disabled. Set BUHO_API_ALLOW_WRITE=true for agent actions.' },
      { status: 403 },
    );
  }

  const body = (await req.json()) as {
    kind: ActionKind;
    alias: string;
    reason?: string;
    pid?: number;
    dagId?: string;
    actor?: string;
  };

  if (!body.kind || !body.alias) {
    return NextResponse.json({ error: 'kind and alias required' }, { status: 400 });
  }
  if (!body.reason || body.reason.trim().length < 3) {
    return NextResponse.json({ error: 'reason required (min 3 chars)' }, { status: 400 });
  }

  const store = new Store(storeUrl());
  try {
    const targets = await store.listMonitorTargets();
    const target = targets.find((t) => t.alias === body.alias && t.enabled);
    if (!target) {
      return NextResponse.json({ error: `instance ${body.alias} not found` }, { status: 404 });
    }

    const instance: InstanceConfig = {
      alias: target.alias,
      engine: target.engine as InstanceConfig['engine'],
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.username,
      password: target.password,
      ssl: target.ssl,
      environment: target.environment,
      actions: {
        enabled: Boolean((target.endpoint as { actions?: { enabled?: boolean } })?.actions?.enabled),
        allowKillSession: true,
        allowCancelQuery: true,
        allowAirflowDagPause: true,
        ...((target.endpoint as { actions?: InstanceConfig['actions'] })?.actions ?? {}),
      },
      airflow: (target.endpoint as { airflow?: InstanceConfig['airflow'] })?.airflow,
      kafka: (target.endpoint as { kafka?: InstanceConfig['kafka'] })?.kafka,
    };

    let pool = undefined as ReturnType<typeof createPool> | undefined;
    try {
      if (body.kind === 'kill_session' || body.kind === 'cancel_query') {
        pool = createPool(instance, { statementTimeoutMs: 10_000, connectTimeoutMs: 5_000 });
      }
      const result = await runAction(
        {
          kind: body.kind,
          instance,
          actor: body.actor ?? 'api-v1',
          reason: body.reason,
          pid: body.pid,
          dagId: body.dagId,
        },
        pool,
      );
      await store.recordActionAudit({
        alias: body.alias,
        kind: body.kind,
        actor: body.actor ?? 'api-v1',
        reason: body.reason,
        payload: { pid: body.pid, dagId: body.dagId },
        ok: result.ok,
        message: result.message,
      });
      return NextResponse.json(result);
    } finally {
      await pool?.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.recordActionAudit({
      alias: body.alias,
      kind: body.kind,
      actor: body.actor ?? 'api-v1',
      reason: body.reason ?? '',
      ok: false,
      message,
    });
    return NextResponse.json({ ok: false, message }, { status: 400 });
  } finally {
    await store.close();
  }
}
