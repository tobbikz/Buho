import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { ensureUptimeForService } from '@/lib/obs-ensure';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Optional uptime probe for a service that already has real OTLP.
 * APM traces are never invented — apps / otel-collector must emit them.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  let body: { service?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const service = body.service?.trim();
  const action = body.action?.trim();
  if (!service || !/^[a-zA-Z0-9._-]+$/.test(service)) {
    return NextResponse.json({ error: 'valid service name required' }, { status: 400 });
  }
  if (action !== 'uptime') {
    return NextResponse.json(
      {
        error:
          'action must be uptime. APM bootstrap was removed — emit real OTLP via otel-collector or http/json to /api/otlp/v1/traces.',
      },
      { status: 400 },
    );
  }

  const result = await ensureUptimeForService(service);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
