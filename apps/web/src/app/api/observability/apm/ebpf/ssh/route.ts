import { NextResponse } from 'next/server';
import { deployEbpfOverSsh, guessPublicOtlpHint } from '@/lib/apm-ebpf-ssh';
import { parseHostPort } from '@/lib/apm-ebpf';
import { requireAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

/**
 * POST — Deploy zero-code Beyla on a remote host via SSH.
 * Body: {
 *   target: "appHost:appPort",
 *   service: string,
 *   sshHost?, sshUser, sshPort?,
 *   identityFile?, password?,  // password never stored
 *   otlpEndpoint
 * }
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  let body: {
    target?: string;
    service?: string;
    sshHost?: string;
    sshUser?: string;
    sshPort?: number | string;
    identityFile?: string;
    password?: string;
    otlpEndpoint?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = parseHostPort(body.target?.trim() || '');
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const service = body.service?.trim();
  if (!service) {
    return NextResponse.json({ error: 'service name required' }, { status: 400 });
  }

  const sshUser = body.sshUser?.trim();
  if (!sshUser) {
    return NextResponse.json({ error: 'sshUser required' }, { status: 400 });
  }

  const sshHost = (body.sshHost?.trim() || parsed.host).trim();
  const otlpEndpoint = body.otlpEndpoint?.trim() || guessPublicOtlpHint();
  const sshPort = body.sshPort != null ? Number(body.sshPort) : 22;

  const result = await deployEbpfOverSsh({
    appHost: parsed.host,
    appPort: parsed.port,
    service,
    sshHost,
    sshUser,
    sshPort: Number.isFinite(sshPort) ? sshPort : 22,
    identityFile: body.identityFile?.trim(),
    password: body.password,
    otlpEndpoint,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
