import { query } from './db';
import type { FleetInstance } from './queries';
import { listInstances } from './queries';

export type EndpointMonitorRow = {
  instanceId: number;
  alias: string;
  host: string;
  port: number;
  score: number | null;
  lastSeenAt: Date | null;
  up: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  tlsDays: number | null;
  pathCount: number;
};

export type EndpointPathSample = {
  instanceId: number;
  alias: string;
  path: string;
  httpOk: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  ts: Date | null;
};

export type EndpointHistogramBucket = {
  bucket: number;
  up: number;
  down: number;
  avgMs: number | null;
};

export async function listEndpointInstances(): Promise<FleetInstance[]> {
  const all = await listInstances();
  return all.filter((i) => i.engine === 'endpoint');
}

export async function latestEndpointMetrics(instanceId: number): Promise<{
  up: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  tlsDays: number | null;
  tcpOk: number | null;
}> {
  // Prefer unlabeled fleet aggregates; fall back to any label. Window 2h so a
  // paused collector still shows last known state instead of empty cards.
  const rows = await query<{ metric: string; value: number }>(
    `select distinct on (metric) metric, value
       from buho.metric_samples
      where instance_id = $1
        and metric in (
          'endpoint_up', 'endpoint_http_ms', 'endpoint_http_status',
          'endpoint_tls_days_left', 'endpoint_tcp_ok', 'endpoint_http_ok'
        )
        and ts > now() - interval '2 hours'
      order by metric,
               case when labels = '{}'::jsonb then 0 else 1 end,
               ts desc`,
    [instanceId],
  );
  const map = new Map(rows.map((r) => [r.metric, r.value]));
  const httpOk = map.get('endpoint_http_ok');
  return {
    up: map.get('endpoint_up') ?? (httpOk == null ? null : httpOk),
    httpMs: map.get('endpoint_http_ms') ?? null,
    httpStatus: map.get('endpoint_http_status') ?? null,
    tlsDays: map.get('endpoint_tls_days_left') ?? null,
    tcpOk: map.get('endpoint_tcp_ok') ?? null,
  };
}

export async function listEndpointMonitors(): Promise<EndpointMonitorRow[]> {
  const endpoints = await listEndpointInstances();
  return Promise.all(
    endpoints.map(async (ep) => {
      const m = await latestEndpointMetrics(ep.instanceId);
      const pathRows = await query<{ n: number }>(
        `select count(distinct labels->>'path')::int as n
           from buho.metric_samples
          where instance_id = $1
            and metric = 'endpoint_http_ms'
            and labels ? 'path'
            and ts > now() - interval '15 minutes'`,
        [ep.instanceId],
      );
      return {
        instanceId: ep.instanceId,
        alias: ep.alias,
        host: ep.host,
        port: ep.port,
        score: ep.score,
        lastSeenAt: ep.lastSeenAt,
        up: m.up,
        httpMs: m.httpMs,
        httpStatus: m.httpStatus,
        tlsDays: m.tlsDays,
        pathCount: Number(pathRows[0]?.n ?? 0),
      };
    }),
  );
}

/** Latest per-path rows for multi-path monitors (Discover document list). */
export async function listEndpointPathDocuments(
  limit = 200,
  instanceId?: number,
): Promise<EndpointPathSample[]> {
  const rows = await query<Record<string, unknown>>(
    `with latest as (
       select distinct on (s.instance_id, s.labels->>'path', s.metric)
              s.instance_id, i.alias, s.labels->>'path' as path, s.metric, s.value, s.ts
         from buho.metric_samples s
         join buho.instances i on i.instance_id = s.instance_id
        where i.engine = 'endpoint'
          and ($2::bigint is null or s.instance_id = $2::bigint)
          and s.metric in ('endpoint_http_ok', 'endpoint_http_ms', 'endpoint_http_status')
          and s.labels ? 'path'
          and s.ts > now() - interval '2 hours'
        order by s.instance_id, s.labels->>'path', s.metric, s.ts desc
     )
     select instance_id, alias, path,
            max(value) filter (where metric = 'endpoint_http_ok') as http_ok,
            max(value) filter (where metric = 'endpoint_http_ms') as http_ms,
            max(value) filter (where metric = 'endpoint_http_status') as http_status,
            max(ts) as ts
       from latest
      group by instance_id, alias, path
      order by alias, path
      limit $1`,
    [limit, instanceId ?? null],
  );
  return rows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    path: String(row['path'] ?? '/'),
    httpOk: row['http_ok'] == null ? null : Number(row['http_ok']),
    httpMs: row['http_ms'] == null ? null : Number(row['http_ms']),
    httpStatus: row['http_status'] == null ? null : Number(row['http_status']),
    ts: (row['ts'] as Date | null) ?? null,
  }));
}

