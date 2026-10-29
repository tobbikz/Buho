import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { storeUrl } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/v1/compliance/latest — latest CIS/STIG runs per instance */
export async function GET(req: Request) {
  if (!apiTokenConfigured()) {
    return NextResponse.json({ error: 'BUHO_API_TOKEN not configured' }, { status: 503 });
  }
  if (!verifyApiBearer(req.headers.get('authorization'))) {
    return unauthorizedJson();
  }
  const pool = new Pool({ connectionString: storeUrl(), max: 2 });
  try {
    const r = await pool.query(
      `select distinct on (r.instance_id, r.pack)
              i.alias, i.engine, r.pack, r.score, r.ts, jsonb_array_length(r.controls) as controls
         from buho.compliance_runs r
         join buho.instances i on i.instance_id = r.instance_id
        order by r.instance_id, r.pack, r.ts desc`,
    );
    return NextResponse.json({ count: r.rows.length, runs: r.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await pool.end();
  }
}
