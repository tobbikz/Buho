import { query } from './db';
import { resolveSqlText } from './otlp-sql';

/** Lab coverage bootstrap (SELECT 1) — never count as real APM. */
export function otlpRealTracePredicate(alias = 't'): string {
  return `(
    coalesce(${alias}.root_name, '') not ilike '%bootstrap%'
    and not exists (
      select 1 from buho.otlp_spans s
       where s.trace_id = ${alias}.trace_id
         and coalesce(s.sql_text, '') ilike '%buho coverage bootstrap%'
    )
  )`;
}

export type ApmDbLink = {
  instanceId: number;
  alias: string;
  engine: string;
  source: 'dep' | 'span';
};

export type ApmServiceRow = {
  serviceName: string;
  traceCount: number;
  spanCount: number;
  errorTraces: number;
  errorRate: number;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
  /** Fastest sample in the window (min ms). */
  bestDurationMs: number | null;
  sqlTraces: number;
  lastSeenAt: Date | null;
  /** Avg latency per 5m bucket (oldest → newest). */
  latencySpark: number[];
  /** Declared service_deps and/or inferred from OTLP db.name attributes. */
  dependsOn: ApmDbLink[];
};

/** Resolve APM service → DB instance links (declared deps + span db.name). */
export async function listApmServiceDbLinks(
  windowMinutes: number | null = 60,
): Promise<Map<string, ApmDbLink[]>> {
  const rows = await query<Record<string, unknown>>(
    windowMinutes == null
      ? `with declared as (
           select d.from_service_name as service_name,
                  t.instance_id, t.alias, t.engine, 'dep'::text as source
             from buho.service_deps d
             join buho.instances t on t.instance_id = d.to_instance_id
            where d.from_service_name is not null
              and nullif(trim(d.from_service_name), '') is not null
         ),
         from_spans as (
           select distinct s.service_name,
                  i.instance_id, i.alias, i.engine, 'span'::text as source
             from buho.otlp_spans s
             join buho.instances i
               on i.engine <> 'endpoint'
              and (
                    lower(i.database) = lower(coalesce(s.attributes->>'db.name', s.attributes->>'db.namespace', ''))
                 or lower(i.alias) = lower(coalesce(s.attributes->>'db.name', s.attributes->>'db.namespace', ''))
              )
            where coalesce(s.attributes->>'db.name', s.attributes->>'db.namespace') is not null
         )
         select * from declared
         union
         select * from from_spans
         order by 1, 3`
      : `with declared as (
           select d.from_service_name as service_name,
                  t.instance_id, t.alias, t.engine, 'dep'::text as source
             from buho.service_deps d
             join buho.instances t on t.instance_id = d.to_instance_id
            where d.from_service_name is not null
              and nullif(trim(d.from_service_name), '') is not null
         ),
         from_spans as (
           select distinct s.service_name,
                  i.instance_id, i.alias, i.engine, 'span'::text as source
             from buho.otlp_spans s
             join buho.instances i
               on i.engine <> 'endpoint'
              and (
                    lower(i.database) = lower(coalesce(s.attributes->>'db.name', s.attributes->>'db.namespace', ''))
                 or lower(i.alias) = lower(coalesce(s.attributes->>'db.name', s.attributes->>'db.namespace', ''))
              )
            where s.start_ts > now() - make_interval(mins => $1::int)
              and coalesce(s.attributes->>'db.name', s.attributes->>'db.namespace') is not null
         )
         select * from declared
         union
         select * from from_spans
         order by 1, 3`,
    windowMinutes == null ? [] : [windowMinutes],
  );

  const map = new Map<string, ApmDbLink[]>();
  for (const row of rows) {
    const serviceName = String(row['service_name'] ?? '');
    if (!serviceName) continue;
    const link: ApmDbLink = {
      instanceId: Number(row['instance_id']),
      alias: String(row['alias']),
      engine: String(row['engine']),
      source: row['source'] === 'dep' ? 'dep' : 'span',
    };
    const cur = map.get(serviceName) ?? [];
    if (!cur.some((c) => c.instanceId === link.instanceId)) {
      // Prefer declared deps over span inference when both exist.
      if (link.source === 'dep') cur.unshift(link);
      else cur.push(link);
      map.set(serviceName, cur);
    }
  }
  return map;
}

