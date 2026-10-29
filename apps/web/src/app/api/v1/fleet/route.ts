import { NextResponse } from 'next/server';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { listInstances } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/** GET /api/v1/fleet — fleet snapshot for agents (Bearer BUHO_API_TOKEN). */
export async function GET(req: Request) {
  if (!apiTokenConfigured()) {
    return NextResponse.json({ error: 'BUHO_API_TOKEN not configured' }, { status: 503 });
  }
  if (!verifyApiBearer(req.headers.get('authorization'))) {
    return unauthorizedJson();
  }
  try {
    const instances = await listInstances();
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      count: instances.length,
      instances: instances.map((i) => ({
        instanceId: i.instanceId,
        alias: i.alias,
        engine: i.engine,
        host: i.host,
        port: i.port,
        database: i.database,
        environment: i.environment,
        lastSeenAt: i.lastSeenAt,
        versionText: i.versionText,
        score: i.score,
        critical: i.critical,
        warning: i.warning,
        info: i.info,
        connectionsUsedPct: i.connectionsUsedPct,
        blockedSessions: i.blockedSessions,
        replicationLagSeconds: i.replicationLagSeconds,
        tags: i.tags,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
