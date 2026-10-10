import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';
import {
  deleteObsService,
  renameObsService,
} from '@/lib/obs-service-manage';

export const dynamic = 'force-dynamic';

/**
 * Manage a unified Observability service (probe and/or APM).
 * POST { action: 'rename'|'delete', service, newName?, scope?: 'probe'|'apm'|'all' }
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  let body: {
    action?: string;
    service?: string;
    newName?: string;
    scope?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const service = body.service?.trim() ?? '';
  const action = body.action?.trim();
  if (!service || !action) {
    return NextResponse.json({ error: 'service and action required' }, { status: 400 });
  }

  if (action === 'rename') {
    const result = await renameObsService(service, body.newName ?? '');
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    await logConsoleEvent(
      session.username,
      'obs_service.rename',
      `${service} → ${body.newName?.trim()}`,
    );
    return NextResponse.json({ ok: true, href: result.href, name: body.newName?.trim() });
  }

  if (action === 'delete') {
    const scope =
      body.scope === 'probe' || body.scope === 'apm' || body.scope === 'all'
        ? body.scope
        : 'all';
    const result = await deleteObsService(service, scope);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    await logConsoleEvent(
      session.username,
      'obs_service.delete',
      `${service} scope=${scope}`,
    );
    return NextResponse.json({ ok: true, scope });
  }

  return NextResponse.json({ error: 'action must be rename or delete' }, { status: 400 });
}
