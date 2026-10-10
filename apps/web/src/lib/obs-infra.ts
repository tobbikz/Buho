import { listApmEbpfBindings } from './apm-bindings';
import { query } from './db';
import { listEndpointMonitors } from './endpoints';
import { servicePath } from './obs-service';
import { listObsServiceTagsByEntity } from './obs-tags';
import { listApmServices, otlpRealTracePredicate } from './traces';

/** Observation mix for a unified service row. */
export type InventorySource = 'apm' | 'synthetics' | 'both';

/** Inventory row: one service; capabilities say uptime / traces. */
export type InventoryEntity = {
  id: string;
  source: InventorySource;
  name: string;
  subtitle: string;
  score: number | null;
  href: string;
  /** APM identity — any historical OTLP and/or eBPF binding (Traces tab/chip inventory). */
  hasTraces: boolean;
  /** Had OTLP in the last 1h (KPI “With traces · last 1h”). */
  tracesRecent1h: boolean;
  hasUptime: boolean;
  monitorInstanceId: number | null;
  /** Availability 0–1 (APM = 1 - error rate; Synthetics = up fraction). */
  availability: number | null;
  errorRate: number | null;
  /** Requests / traces (or probe samples) in the window. */
  throughput: number;
  /** Typical latency (p50). */
  p50Ms: number | null;
  /** Kept for status heuristics. */
  p95Ms: number | null;
  /** Worst latency (p99). */
  p99Ms: number | null;
  /** Best / fastest sample in the window (min ms). */
  bestMs: number | null;
  /** Latency trend (oldest → newest), usually avg ms per 5m bucket. */
  latencySpark: number[];
  /** Synthetics: current up; APM-only: null. */
  up: boolean | null;
  /** Freeform console tags (env:prod, team:…, etc.). */
  tags: string[];
};

export type MetricExplorerPoint = {
  instanceId: number;
  alias: string;
  engine: string;
  host: string;
  value: number | null;
  ts: Date | null;
  spark: number[];
};

export type TlsCertRow = {
  instanceId: number;
  alias: string;
  host: string;
  port: number;
  tlsDays: number | null;
  status: 'ok' | 'warn' | 'critical' | 'unknown';
  lastSeenAt: Date | null;
};

/** Observability Metrics Explorer — Synthetics/endpoint only (no host infra; DBs in Databases). */
export const METRICS_EXPLORER_OPTIONS = [
  { id: 'endpoint_http_ms', label: 'Probe HTTP ms' },
  { id: 'endpoint_up', label: 'Probe up' },
  { id: 'endpoint_tls_days_left', label: 'TLS days left' },
  { id: 'endpoint_http_status', label: 'Probe HTTP status' },
  { id: 'endpoint_ttfb_ms', label: 'Probe TTFB ms' },
] as const;

/** Live KPI / latency window (fleet sparks, “With traces · last 1h”). */
const WINDOW_HOURS = 1;

type ApmSreRow = {
  service_name: string;
  throughput: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  best: number | null;
  error_rate: number;
};

type SynthSreRow = {
  instance_id: number;
  throughput: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  best: number | null;
  availability: number | null;
};

