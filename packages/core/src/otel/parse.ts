/**
 * Minimal OTLP/HTTP JSON parser → flat span rows for Búho store.
 * Accepts the JSON body of POST /v1/traces (protobuf not required for v1).
 */
export type ParsedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  serviceName: string;
  startUnixNano: bigint;
  endUnixNano: bigint;
  statusCode: string;
  statusMessage: string | null;
  attributes: Record<string, string | number | boolean>;
  /** db.statement / db.query.text when present */
  sql: string | null;
  httpMethod: string | null;
  httpUrl: string | null;
  httpStatus: number | null;
};

export type ParsedTraceBatch = {
  spans: ParsedSpan[];
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
    if (typeof v.stringValue === "string") out[key] = v.stringValue;
    else if (typeof v.intValue === "string" || typeof v.intValue === "number")
      out[key] = Number(v.intValue);
    else if (typeof v.doubleValue === "number") out[key] = v.doubleValue;
    else if (typeof v.boolValue === "boolean") out[key] = v.boolValue;
  }
  return out;
}

function kindName(kind: number | string | undefined): string {
  const map: Record<number, string> = {
    0: "UNSPECIFIED",
    1: "INTERNAL",
    2: "SERVER",
    3: "CLIENT",
    4: "PRODUCER",
    5: "CONSUMER",
  };
  if (typeof kind === "number") return map[kind] ?? String(kind);
  return String(kind ?? "UNSPECIFIED");
}

function statusName(code: number | string | undefined): string {
  const map: Record<number, string> = { 0: "UNSET", 1: "OK", 2: "ERROR" };
  if (typeof code === "number") return map[code] ?? String(code);
  return String(code ?? "UNSET");
}

/** OTLP JSON may send ids as hex or standard/base64 protojson bytes. */
function hexId(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const s = value.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  try {
    // protojson bytes → standard base64
    const buf = Buffer.from(s, "base64");
    if (buf.length > 0) return buf.toString("hex");
  } catch {
    /* ignore */
  }
  return s.toLowerCase();
}

/** Concrete request path (Beyla puts wildcards in span.name / http.route). */
function concreteHttpPath(
  attributes: Record<string, string | number | boolean>,
): string | null {
  for (const key of ["url.path", "http.target", "http.path"] as const) {
    const v = attributes[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const full =
    (typeof attributes["http.url"] === "string" && attributes["http.url"]) ||
    (typeof attributes["url.full"] === "string" && attributes["url.full"]) ||
    null;
  if (!full) return null;
  try {
    const u = new URL(full);
    return u.pathname || null;
  } catch {
    const m = full.match(/^https?:\/\/[^/?#]+(\/[^?#]*)/);
    return m?.[1] ?? null;
  }
}

/** Drop noisy Next.js RSC query keys; keep tab/service/w/etc. */
function cleanUrlQuery(raw: string): string {
  try {
    const params = new URLSearchParams(raw);
    for (const key of [...params.keys()]) {
      if (key === "_rsc" || key.startsWith("_next")) params.delete(key);
    }
    return params.toString();
  } catch {
    return "";
  }
}

/**
 * Prefer METHOD + real path over Beyla low-cardinality names (`GET /*`).
 * Matches Kibana APM transaction naming for Discover.
 */
function displaySpanName(
  rawName: string,
  httpMethod: string | null,
  attributes: Record<string, string | number | boolean>,
): string {
  const path = concreteHttpPath(attributes);
  if (!path || !httpMethod) return rawName;
  const qRaw =
    typeof attributes["url.query"] === "string" ? attributes["url.query"] : "";
  const q = qRaw ? cleanUrlQuery(qRaw) : "";
  return q ? `${httpMethod} ${path}?${q}` : `${httpMethod} ${path}`;
}

/**
 * Parse OTLP ExportTraceServiceRequest JSON.
 */
export function parseOtlpTracesJson(body: unknown): ParsedTraceBatch {
  const spans: ParsedSpan[] = [];
  const services = new Set<string>();
  const root = body as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: Record<string, unknown> }> };
      scopeSpans?: Array<{
        spans?: Array<Record<string, unknown>>;
      }>;
    }>;
  };

  for (const rs of root.resourceSpans ?? []) {
    const resourceAttrs = attrsToMap(rs.resource?.attributes);
    const serviceName =
      (typeof resourceAttrs["service.name"] === "string"
        ? resourceAttrs["service.name"]
        : null) ?? "unknown";
    services.add(serviceName);

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attributes = {
          ...resourceAttrs,
          ...attrsToMap(
            span.attributes as
              | Array<{ key?: string; value?: Record<string, unknown> }>
              | undefined,
          ),
        };
        const status = (span.status as { code?: number; message?: string }) ?? {};
        const rawName = String(span.name ?? "span");
        // Beyla PostgreSQL spans often set name=`SELECT …` without db.statement.
        const sqlFromAttrs =
          (typeof attributes["db.statement"] === "string"
            ? attributes["db.statement"]
            : null) ??
          (typeof attributes["db.query.text"] === "string"
            ? attributes["db.query.text"]
            : null);
        const sqlFromName = /^(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CALL|EXEC)\b/i.test(
          rawName.trim(),
        )
          ? rawName.trim()
          : null;
        const sql = sqlFromAttrs ?? sqlFromName;
        const httpMethod =
          typeof attributes["http.method"] === "string"
            ? attributes["http.method"]
            : typeof attributes["http.request.method"] === "string"
              ? attributes["http.request.method"]
              : null;
        const path = concreteHttpPath(attributes);
        const httpUrl =
          typeof attributes["http.url"] === "string"
            ? attributes["http.url"]
            : typeof attributes["url.full"] === "string"
              ? attributes["url.full"]
              : path;
        const httpStatusRaw =
          attributes["http.status_code"] ?? attributes["http.response.status_code"];
        const httpStatus =
          typeof httpStatusRaw === "number"
            ? httpStatusRaw
            : typeof httpStatusRaw === "string"
              ? Number(httpStatusRaw)
              : null;

        spans.push({
          traceId: hexId(span.traceId),
          spanId: hexId(span.spanId),
          parentSpanId: span.parentSpanId ? hexId(span.parentSpanId) : null,
          // Keep SQL names as-is; only rewrite HTTP wildcards.
          name: sql ? rawName : displaySpanName(rawName, httpMethod, attributes),
          kind: kindName(span.kind as number | string | undefined),
          serviceName,
          startUnixNano: BigInt(String(span.startTimeUnixNano ?? "0")),
          endUnixNano: BigInt(String(span.endTimeUnixNano ?? "0")),
          statusCode: statusName(status.code),
          statusMessage: status.message ?? null,
          attributes,
          sql,
          httpMethod,
          httpUrl,
          httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
        });
      }
    }
  }

  return { spans, resourceServices: [...services] };
}

export function spanDurationMs(span: ParsedSpan): number {
  if (span.endUnixNano <= span.startUnixNano) return 0;
  return Number(span.endUnixNano - span.startUnixNano) / 1e6;
}
