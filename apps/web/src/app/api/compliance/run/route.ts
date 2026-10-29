import { NextResponse } from 'next/server';
import { openEngine, type InstanceConfig } from '@buho/core';
import { runCompliancePack } from '@buho/checks';
import { Store } from '@buho/store';

export const dynamic = 'force-dynamic';

/** POST { alias, pack: 'cis-postgres'|'cis-mssql'|'stig-postgres' } */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    alias: string;
    pack?: 'cis-postgres' | 'cis-mssql' | 'stig-postgres';
  };
  if (!body.alias) {
    return NextResponse.json({ error: 'alias required' }, { status: 400 });
  }
  const storeUrl = process.env.BUHO_STORE_URL;
  if (!storeUrl) {
    return NextResponse.json({ error: 'BUHO_STORE_URL not set' }, { status: 500 });
  }
  const pack = body.pack ?? 'cis-postgres';
  const store = new Store(storeUrl);
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