async function listApmSreStats(): Promise<{
  stats: Map<string, ApmSreRow>;
  sparks: Map<string, number[]>;
}> {
  const real = otlpRealTracePredicate('t');
  const [rows, sparkRows] = await Promise.all([
    query<Record<string, unknown>>(
      `select coalesce(nullif(t.root_service, ''), '(unknown)') as service_name,
              count(*)::int as throughput,
              percentile_cont(0.50) within group (order by t.duration_ms) as p50,
              percentile_cont(0.95) within group (order by t.duration_ms) as p95,
              percentile_cont(0.99) within group (order by t.duration_ms) as p99,
              min(t.duration_ms) as best,
              (count(*) filter (where t.error_count > 0))::float8
                / nullif(count(*), 0) as error_rate
         from buho.otlp_traces t
        where t.start_ts > now() - make_interval(hours => $1::int)
          and ${real}
        group by 1`,
      [WINDOW_HOURS],
    ),
    query<{ service_name: string; bucket: Date; value: number }>(
      `select coalesce(nullif(t.root_service, ''), '(unknown)') as service_name,
              date_bin(interval '5 minutes', t.start_ts, timestamptz 'epoch') as bucket,
              avg(t.duration_ms)::float8 as value
         from buho.otlp_traces t
        where t.start_ts > now() - make_interval(hours => $1::int)
          and ${real}
        group by 1, 2
        order by 1, 2`,
      [WINDOW_HOURS],
    ),
  ]);

  const stats = new Map<string, ApmSreRow>();
  for (const row of rows) {
    const name = String(row['service_name']);
    stats.set(name, {
      service_name: name,
      throughput: Number(row['throughput'] ?? 0),
      p50: row['p50'] == null ? null : Number(row['p50']),
      p95: row['p95'] == null ? null : Number(row['p95']),
      p99: row['p99'] == null ? null : Number(row['p99']),
      best: row['best'] == null ? null : Number(row['best']),
      error_rate: Number(row['error_rate'] ?? 0),
    });
  }

  const sparks = new Map<string, number[]>();
  for (const r of sparkRows) {
    const arr = sparks.get(r.service_name) ?? [];
    arr.push(Number(r.value));
    sparks.set(r.service_name, arr);
  }
  return { stats, sparks };
}

async function listSyntheticsSreStats(): Promise<{
  stats: Map<number, SynthSreRow>;
  sparks: Map<number, number[]>;
}> {
  const [rows, sparkRows] = await Promise.all([
    query<Record<string, unknown>>(
      `select s.instance_id,
              count(*) filter (where s.metric = 'endpoint_http_ms')::int as throughput,
              percentile_cont(0.50) within group (order by s.value)
                filter (where s.metric = 'endpoint_http_ms') as p50,
              percentile_cont(0.95) within group (order by s.value)
                filter (where s.metric = 'endpoint_http_ms') as p95,
              percentile_cont(0.99) within group (order by s.value)
                filter (where s.metric = 'endpoint_http_ms') as p99,
              min(s.value) filter (where s.metric = 'endpoint_http_ms') as best,
              avg(s.value) filter (where s.metric = 'endpoint_up') as availability
         from buho.metric_samples s
         join buho.instances i on i.instance_id = s.instance_id
        where i.engine = 'endpoint'
          and s.metric in ('endpoint_http_ms', 'endpoint_up')
          and s.ts > now() - make_interval(hours => $1::int)
        group by 1`,
      [WINDOW_HOURS],
    ),
    query<{ instance_id: number; bucket: Date; value: number }>(
      `select s.instance_id,
              date_bin(interval '5 minutes', s.ts, timestamptz 'epoch') as bucket,
              avg(s.value)::float8 as value
         from buho.metric_samples s
         join buho.instances i on i.instance_id = s.instance_id
        where i.engine = 'endpoint'
          and s.metric = 'endpoint_http_ms'
          and s.ts > now() - make_interval(hours => $1::int)
        group by 1, 2
        order by 1, 2`,
      [WINDOW_HOURS],
    ),
  ]);

  const stats = new Map<number, SynthSreRow>();
  for (const row of rows) {
    const id = Number(row['instance_id']);
    stats.set(id, {
      instance_id: id,
      throughput: Number(row['throughput'] ?? 0),
      p50: row['p50'] == null ? null : Number(row['p50']),
      p95: row['p95'] == null ? null : Number(row['p95']),
      p99: row['p99'] == null ? null : Number(row['p99']),
      best: row['best'] == null ? null : Number(row['best']),
      availability: row['availability'] == null ? null : Number(row['availability']),
    });
  }

  const sparks = new Map<number, number[]>();
  for (const r of sparkRows) {
    const arr = sparks.get(Number(r.instance_id)) ?? [];
    arr.push(Number(r.value));
    sparks.set(Number(r.instance_id), arr);
  }
  return { stats, sparks };
}

