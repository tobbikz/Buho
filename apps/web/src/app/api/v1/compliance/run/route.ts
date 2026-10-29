import { NextResponse } from 'next/server';
import { openEngine, type InstanceConfig } from '@buho/core';
import { runCompliancePack } from '@buho/checks';
import { Store } from '@buho/store';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { storeUrl } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** POST /api/v1/compliance/run { alias, pack? } — requires Bearer + BUHO_API_ALLOW_WRITE=true for mutating packs */
export async function POST(req: Request) {
  if (!apiTokenConfigured()) {
    return NextResponse.json({ error: 'BUHO_API_TOKEN not configured' }, { status: 503 });
  }
  if (!verifyApiBearer(req.headers.get('authorization'))) {
    return unauthorizedJson();
  }
  if (process.env['BUHO_API_ALLOW_WRITE'] !== 'true') {
    return NextResponse.json(
      { error: 'Write disabled. Set BUHO_API_ALLOW_WRITE=true to run compliance packs via API.' },
      { status: 403 },
    );
  }

  const body = (await req.json()) as {
    alias: string;
    pack?: 'cis-postgres' | 'cis-mssql' | 'stig-postgres';
  };
  if (!body.alias) {
    return NextResponse.json({ error: 'alias required' }, { status: 400 });
  }
  const pack = body.pack ?? 'cis-postgres';
  const store = new Store(storeUrl());
  try {
    const targets = await store.listMonitorTargets();
    const target = targets.find((t) => t.alias === body.alias && t.enabled);
    if (!target) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
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
    };
    const instanceId = await store.upsertInstance(instance);
    const client = await openEngine(instance);
    try {
      const result = await runCompliancePack(client, pack);
      await store.saveComplianceRun(instanceId, pack, result.score, result.controls);
      return NextResponse.json(result);
    } finally {
      await client.close();
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  } finally {
    await store.close();
  }
}
