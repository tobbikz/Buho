import { NextResponse } from 'next/server';
import { parseOtlpTracesJson, spanDurationMs } from '@buho/core';
import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * OTLP/HTTP JSON ingest (OpenTelemetry ExportTraceServiceRequest).
 *
 * Wire apps / OTel Collector with:
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host:3100/api/otlp/v1/traces
 *
 * Protobuf binary is not accepted here — put an OTel Collector in front
 * (receive OTLP, export otlphttp/json → Buho). See deploy/otel-collector/.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Liveness for collectors / smoke tests. */
export async function GET() {
  return json({
    ok: true,
    protocol: 'otlp/http+json',
    path: '/api/otlp/v1/traces',
    hint: 'POST ExportTraceServiceRequest JSON · use OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
  });
}

export async function POST(request: Request) {
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
          'OTLP protobuf/gRPC not supported on this endpoint. Use http/json, or front Buho with OTel Collector (deploy/otel-collector).',
        accepted: 'application/json',
      },
      415,
    );
  }

  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length === 0) {
    return json({ partialSuccess: {}, acceptedSpans: 0 });
  }
  // Reject binary protobuf even if Content-Type lied / omitted.
  if (raw[0] !== 0x7b /* { */ && raw[0] !== 0x5b /* [ */) {
    return json(
      {
        error:
          'Body is not JSON (likely OTLP protobuf). Set exporter encoding: json, or OTEL_EXPORTER_OTLP_PROTOCOL=http/json.',
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
    return json(
      {
        error: 'invalid JSON body · expected OTLP ExportTraceServiceRequest',
        contentType,
        bytes: raw.length,
      },
      400,
    );
  }

  const parsed = parseOtlpTracesJson(body);
  if (parsed.spans.length === 0) {
    return json({ partialSuccess: {}, acceptedSpans: 0 });
  }

  const store = new Store(url);
  try {
    const rows = parsed.spans
      .filter((s) => s.traceId && s.spanId)
      .map((s) => ({
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        name: s.name,
        kind: s.kind,
        serviceName: s.serviceName,
        startTs: new Date(Number(s.startUnixNano / 1_000_000n)),
        endTs: new Date(Number(s.endUnixNano / 1_000_000n)),
        durationMs: spanDurationMs(s),
        statusCode: s.statusCode,
        statusMessage: s.statusMessage,
        httpMethod: s.httpMethod,
        httpUrl: s.httpUrl,
        httpStatus: s.httpStatus,
        sqlText: s.sql,
        attributes: s.attributes,
      }));
    const n = await store.ingestOtlpSpans(rows);
    const services = [...new Set(rows.map((r) => r.serviceName))];
    return json({
      partialSuccess: {},
      acceptedSpans: n,
      services,
    });
  } catch (err) {
    console.error('[otlp]', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    await store.close().catch(() => undefined);
  }
}
