import { NextResponse } from 'next/server';
import { Store } from '@buho/store';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { storeUrl } from '@/lib/db';
import { listInstances } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const DEFAULT_METRICS = [
  'connections_used_pct',
  'connections_total',
  'connections_max',
  'blocked_sessions',
  'uptime_seconds',
  'db_cache_hit_pct',
  'replication_replay_lag_seconds',
  'host_cpu_pct',
  'host_mem_used_pct',
];

/** GET /api/v1/instances/:alias/metrics?names=a,b,c */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ alias: string }> },
) {
  if (!apiTokenConfigured()) {
    return NextResponse.json({ error: 'BUHO_API_TOKEN not configured' }, { status: 503 });
  }
  if (!verifyApiBearer(req.headers.get('authorization'))) {
    return unauthorizedJson();
  }
  const { alias } = await ctx.params;
  const url = new URL(req.url);
  const namesParam = url.searchParams.get('names');
  const names = namesParam
    ? namesParam.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_METRICS;

  const store = new Store(storeUrl());
  try {
    const instances = await listInstances();
    const hit = instances.find((i) => i.alias === alias);
    if (!hit) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const metrics = await store.latestMetrics(hit.instanceId, names);
    return NextResponse.json({
      alias,
      instanceId: hit.instanceId,
      engine: hit.engine,
      metrics,
      window: '15m',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await store.close();
  }
}
