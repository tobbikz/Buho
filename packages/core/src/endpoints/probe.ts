/**
 * Synthetic endpoint probes — app-layer monitoring for Búho (not SNMP).
 * Returns numeric Samples that land in metric_samples like any DB engine.
 */
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { Sample } from "../types.js";

export type EndpointProbeConfig = {
  /** Full URL for HTTP(S). If omitted, built from host/port + path. */
  url?: string;
  /** Base URL when probing many paths (overrides host/port URL build for HTTP). */
  baseUrl?: string;
  path?: string;
  /** Probe each path (relative) against baseUrl/url — labeled samples per path. */
  paths?: string[];
  method?: string;
  expectStatus?: number[];
  expectBodyIncludes?: string;
  expectBodyRegex?: string;
  timeoutMs?: number;
  /** Also probe bare TCP connect to host:port. Default true. */
  tcp?: boolean;
  /** Also check TLS certificate expiry when scheme is https. Default true. */
  tlsCert?: boolean;
  warnMs?: number;
  warnDays?: number;
  critDays?: number;
  /** Link to a monitored DB instance alias (correlation). */
  dependsOnAlias?: string;
};

export type EndpointProbeResult = {
  samples: Sample[];
  ok: boolean;
  error?: string;
  detail: Record<string, string | number | boolean | null>;
};

function nowSamples(
  entries: Array<{ metric: string; value: number; labels?: Record<string, string> }>,
): Sample[] {
  return entries.map((e) => ({
    metric: e.metric,
    value: e.value,
    labels: e.labels,
  }));
}

export async function probeTcp(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, error: "tcp timeout" });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      socket.end();
      resolve({ ok: true, ms });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, ms: Date.now() - started, error: err.message });
    });
  });
}

export async function probeTlsCert(
  host: string,
  port: number,
  servername?: string,
  timeoutMs = 8000,
): Promise<{
  ok: boolean;
  daysLeft: number | null;
  ms: number;
  error?: string;
  subject?: string | null;
}> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: servername ?? host,
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert?.valid_to) {
          resolve({
            ok: false,
            daysLeft: null,
            ms: Date.now() - started,
            error: "no peer certificate",
          });
          return;
        }
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.floor(
          (validTo.getTime() - Date.now()) / (24 * 3600 * 1000),
        );
        const cn = cert.subject?.CN;
        resolve({
          ok: daysLeft >= 0,
          daysLeft,
          ms: Date.now() - started,
          subject: Array.isArray(cn) ? cn[0] : cn ?? null,
        });
      },
    );
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      socket.destroy();
      resolve({
        ok: false,
        daysLeft: null,
        ms: Date.now() - started,
        error: "tls timeout",
      });
    });
    socket.once("error", (err) => {
      resolve({
        ok: false,
        daysLeft: null,
        ms: Date.now() - started,
        error: err.message,
      });
    });
  });
}

