import { NextResponse } from 'next/server';
import { probeInputFromForm, probeTarget, type TargetProbeInput } from '@/lib/test-target';
import { requireAdmin } from '@/lib/session';

export const runtime = 'nodejs';

function inputFromJson(body: Record<string, unknown>): TargetProbeInput {
  const engine = String(body.engine ?? 'postgres');
  const portRaw = body.port;
  const port =
    typeof portRaw === 'number'
      ? portRaw
      : Number(portRaw) ||
        (engine === 'mongodb' ? 27017 : engine === 'mssql' ? 1433 : engine === 'mariadb' ? 3306 : 5432);

  return {
    engine,
    host: String(body.host ?? '').trim(),
    port,
    database: String(body.database ?? '').trim(),
    username: String(body.username ?? '').trim(),
    password: String(body.password ?? ''),
    ssl: Boolean(body.ssl),
    hostMetricsSource: (body.hostMetricsSource as TargetProbeInput['hostMetricsSource']) ?? 'none',
    sshTarget: String(body.sshTarget ?? '').trim(),
    sshIdentityFile: String(body.sshIdentityFile ?? '').trim(),
    dataDirectory: String(body.dataDirectory ?? '').trim(),
  };
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  }

  let input: TargetProbeInput;
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    input = inputFromJson(body);
  } else {
    const form = await request.formData();
    input = probeInputFromForm(form);
  }

  if (!input.host || !input.username) {
    return NextResponse.json({ error: 'Host and username are required.' }, { status: 400 });
  }

  const result = await probeTarget(input);
  const ok = result.database.ok && result.host.ok;
  return NextResponse.json({ ok, ...result });
}
