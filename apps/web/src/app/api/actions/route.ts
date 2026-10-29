import { NextResponse } from 'next/server';
import { createPool, runAction, type ActionKind, type InstanceConfig } from '@buho/core';
import { Store } from '@buho/store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/actions — gated mutative actions (Deep Platform W4).
 * Body: { kind, alias, reason, pid?, dagId?, actor? }
 */
export async function POST(req: Request) {
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

  const storeUrl = process.env.BUHO_STORE_URL;
  if (!storeUrl) {
    return NextResponse.json({ error: 'BUHO_STORE_URL not set' }, { status: 500 });
  }

  const store = new Store(storeUrl);
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
      // Actions must be explicitly enabled in endpoint jsonb.actions or we refuse.
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
          actor: body.actor ?? 'console',
          reason: body.reason,
          pid: body.pid,
          dagId: body.dagId,
        },
        pool,
      );
      await store.recordActionAudit({
        alias: body.alias,
        kind: body.kind,
        actor: body.actor ?? 'console',
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
      actor: body.actor ?? 'console',
      reason: body.reason ?? '',
      ok: false,
      message,
    });
    return NextResponse.json({ ok: false, message }, { status: 400 });
  } finally {
    await store.close();
  }
}
