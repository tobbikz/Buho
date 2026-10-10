import { NextResponse } from 'next/server';
import {
  listApmEbpfBindings,
  removeApmEbpfBinding,
  upsertApmEbpfBinding,
} from '@/lib/apm-bindings';
import { ebpfEnable, ebpfRemoteCommand, ebpfStatus, ebpfStop, parseHostPort } from '@/lib/apm-ebpf';
import { requireAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

async function gate() {
  try {
    await requireAdmin();
    return null;
  } catch {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }
}

/** GET — Beyla agent status + persisted APM bindings. */
export async function GET() {
  const denied = await gate();
  if (denied) return denied;
  try {
    const [status, bindings] = await Promise.all([ebpfStatus(), listApmEbpfBindings()]);
    return NextResponse.json({ ...status, bindings });
  } catch (err) {
    return NextResponse.json(
      { running: false, bindings: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST — Enable zero-code APM.
 * Body: { target: "IP:port", service?: string, otlpEndpoint?: string }
 * Persists binding when `service` is set so Need APM stays cleared after reload.
 */
export async function POST(request: Request) {
  const denied = await gate();
  if (denied) return denied;

  let body: {
    target?: string;
    host?: string;
    port?: number | string;
    service?: string;
    otlpEndpoint?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  let host: string;
  let port: number;
  if (body.target?.trim()) {
    const parsed = parseHostPort(body.target);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    host = parsed.host;
    port = parsed.port;
  } else if (body.host && body.port != null) {
    host = String(body.host).trim();
    port = Number(body.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return NextResponse.json({ error: 'valid host and port required' }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'target IP:port required' }, { status: 400 });
  }

  const service = body.service?.trim() || undefined;
  const otlpEndpoint = body.otlpEndpoint?.trim() || undefined;
  const result = await ebpfEnable(host, port, service, otlpEndpoint);

  if (result.mode === 'remote' && !result.command) {
    try {
      result.command = await ebpfRemoteCommand(host, port, service, otlpEndpoint);
    } catch {
      /* keep error from enable */
    }
  }

  let bindings = await listApmEbpfBindings();
  // Only persist when the agent actually started on this machine.
  // Remote = copy command for the other host — never mark "APM on" until then.
  if (result.ok && result.mode === 'local' && service) {
    try {
      bindings = await upsertApmEbpfBinding({ service, host, port });
    } catch (err) {
      return NextResponse.json(
        {
          ...result,
          error: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  const status = result.ok || result.mode === 'remote' ? 200 : 500;
  return NextResponse.json({ ...result, bindings, service: service ?? result.service }, { status });
}

/** DELETE — stop local Beyla agent and clear bindings for that host:port (or all if idle). */
export async function DELETE(request: Request) {
  const denied = await gate();
  if (denied) return denied;

  const before = await ebpfStatus();
  const result = await ebpfStop();

  let bindings = await listApmEbpfBindings();
  if (before.host && before.port) {
    bindings = await removeApmEbpfBinding({
      host: before.host,
      port: Number(before.port),
    });
  } else {
    // Agent already gone — clear nothing unless ?all=1
    const url = new URL(request.url);
    if (url.searchParams.get('all') === '1') {
      for (const b of bindings) {
        bindings = await removeApmEbpfBinding({ service: b.service });
      }
    }
  }

  return NextResponse.json({ ...result, bindings }, { status: result.ok ? 200 : 500 });
}
