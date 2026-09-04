import { NextResponse } from 'next/server';
import { listInstances } from '@/lib/queries';
import { requireAdmin } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  }

  const instances = await listInstances();
  return NextResponse.json({
    instances: instances.map((i) => ({
      instanceId: i.instanceId,
      alias: i.alias,
      score: i.score,
      critical: i.critical,
      warning: i.warning,
    })),
  });
}