/** Per-path latency history (oldest → newest) for sparklines on Probed paths. */
export async function listEndpointPathLatencySparks(
  instanceId: number,
  windowMinutes = 60,
  maxPoints = 24,
): Promise<Map<string, number[]>> {
  const rows = await query<{ path: string; bucket: Date; value: number }>(
    `select labels->>'path' as path,
            date_bin(interval '2 minutes', ts, timestamptz 'epoch') as bucket,
            avg(value)::float8 as value
       from buho.metric_samples
      where instance_id = $1
        and metric = 'endpoint_http_ms'
        and labels ? 'path'
        and ts > now() - make_interval(mins => $2::int)
      group by 1, 2
      order by 1, 2`,
    [instanceId, windowMinutes],
  );
  const map = new Map<string, number[]>();
  for (const r of rows) {
    const path = r.path || '/';
    const arr = map.get(path) ?? [];
    arr.push(Number(r.value));
    map.set(path, arr);
  }
  for (const [path, arr] of map) {
    if (arr.length > maxPoints) map.set(path, arr.slice(-maxPoints));
  }
  return map;
}

/** Bulk sparks for Live probes Discover — key `${instanceId}:${path}`. */
export async function listAllEndpointPathLatencySparks(
  windowMinutes = 60,
  maxPoints = 24,
): Promise<Record<string, number[]>> {
  const rows = await query<{ instance_id: number; path: string; bucket: Date; value: number }>(
    `select s.instance_id,
            s.labels->>'path' as path,
            date_bin(interval '2 minutes', s.ts, timestamptz 'epoch') as bucket,
            avg(s.value)::float8 as value
       from buho.metric_samples s
       join buho.instances i on i.instance_id = s.instance_id
      where i.engine = 'endpoint'
        and s.metric = 'endpoint_http_ms'
        and s.labels ? 'path'
        and s.ts > now() - make_interval(mins => $1::int)
      group by 1, 2, 3
      order by 1, 2, 3`,
    [windowMinutes],
  );
  const map = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${Number(r.instance_id)}:${r.path || '/'}`;
    const arr = map.get(key) ?? [];
    arr.push(Number(r.value));
    map.set(key, arr);
  }
  const out: Record<string, number[]> = {};
  for (const [key, arr] of map) {
    out[key] = arr.length > maxPoints ? arr.slice(-maxPoints) : arr;
  }
  return out;
}

export async function endpointAvailabilityHistogram(
  minutes = 60,
  bucketSeconds = 60,
): Promise<EndpointHistogramBucket[]> {
  const rows = await query<Record<string, unknown>>(
    `with buckets as (
       select date_bin(make_interval(secs => $2::int), ts, timestamptz 'epoch') as bucket,
              metric, value
         from buho.metric_samples s
         join buho.instances i on i.instance_id = s.instance_id
        where i.engine = 'endpoint'
          and s.metric in ('endpoint_up', 'endpoint_http_ms')
          and s.labels = '{}'::jsonb
          and s.ts > now() - make_interval(mins => $1::int)
     )
     select bucket,
            count(*) filter (where metric = 'endpoint_up' and value = 1) as up,
            count(*) filter (where metric = 'endpoint_up' and value = 0) as down,
            avg(value) filter (where metric = 'endpoint_http_ms') as avg_ms
       from buckets
      group by 1
      order by 1`,
    [minutes, bucketSeconds],
  );
  return rows.map((row) => ({
    bucket: (row['bucket'] as Date).getTime(),
    up: Number(row['up'] ?? 0),
    down: Number(row['down'] ?? 0),
    avgMs: row['avg_ms'] == null ? null : Number(row['avg_ms']),
  }));
}
