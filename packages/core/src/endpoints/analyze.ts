/**
 * One-shot analysis of many paths against a base URL (Kibana Uptime / Heartbeat vibe).
 */
import { BUHO_CONSOLE_PATHS, DEFAULT_ANALYZE_STATUSES, joinBaseUrl } from './catalog';
import { probeHttp } from './probe';

export type AnalyzePathResult = {
  path: string;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  dnsMs: number | null;
  ttfbMs: number | null;
  error?: string;
};

export type AnalyzeBaseUrlResult = {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  paths: AnalyzePathResult[];
  summary: {
    total: number;
    ok: number;
    down: number;
    slow: number;
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
  };
};

export type AnalyzeBaseUrlOptions = {
  baseUrl: string;
  /** Defaults to BUHO_CONSOLE_PATHS when catalog = 'buho'. */
  paths?: string[];
  catalog?: 'buho' | 'custom';
  expectStatus?: number[];
  timeoutMs?: number;
  concurrency?: number;
  /** Paths slower than this count as "slow" in the summary. */
  warnMs?: number;
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function analyzeBaseUrl(
  opts: AnalyzeBaseUrlOptions,
): Promise<AnalyzeBaseUrlResult> {
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('baseUrl must start with http:// or https://');
  }

  const paths =
    opts.paths && opts.paths.length > 0
      ? opts.paths.map((p) => (p.startsWith('/') ? p : `/${p}`))
      : opts.catalog === 'custom'
        ? ['/']
        : [...BUHO_CONSOLE_PATHS];

  const expectStatus = opts.expectStatus ?? DEFAULT_ANALYZE_STATUSES;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const concurrency = opts.concurrency ?? 6;
  const warnMs = opts.warnMs ?? 1_500;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  const results = await mapPool(paths, concurrency, async (path) => {
    const url = joinBaseUrl(baseUrl, path);
    const http = await probeHttp(url, { expectStatus, timeoutMs, method: 'GET' });
    return {
      path,
      url,
      ok: http.ok,
      status: http.status,
      ms: http.ms,
      dnsMs: http.dnsMs ?? null,
      ttfbMs: http.ttfbMs ?? null,
      error: http.error,
    } satisfies AnalyzePathResult;
  });

  const finished = Date.now();
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const ok = results.filter((r) => r.ok).length;
  const slow = results.filter((r) => r.ok && r.ms >= warnMs).length;

  return {
    baseUrl,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    totalMs: finished - started,
    paths: results,
    summary: {
      total: results.length,
      ok,
      down: results.length - ok,
      slow,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      avgMs:
        latencies.length === 0
          ? null
          : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    },
  };
}
