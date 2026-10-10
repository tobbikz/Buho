/**
 * Minimal OTLP/HTTP JSON parser → flat log rows for Búho store.
 * Accepts ExportLogsServiceRequest JSON (protobuf not required).
 */

export type ParsedLogRecord = {
  timeUnixNano: string;
  observedTs: Date;
  severityText: string;
  severityNumber: number;
  body: string;
  serviceName: string;
  traceId: string | null;
  spanId: string | null;
  attributes: Record<string, string | number | boolean>;
};

export type ParsedLogBatch = {
  records: ParsedLogRecord[];
  resourceServices: string[];
};

function attrsToMap(
  list: Array<{ key?: string; value?: Record<string, unknown> }> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const key = item.key;
    if (!key || !item.value) continue;
    const v = item.value;
    if (typeof v.stringValue === 'string') out[key] = v.stringValue;
    else if (typeof v.intValue === 'string' || typeof v.intValue === 'number')
      out[key] = Number(v.intValue);
    else if (typeof v.doubleValue === 'number') out[key] = v.doubleValue;
    else if (typeof v.boolValue === 'boolean') out[key] = v.boolValue;
  }
  return out;
}

function hexId(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const s = value.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length > 0) return buf.toString('hex');
  } catch {
    /* ignore */
  }
  return s.toLowerCase();
}

function bodyText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.stringValue === 'string') return o.stringValue;
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body);
}

function nanoToDate(nano: unknown): Date {
  const n = BigInt(String(nano ?? '0'));
  if (n <= 0n) return new Date();
  return new Date(Number(n / 1_000_000n));
}

/** Parse OTLP ExportLogsServiceRequest JSON. */
export function parseOtlpLogsJson(body: unknown): ParsedLogBatch {
  const records: ParsedLogRecord[] = [];
  const services = new Set<string>();
  const root = body as {
    resourceLogs?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: Record<string, unknown> }> };
      scopeLogs?: Array<{
        logRecords?: Array<Record<string, unknown>>;
      }>;
    }>;
  };

  for (const rl of root.resourceLogs ?? []) {
    const resourceAttrs = attrsToMap(rl.resource?.attributes);
    const serviceName =
      (typeof resourceAttrs['service.name'] === 'string'
        ? resourceAttrs['service.name']
        : null) ?? 'unknown';
    services.add(serviceName);

    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const attributes = {
          ...resourceAttrs,
          ...attrsToMap(
            lr.attributes as
              | Array<{ key?: string; value?: Record<string, unknown> }>
              | undefined,
          ),
        };
        const timeUnixNano = String(lr.timeUnixNano ?? lr.observedTimeUnixNano ?? '0');
        records.push({
          timeUnixNano,
          observedTs: nanoToDate(lr.observedTimeUnixNano ?? lr.timeUnixNano),
          severityText: String(lr.severityText ?? attributes['severity'] ?? ''),
          severityNumber: Number(lr.severityNumber ?? 0) || 0,
          body: bodyText(lr.body),
          serviceName,
          traceId: hexId(lr.traceId),
          spanId: hexId(lr.spanId),
          attributes,
        });
      }
    }
  }

  return { records, resourceServices: [...services] };
}
