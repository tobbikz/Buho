import { NextResponse } from 'next/server';
import { Store } from '@buho/store';
import { verifyApiBearer, unauthorizedJson, apiTokenConfigured } from '@/lib/api-token';
import { storeUrl } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/v1/alerts?status=pending,firing&limit=100 */
export async function GET(req: Request) {
  if (!apiTokenConfigured()) {
    return NextResponse.json({ error: 'BUHO_API_TOKEN not configured' }, { status: 503 });
  }
  if (!verifyApiBearer(req.headers.get('authorization'))) {
    return unauthorizedJson();
  }
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const status = statusParam
    ? (statusParam.split(',').map((s) => s.trim()) as Array<'pending' | 'firing' | 'resolved'>)
    : (['pending', 'firing'] as const);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
  const store = new Store(storeUrl());
  try {
    const alerts = await store.listAlerts({ status: [...status], limit });
    return NextResponse.json({ count: alerts.length, alerts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await store.close();
  }
}