function mergeTags(...lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) for (const t of list) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function pickMs(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) {
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Fleet of services — APM ∪ Synthetics merged by name/alias. */
export async function listInventoryEntities(): Promise<InventoryEntity[]> {
  const [services1h, servicesIdentity, monitors, apmSre, synthSre, tagMap, bindings] =
    await Promise.all([
      listApmServices(WINDOW_HOURS * 60),
      // All-time OTLP: APM inventory is historical — once seen, stays listed.
      listApmServices(null),
      listEndpointMonitors(),
      listApmSreStats(),
      listSyntheticsSreStats(),
      listObsServiceTagsByEntity(),
      listApmEbpfBindings().catch(() => []),
    ]);

  const recent1h = new Set(services1h.map((s) => s.serviceName));
  const byName = new Map<string, InventoryEntity>();

  for (const s of servicesIdentity) {
    const st = apmSre.stats.get(s.serviceName);
    const in1h = recent1h.has(s.serviceName);
    const errorRate = st?.error_rate ?? s.errorRate;
    const availability = 1 - errorRate;
    const throughput = in1h ? (st?.throughput ?? s.traceCount) : s.traceCount;
    byName.set(s.serviceName, {
      id: s.serviceName,
      source: 'apm',
      name: s.serviceName,
      subtitle: in1h
        ? `${throughput} traces · last ${WINDOW_HOURS}h`
        : `${s.traceCount} traces · all time`,
      score: s.errorRate >= 0.05 ? 40 : s.errorRate >= 0.01 ? 70 : 95,
      href: servicePath(s.serviceName),
      hasTraces: true,
      tracesRecent1h: in1h,
      hasUptime: false,
      monitorInstanceId: null,
      availability,
      errorRate,
      throughput,
      p50Ms: st?.p50 ?? s.p50DurationMs,
      p95Ms: st?.p95 ?? s.p95DurationMs,
      p99Ms: st?.p99 ?? s.p99DurationMs,
      bestMs: st?.best ?? s.bestDurationMs,
      latencySpark: apmSre.sparks.get(s.serviceName) ?? [],
      up: null,
      tags: tagMap.get(`apm:${s.serviceName}`) ?? [],
    });
  }

  // Zero-code bindings keep APM identity even if OTLP is quiet right now.
  for (const b of bindings) {
    const name = b.service.trim();
    if (!name) continue;
    const existing = byName.get(name);
    if (existing) {
      byName.set(name, { ...existing, hasTraces: true });
      continue;
    }
    byName.set(name, {
      id: name,
      source: 'apm',
      name,
      subtitle: `APM on · ${b.host}:${b.port}`,
      score: 95,
      href: servicePath(name),
      hasTraces: true,
      tracesRecent1h: false,
      hasUptime: false,
      monitorInstanceId: null,
      availability: null,
      errorRate: null,
      throughput: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      bestMs: null,
      latencySpark: [],
      up: null,
      tags: tagMap.get(`apm:${name}`) ?? [],
    });
  }

  for (const m of monitors) {
    const st = synthSre.stats.get(m.instanceId);
    const availability =
      st?.availability ?? (m.up == null ? null : m.up >= 1 ? 1 : 0);
    const errorRate =
      availability == null ? null : Math.max(0, Math.min(1, 1 - availability));
    const synthTags = tagMap.get(`synthetics:${m.instanceId}`) ?? [];
    const existing = byName.get(m.alias);

    if (existing) {
      const mergedSpark =
        existing.latencySpark.length >= (synthSre.sparks.get(m.instanceId)?.length ?? 0)
          ? existing.latencySpark
          : (synthSre.sparks.get(m.instanceId) ?? existing.latencySpark);
      byName.set(m.alias, {
        ...existing,
        source: 'both',
        hasUptime: true,
        monitorInstanceId: m.instanceId,
        subtitle: `${existing.subtitle} · ${m.host}:${m.port}`,
        score:
          existing.score != null && m.score != null
            ? Math.min(existing.score, m.score)
            : (existing.score ?? m.score),
        availability:
          existing.availability != null && availability != null
            ? Math.min(existing.availability, availability)
            : (existing.availability ?? availability),
        errorRate:
          existing.errorRate != null && errorRate != null
            ? Math.max(existing.errorRate, errorRate)
            : (existing.errorRate ?? errorRate),
        p50Ms: pickMs(existing.p50Ms, st?.p50),
        p95Ms: pickMs(existing.p95Ms, st?.p95, m.httpMs),
        p99Ms: pickMs(existing.p99Ms, st?.p99),
        bestMs: pickMs(existing.bestMs, st?.best),
        latencySpark: mergedSpark,
        up: m.up == null ? existing.up : m.up >= 1,
        tags: mergeTags(existing.tags, synthTags),
      });
    } else {
      byName.set(m.alias, {
        id: m.alias,
        source: 'synthetics',
        name: m.alias,
        subtitle: `${m.host}:${m.port}`,
        score: m.score,
        href: servicePath(m.alias),
        hasTraces: false,
        tracesRecent1h: false,
        hasUptime: true,
        monitorInstanceId: m.instanceId,
        availability,
        errorRate,
        throughput: st?.throughput ?? 0,
        p50Ms: st?.p50 ?? null,
        p95Ms: st?.p95 ?? m.httpMs,
        p99Ms: st?.p99 ?? null,
        bestMs: st?.best ?? null,
        latencySpark: synthSre.sparks.get(m.instanceId) ?? [],
        up: m.up == null ? null : m.up >= 1,
        tags: synthTags,
      });
    }
  }

  return [...byName.values()].sort((a, b) => {
    const aAvail = a.availability ?? 1;
    const bAvail = b.availability ?? 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    const aErr = a.errorRate ?? 0;
    const bErr = b.errorRate ?? 0;
    if (aErr !== bErr) return bErr - aErr;
    return a.name.localeCompare(b.name);
  });
}

/** Resolve one service by name (APM service name and/or Synthetics alias). */
export async function getObsService(name: string): Promise<InventoryEntity | null> {
  const all = await listInventoryEntities();
  return all.find((e) => e.name === name) ?? null;
}

export async function listMetricExplorer(
  metric: string,
  minutes = 60,
): Promise<MetricExplorerPoint[]> {
  const [latest, buckets] = await Promise.all([
    query<Record<string, unknown>>(
      `select distinct on (s.instance_id)
              s.instance_id, i.alias, i.engine, i.host, s.value, s.ts
         from buho.metric_samples s
         join buho.instances i on i.instance_id = s.instance_id
        where s.metric = $1
          and s.ts > now() - make_interval(mins => $2::int)
          and i.engine = 'endpoint'
        order by s.instance_id, s.ts desc`,
      [metric, minutes],
    ),
    query<{ instance_id: number; bucket: Date; value: number }>(
      `select s.instance_id,
              date_bin(interval '5 minutes', s.ts, timestamptz 'epoch') as bucket,
              avg(s.value)::float8 as value
         from buho.metric_samples s
         join buho.instances i on i.instance_id = s.instance_id
        where s.metric = $1
          and s.ts > now() - make_interval(mins => $2::int)
          and i.engine = 'endpoint'
        group by 1, 2
        order by 1, 2`,
      [metric, minutes],
    ),
  ]);

  const sparkById = new Map<number, number[]>();
  for (const b of buckets) {
    const id = Number(b.instance_id);
    const arr = sparkById.get(id) ?? [];
    arr.push(Number(b.value));
    sparkById.set(id, arr);
  }

  return latest.map((row) => {
    const id = Number(row['instance_id']);
    return {
      instanceId: id,
      alias: String(row['alias']),
      engine: String(row['engine']),
      host: String(row['host'] ?? ''),
      value: row['value'] == null ? null : Number(row['value']),
      ts: (row['ts'] as Date | null) ?? null,
      spark: sparkById.get(id) ?? [],
    };
  });
}

export async function listTlsCertificates(): Promise<TlsCertRow[]> {
  const monitors = await listEndpointMonitors();
  return monitors
    .map((m) => {
      let status: TlsCertRow['status'] = 'unknown';
      if (m.tlsDays != null) {
        if (m.tlsDays < 7) status = 'critical';
        else if (m.tlsDays < 30) status = 'warn';
        else status = 'ok';
      }
      return {
        instanceId: m.instanceId,
        alias: m.alias,
        host: m.host,
        port: m.port,
        tlsDays: m.tlsDays,
        status,
        lastSeenAt: m.lastSeenAt,
      };
    })
    .sort((a, b) => {
      const rank = (s: TlsCertRow['status']) =>
        s === 'critical' ? 0 : s === 'warn' ? 1 : s === 'ok' ? 2 : 3;
      const rd = rank(a.status) - rank(b.status);
      if (rd !== 0) return rd;
      const av = a.tlsDays ?? 9999;
      const bv = b.tlsDays ?? 9999;
      return av - bv;
    });
}
