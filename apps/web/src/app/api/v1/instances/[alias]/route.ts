import { NextResponse } from 'next/server';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { listInstances } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/** GET /api/v1/instances/:alias */
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
  try {
    const instances = await listInstances();
    const hit = instances.find((i) => i.alias === alias);
    if (!hit) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(hit);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