export async function probeHttp(
  url: string,
  opts: {
    method?: string;
    expectStatus?: number[];
    expectBodyIncludes?: string;
    expectBodyRegex?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  ok: boolean;
  status: number | null;
  ms: number;
  dnsMs: number | null;
  connectMs: number | null;
  ttfbMs: number | null;
  error?: string;
  bodySnippet?: string;
}> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const method = (opts.method ?? "GET").toUpperCase();
  const expectStatus = opts.expectStatus ?? [200];
  const started = Date.now();
  let dnsMs: number | null = null;
  let connectMs: number | null = null;
  let ttfbMs: number | null = null;

  try {
    const parsed = new URL(url);
    const dnsStart = Date.now();
    try {
      await dns.lookup(parsed.hostname);
      dnsMs = Date.now() - dnsStart;
    } catch {
      dnsMs = Date.now() - dnsStart;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const connectStart = Date.now();
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: "follow",
    });
    connectMs = Date.now() - connectStart;
    ttfbMs = connectMs;
    clearTimeout(timer);

    const body = await res.text();
    const ms = Date.now() - started;
    const statusOk = expectStatus.includes(res.status);
    let bodyOk = true;
    if (opts.expectBodyIncludes && !body.includes(opts.expectBodyIncludes)) {
      bodyOk = false;
    }
    if (opts.expectBodyRegex) {
      try {
        if (!new RegExp(opts.expectBodyRegex).test(body)) bodyOk = false;
      } catch {
        bodyOk = false;
      }
    }
    const ok = statusOk && bodyOk;
    return {
      ok,
      status: res.status,
      ms,
      dnsMs,
      connectMs,
      ttfbMs,
      error: ok
        ? undefined
        : !statusOk
          ? `unexpected status ${res.status}`
          : "body assertion failed",
      bodySnippet: body.slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      dnsMs,
      connectMs,
      ttfbMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Full endpoint probe for one monitored target.
 */
export async function probeEndpoint(opts: {
  host: string;
  port: number;
  ssl?: boolean;
  probe: EndpointProbeConfig;
}): Promise<EndpointProbeResult> {
  const timeoutMs = opts.probe.timeoutMs ?? 10_000;
  const samples: Sample[] = [];
  const detail: Record<string, string | number | boolean | null> = {};
  let ok = true;
  let error: string | undefined;

  const doTcp = opts.probe.tcp !== false;
  if (doTcp) {
    const tcp = await probeTcp(opts.host, opts.port, Math.min(timeoutMs, 5000));
    samples.push(
      ...nowSamples([
        { metric: "endpoint_tcp_ok", value: tcp.ok ? 1 : 0 },
        { metric: "endpoint_tcp_ms", value: tcp.ms },
      ]),
    );
    detail.tcpOk = tcp.ok;
    detail.tcpMs = tcp.ms;
    if (!tcp.ok) {
      ok = false;
      error = tcp.error ?? "tcp failed";
    }
  }

  const baseFromParts = `${opts.ssl || opts.port === 443 ? "https" : "http"}://${opts.host}${
    opts.port === 443 || opts.port === 80 ? "" : `:${opts.port}`
  }`;
  const baseUrl = (opts.probe.baseUrl ?? opts.probe.url ?? baseFromParts).replace(
    /\/+$/,
    "",
  );
  const pathList =
    opts.probe.paths && opts.probe.paths.length > 0
      ? opts.probe.paths
      : [opts.probe.path ?? "/"];

  const concurrency = Math.min(8, Math.max(1, pathList.length));
  const pathResults: Array<{
    path: string;
    url: string;
    http: Awaited<ReturnType<typeof probeHttp>>;
  }> = new Array(pathList.length);
  let cursor = 0;
  async function pathWorker() {
    while (true) {
      const i = cursor++;
      if (i >= pathList.length) return;
      const raw = pathList[i]!;
      const p = raw.startsWith("/") ? raw : `/${raw}`;
      const url =
        opts.probe.url && !opts.probe.paths && !opts.probe.baseUrl && pathList.length === 1
          ? opts.probe.url
          : `${baseUrl}${p}`;
      const http = await probeHttp(url, {
        method: opts.probe.method,
        expectStatus: opts.probe.expectStatus,
        expectBodyIncludes: opts.probe.expectBodyIncludes,
        expectBodyRegex: opts.probe.expectBodyRegex,
        timeoutMs,
      });
      pathResults[i] = { path: p, url, http };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => pathWorker()));

  let anyHttpOk = false;
  let allHttpOk = true;
  let maxMs = 0;
  let primaryStatus: number | null = null;

  for (const row of pathResults) {
    const { path: p, url, http } = row!;
    const labels = pathList.length > 1 ? { path: p } : undefined;
    samples.push(
      ...nowSamples([
        { metric: "endpoint_http_ok", value: http.ok ? 1 : 0, labels },
        { metric: "endpoint_http_ms", value: http.ms, labels },
        { metric: "endpoint_http_status", value: http.status ?? 0, labels },
        ...(http.dnsMs != null
          ? [{ metric: "endpoint_dns_ms", value: http.dnsMs, labels }]
          : []),
        ...(http.ttfbMs != null
          ? [{ metric: "endpoint_ttfb_ms", value: http.ttfbMs, labels }]
          : []),
      ]),
    );
    if (pathList.length === 1) {
      detail.url = url;
      detail.httpOk = http.ok;
      detail.httpMs = http.ms;
      detail.httpStatus = http.status;
    }
    if (http.ok) anyHttpOk = true;
    else {
      allHttpOk = false;
      error = http.error ?? error ?? `${p} failed`;
    }
    if (http.ms > maxMs) maxMs = http.ms;
    if (primaryStatus == null) primaryStatus = http.status;
  }

  detail.paths = pathList.length;
  detail.httpOk = allHttpOk;
  detail.httpMs = maxMs;
  detail.httpStatus = primaryStatus;
  if (!allHttpOk) {
    ok = false;
  }

  // Fleet cards / overview read unlabeled metrics — always emit aggregates.
  if (pathList.length > 1) {
    samples.push(
      ...nowSamples([
        { metric: "endpoint_http_ok", value: allHttpOk ? 1 : 0 },
        { metric: "endpoint_http_ms", value: maxMs },
        { metric: "endpoint_http_status", value: primaryStatus ?? 0 },
      ]),
    );
  }

  const isHttps = baseUrl.startsWith("https:") || Boolean(opts.ssl);
  if (isHttps && opts.probe.tlsCert !== false) {
    const tlsResult = await probeTlsCert(
      opts.host,
      opts.port || 443,
      undefined,
      timeoutMs,
    );
    samples.push(
      ...nowSamples([
        { metric: "endpoint_tls_ok", value: tlsResult.ok ? 1 : 0 },
        ...(tlsResult.daysLeft != null
          ? [{ metric: "endpoint_tls_days_left", value: tlsResult.daysLeft }]
          : []),
      ]),
    );
    detail.tlsOk = tlsResult.ok;
    detail.tlsDaysLeft = tlsResult.daysLeft;
    const warnDays = opts.probe.warnDays ?? 30;
    const critDays = opts.probe.critDays ?? 7;
    if (tlsResult.daysLeft != null && tlsResult.daysLeft < critDays) {
      ok = false;
      error = `certificate expires in ${tlsResult.daysLeft}d`;
    } else if (tlsResult.daysLeft != null && tlsResult.daysLeft < warnDays) {
      // keep ok=true but surface via checks
    }
  }

  const warnMs = opts.probe.warnMs ?? 2000;
  if (anyHttpOk && maxMs >= warnMs) {
    samples.push(...nowSamples([{ metric: "endpoint_slow", value: 1 }]));
  }

  samples.push(
    ...nowSamples([{ metric: "endpoint_up", value: ok ? 1 : 0 }]),
  );
  detail.ok = ok;
  if (error) detail.error = error;

  return { samples, ok, error, detail };
}
