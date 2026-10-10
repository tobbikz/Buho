import { NextResponse } from 'next/server';
import { getLatestLiveSessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

/** Fresh session snapshot for Queries → Live (max 30s old). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) {
    return NextResponse.json({ error: 'invalid instance' }, { status: 400 });
  }

  try {
    const foto = await getLatestLiveSessions(instanceId, 30);
    return NextResponse.json({
      at: foto.at ? foto.at.toISOString() : null,
      stale: foto.stale,
      sessions: foto.sessions.map((sesion) => ({
        pid: sesion.pid,
        state: sesion.state,
        waitType: sesion.waitType,
        waitEvent: sesion.waitEvent,
        application: sesion.application,
        username: sesion.username,
        database: sesion.database,
        queryMs: sesion.queryMs,
        xactMs: sesion.xactMs,
        query: sesion.query,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
