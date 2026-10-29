import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { storeUrl } from '@/lib/db';
import { listInstances } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/** GET /api/v1/instances/:alias/checks — latest check_results per check_id */
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
  const pool = new Pool({ connectionString: storeUrl(), max: 2 });
  try {
    const instances = await listInstances();
    const hit = instances.find((i) => i.alias === alias);
    if (!hit) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const r = await pool.query(
      `select distinct on (check_id)
              check_id, severity, title, object, message, remediation, ts
         from buho.check_results
        where instance_id = $1
          and ts > now() - interval '24 hours'
        order by check_id, ts desc`,
      [hit.instanceId],
    );
    return NextResponse.json({
      alias,
      instanceId: hit.instanceId,
      score: hit.score,
      count: r.rows.length,
      checks: r.rows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await pool.end();
  }
}
