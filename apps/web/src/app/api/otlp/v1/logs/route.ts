import { NextResponse } from 'next/server';
import { parseOtlpLogsJson } from '@buho/core';
import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';
import {
  isLoopbackRequest,
  otlpAuthRequired,
  otlpRequestAuthorized,
  otlpTokenConfigured,
} from '@/lib/otlp-auth';

export const dynamic = 'force-dynamic';

/**
 * OTLP/HTTP JSON log ingest (ExportLogsServiceRequest).
 * Same auth policy as /api/otlp/v1/traces.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Buho-Otlp-Token',
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const loopback = isLoopbackRequest(request);
  const authMode = otlpAuthRequired(request) ? 'token' : 'open-loopback';
  return json({
    ok: true,
    protocol: 'otlp/http+json',
    path: '/api/otlp/v1/logs',
    auth: authMode,
    loopback,
    hint: otlpTokenConfigured()
      ? 'POST JSON with Authorization: Bearer <BUHO_OTLP_TOKEN>'
      : loopback
        ? 'Loopback open · set BUHO_OTLP_TOKEN before exposing OTLP off-loopback'
        : 'Off-loopback: set BUHO_OTLP_TOKEN',
  });
}

export async function POST(request: Request) {
  const auth = otlpRequestAuthorized(request);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  let url: string;
  try {
    url = storeUrl();
  } catch {
    return json({ error: 'BUHO_STORE_URL / DATABASE_URL not set' }, 500);
  }

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (
    contentType.includes('protobuf') ||
    contentType.includes('application/x-protobuf') ||
    contentType.includes('application/grpc')
  ) {
    return json(
      {
        error:
          'OTLP protobuf/gRPC not supported. Use http/json, or front Buho with OTel Collector.',
        accepted: 'application/json',
      },
      415,
    );
  }

  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length === 0) {
    return json({ partialSuccess: {}, acceptedLogs: 0 });
  }
  if (raw[0] !== 0x7b && raw[0] !== 0x5b) {
    return json(
      {
        error: 'Body is not JSON (likely OTLP protobuf). Use http/json encoding.',
        contentType,
        bytes: raw.length,
      },
      415,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return json({ error: 'invalid JSON · expected ExportLogsServiceRequest' }, 400);
  }

  const parsed = parseOtlpLogsJson(body);
  if (parsed.records.length === 0) {
    return json({ partialSuccess: {}, acceptedLogs: 0 });
  }

  const store = new Store(url);
  try {
    const n = await store.ingestOtlpLogs(
      parsed.records.map((r) => ({
        timeUnixNano: r.timeUnixNano,
        observedTs: r.observedTs,
        severityText: r.severityText,
        severityNumber: r.severityNumber,
        body: r.body,
        serviceName: r.serviceName,
        traceId: r.traceId,
        spanId: r.spanId,
        attributes: r.attributes,
      })),
    );
    return json({
      partialSuccess: {},
      acceptedLogs: n,
      services: parsed.resourceServices,
    });
  } catch (err) {
    console.error('[otlp/logs]', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    await store.close().catch(() => undefined);
  }
}