/** Distinct OTLP root service names seen in the window (for Synthetics ↔ APM linking). */
export async function listApmServiceNames(windowMinutes: number | null = 60): Promise<Set<string>> {
  const real = otlpRealTracePredicate('t');
  const rows = await query<{ service_name: string }>(
    windowMinutes == null
      ? `select distinct coalesce(nullif(t.root_service, ''), '(unknown)') as service_name
           from buho.otlp_traces t
          where ${real}`
      : `select distinct coalesce(nullif(t.root_service, ''), '(unknown)') as service_name
           from buho.otlp_traces t
          where t.start_ts > now() - make_interval(mins => $1::int)
            and ${real}`,
    windowMinutes == null ? [] : [windowMinutes],
  );
  return new Set(rows.map((r) => r.service_name));
}

/** Kibana APM–style services rollup from ingested OTLP traces (window minutes; null = all). */
export async function listApmServices(windowMinutes: number | null = 60): Promise<ApmServiceRow[]> {
  const real = otlpRealTracePredicate('t');
  const sparkSql =
    windowMinutes == null
      ? `select coalesce(nullif(t.root_service, ''), '(unknown)') as service_name,
                date_bin(interval '5 minutes', t.start_ts, timestamptz 'epoch') as bucket,
                avg(t.duration_ms)::float8 as value
           from buho.otlp_traces t
          where ${real}
          group by 1, 2
          order by 1, 2`
      : `select coalesce(nullif(t.root_service, ''), '(unknown)') as service_name,
                date_bin(interval '5 minutes', t.start_ts, timestamptz 'epoch') as bucket,
                avg(t.duration_ms)::float8 as value
           from buho.otlp_traces t
          where t.start_ts > now() - make_interval(mins => $1::int)
            and ${real}
          group by 1, 2
          order by 1, 2`;

  const [rows, dbLinks, sparkRows] = await Promise.all([
    query<Record<string, unknown>>(
      windowMinutes == null
        ? `select coalesce(nullif(t.root_service, ''), '(unknown)') as service_name,
                  count(*)::int as trace_count,
                  coalesce(sum(t.span_count), 0)::int as span_count,
                  count(*) filter (where t.error_count > 0)::int as error_traces,
                  avg(t.duration_ms) as avg_duration_ms,
                  percentile_cont(0.50) within group (order by t.duration_ms) as p50_duration_ms,
                  percentile_cont(0.95) within group (order by t.duration_ms) as p95_duration_ms,
                  percentile_cont(0.99) within group (order by t.duration_ms) as p99_duration_ms,
                  min(t.duration_ms) as best_duration_ms,
                  count(*) filter (where t.has_sql)::int as sql_traces,
                  max(t.start_ts) as last_seen_at
             from buho.otlp_traces t
            where ${real}
            group by 1
            order by trace_count desc, service_name`
        : `with scoped as (
             select t.*
               from buho.otlp_traces t
              where t.start_ts > now() - make_interval(mins => $1::int)
                and ${real}
           )
           select coalesce(nullif(root_service, ''), '(unknown)') as service_name,
                  count(*)::int as trace_count,
                  coalesce(sum(span_count), 0)::int as span_count,
                  count(*) filter (where error_count > 0)::int as error_traces,
                  avg(duration_ms) as avg_duration_ms,
                  percentile_cont(0.50) within group (order by duration_ms) as p50_duration_ms,
                  percentile_cont(0.95) within group (order by duration_ms) as p95_duration_ms,
                  percentile_cont(0.99) within group (order by duration_ms) as p99_duration_ms,
                  min(duration_ms) as best_duration_ms,
                  count(*) filter (where has_sql)::int as sql_traces,
                  max(start_ts) as last_seen_at
             from scoped
            group by 1
            order by trace_count desc, service_name`,
      windowMinutes == null ? [] : [windowMinutes],
    ),
    listApmServiceDbLinks(windowMinutes),
    query<{ service_name: string; bucket: Date; value: number }>(
      sparkSql,
      windowMinutes == null ? [] : [windowMinutes],
    ),
  ]);

  const sparks = new Map<string, number[]>();
  for (const r of sparkRows) {
    const arr = sparks.get(r.service_name) ?? [];
    arr.push(Number(r.value));
    sparks.set(r.service_name, arr);
  }

  return rows.map((row) => {
    const traceCount = Number(row['trace_count'] ?? 0);
    const errorTraces = Number(row['error_traces'] ?? 0);
    const serviceName = String(row['service_name']);
    return {
      serviceName,
      traceCount,
      spanCount: Number(row['span_count'] ?? 0),
      errorTraces,
      errorRate: traceCount === 0 ? 0 : errorTraces / traceCount,
      avgDurationMs:
        row['avg_duration_ms'] == null ? null : Number(row['avg_duration_ms']),
      p50DurationMs:
        row['p50_duration_ms'] == null ? null : Number(row['p50_duration_ms']),
      p95DurationMs:
        row['p95_duration_ms'] == null ? null : Number(row['p95_duration_ms']),
      p99DurationMs:
        row['p99_duration_ms'] == null ? null : Number(row['p99_duration_ms']),
      bestDurationMs:
        row['best_duration_ms'] == null ? null : Number(row['best_duration_ms']),
      sqlTraces: Number(row['sql_traces'] ?? 0),
      lastSeenAt: (row['last_seen_at'] as Date | null) ?? null,
      latencySpark: sparks.get(serviceName) ?? [],
      dependsOn: dbLinks.get(serviceName) ?? [],
    };
  });
}

export type TraceSummary = {
  traceId: string;
  rootService: string | null;
  rootName: string | null;
  startTs: Date;
  endTs: Date;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  hasSql: boolean;
  httpStatus: number | null;
  httpMethod: string | null;
  /** First db.name / db.namespace seen on SQL spans. */
  dbName: string | null;
  /** Sum of SQL span durations (ms). */
  sqlMs: number | null;
};

export type TraceSpan = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  serviceName: string;
  startTs: Date;
  endTs: Date;
  durationMs: number;
  statusCode: string;
  statusMessage: string | null;
  httpMethod: string | null;
  httpUrl: string | null;
  httpStatus: number | null;
  sqlText: string | null;
};

export async function countTracesSince(windowMinutes: number | null): Promise<number> {
  if (windowMinutes == null) {
    const rows = await query<{ n: string }>(`select count(*)::int as n from buho.otlp_traces`);
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await query<{ n: string }>(
    `select count(*)::int as n from buho.otlp_traces
      where start_ts > now() - make_interval(mins => $1::int)`,
    [windowMinutes],
  );
  return Number(rows[0]?.n ?? 0);
}

export type ListTracesOpts = {
  /** Relative lookback minutes; omit / null = no relative bound (use from/to or all). */
  windowMinutes?: number | null;
  /** Absolute range start (inclusive). */
  from?: Date | null;
  /** Absolute range end (inclusive). */
  to?: Date | null;
};

/**
 * Concrete HTTP route for Discover (Beyla stores wildcards in root_name / http.route).
 * Prefer METHOD + url.path over `GET /*`. Keep tab=… query; drop noisy `_rsc`.
 */
const TRACE_DISPLAY_ROUTE_SQL = `
  coalesce(
    (
      select trim(both from concat_ws(
               ' ',
               nullif(s.http_method, ''),
               case
                 when nullif(s.attributes->>'url.path', '') is not null then
                   (s.attributes->>'url.path')
                   || case
                        when coalesce(
                               nullif(
                                 regexp_replace(
                                   coalesce(s.attributes->>'url.query', ''),
                                   '(^|&)_rsc=[^&]*',
                                   '',
                                   'g'
                                 ),
                                 ''
                               ),
                               ''
                             ) <> ''
                          then '?' || ltrim(
                                 regexp_replace(
                                   coalesce(s.attributes->>'url.query', ''),
                                   '(^|&)_rsc=[^&]*',
                                   '',
                                   'g'
                                 ),
                                 '&'
                               )
                        else ''
                      end
                 when nullif(s.attributes->>'http.target', '') is not null
                   then s.attributes->>'http.target'
                 when nullif(s.http_url, '') is not null
                   then regexp_replace(s.http_url, '^https?://[^/?#]+', '')
                 else null
               end
             ))
        from buho.otlp_spans s
       where s.trace_id = t.trace_id
         and (
           nullif(s.attributes->>'url.path', '') is not null
           or nullif(s.attributes->>'http.target', '') is not null
           or nullif(s.http_url, '') is not null
         )
       order by s.start_ts
       limit 1
    ),
    t.root_name
  )`;

/** Beyla SQL spans: name like SELECT … even when sql_text is null. */
const SPAN_IS_SQL = `(
  s.sql_text is not null
  or s.name ~* '^(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CALL|EXEC)\\b'
)`;

/**
 * Discover = HTTP transactions only.
 * Orphan SQL-as-root traces (Beyla correlation miss) are omitted — use Databases for SQL.
 */
const TRACE_IS_HTTP = `(
  t.http_status is not null
  or coalesce(t.root_name, '') ~* '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s'
  or exists (
    select 1 from buho.otlp_spans s
     where s.trace_id = t.trace_id and s.http_method is not null
  )
)`;

export async function listTraces(
  limit = 50,
  windowMinutesOrOpts?: number | ListTracesOpts,
): Promise<TraceSummary[]> {
  const lim = limit;
  const resolved: ListTracesOpts =
    typeof windowMinutesOrOpts === 'object' && windowMinutesOrOpts != null
      ? windowMinutesOrOpts
      : { windowMinutes: windowMinutesOrOpts };

  const real = otlpRealTracePredicate('t');
  const selectCols = `t.trace_id, t.root_service,
                ${TRACE_DISPLAY_ROUTE_SQL} as root_name,
                t.start_ts, t.end_ts, t.duration_ms,
                t.span_count, t.error_count,
                (
                  t.has_sql
                  or exists (
                    select 1 from buho.otlp_spans s
                     where s.trace_id = t.trace_id and ${SPAN_IS_SQL}
                  )
                ) as has_sql,
                t.http_status,
                (
                  select s.http_method from buho.otlp_spans s
                   where s.trace_id = t.trace_id and s.http_method is not null
                   order by s.start_ts limit 1
                ) as http_method,
                (
                  select coalesce(
                           nullif(s.attributes->>'db.name', ''),
                           nullif(s.attributes->>'db.namespace', '')
                         )
                    from buho.otlp_spans s
                   where s.trace_id = t.trace_id
                     and ${SPAN_IS_SQL}
                     and (
                       coalesce(s.attributes->>'db.name', '') <> ''
                       or coalesce(s.attributes->>'db.namespace', '') <> ''
                     )
                   order by s.start_ts limit 1
                ) as db_name,
                (
                  select coalesce(sum(s.duration_ms), 0)::float8
                    from buho.otlp_spans s
                   where s.trace_id = t.trace_id and ${SPAN_IS_SQL}
                ) as sql_ms`;

  const from = resolved.from ?? null;
  const to = resolved.to ?? null;
  const windowMinutes = from || to ? null : resolved.windowMinutes;

  let sql: string;
  let params: unknown[];
  if (from || to) {
    sql = `select ${selectCols}
             from buho.otlp_traces t
            where ${real}
              and ${TRACE_IS_HTTP}
              and ($2::timestamptz is null or t.start_ts >= $2::timestamptz)
              and ($3::timestamptz is null or t.start_ts <= $3::timestamptz)
            order by t.start_ts desc
            limit $1`;
    params = [lim, from, to];
  } else if (windowMinutes != null) {
    sql = `select ${selectCols}
             from buho.otlp_traces t
            where t.start_ts > now() - make_interval(mins => $2::int)
              and ${real}
              and ${TRACE_IS_HTTP}
            order by t.start_ts desc
            limit $1`;
    params = [lim, windowMinutes];
  } else {
    sql = `select ${selectCols}
             from buho.otlp_traces t
            where ${real}
              and ${TRACE_IS_HTTP}
            order by t.start_ts desc
            limit $1`;
    params = [lim];
  }

  const rows = await query<Record<string, unknown>>(sql, params);
  return rows.map((row) => ({
    traceId: String(row['trace_id']),
    rootService: (row['root_service'] as string | null) ?? null,
    rootName: (row['root_name'] as string | null) ?? null,
    startTs: row['start_ts'] as Date,
    endTs: row['end_ts'] as Date,
    durationMs: Number(row['duration_ms']),
    spanCount: Number(row['span_count']),
    errorCount: Number(row['error_count']),
    hasSql: Boolean(row['has_sql']),
    httpStatus: row['http_status'] == null ? null : Number(row['http_status']),
    httpMethod: (row['http_method'] as string | null) ?? null,
    dbName: (row['db_name'] as string | null) ?? null,
    sqlMs: row['sql_ms'] == null ? null : Number(row['sql_ms']),
  }));
}

export async function getTraceSpans(traceId: string): Promise<TraceSpan[]> {
  const rows = await query<Record<string, unknown>>(
    `select span_id, parent_span_id, name, kind, service_name, start_ts, end_ts,
            duration_ms, status_code, status_message, http_method, http_url,
            http_status, sql_text
       from buho.otlp_spans
      where trace_id = $1
      order by start_ts, span_id`,
    [traceId],
  );
  return rows.map((row) => {
    const name = String(row['name']);
    return {
      spanId: String(row['span_id']),
      parentSpanId: (row['parent_span_id'] as string | null) ?? null,
      name,
      kind: String(row['kind']),
      serviceName: String(row['service_name']),
      startTs: row['start_ts'] as Date,
      endTs: row['end_ts'] as Date,
      durationMs: Number(row['duration_ms']),
      statusCode: String(row['status_code']),
      statusMessage: (row['status_message'] as string | null) ?? null,
      httpMethod: (row['http_method'] as string | null) ?? null,
      httpUrl: (row['http_url'] as string | null) ?? null,
      httpStatus: row['http_status'] == null ? null : Number(row['http_status']),
      sqlText: resolveSqlText((row['sql_text'] as string | null) ?? null, name),
    };
  });
}

export async function listServiceDeps(): Promise<
  Array<{
    fromAlias: string | null;
    fromService: string | null;
    fromEngine: string | null;
    toAlias: string;
    toEngine: string;
    toHost: string;
    toPort: number;
    toInstanceId: number;
    relation: string;
  }>
> {
  const rows = await query<Record<string, unknown>>(
    `select f.alias as from_alias, d.from_service_name, f.engine as from_engine,
            t.alias as to_alias, t.engine as to_engine, t.host as to_host, t.port as to_port,
            d.to_instance_id, d.relation
       from buho.service_deps d
       left join buho.instances f on f.instance_id = d.from_instance_id
       join buho.instances t on t.instance_id = d.to_instance_id
      order by 1, 3`,
  );
  return rows.map((row) => ({
    fromAlias: (row['from_alias'] as string | null) ?? null,
    fromService: (row['from_service_name'] as string | null) ?? null,
    fromEngine: (row['from_engine'] as string | null) ?? null,
    toAlias: String(row['to_alias']),
    toEngine: String(row['to_engine'] ?? 'postgres'),
    toHost: String(row['to_host'] ?? ''),
    toPort: Number(row['to_port'] ?? 0),
    toInstanceId: Number(row['to_instance_id']),
    relation: String(row['relation']),
  }));
}
