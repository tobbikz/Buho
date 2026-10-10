import { query } from './db';

export type ObsAnomaly = {
  entity: string;
  kind: 'probe_latency' | 'apm_error_rate' | 'log_rate';
  message: string;
  href: string;
  value: number;
  baseline: number;
};

/**
 * Explainable Obs anomalies (threshold vs recent median) — not Elastic ML.
 * Surfaces on Services for probe latency and APM error-rate spikes.
 */
export async function listObsAnomalies(limit = 12): Promise<ObsAnomaly[]> {
  const out: ObsAnomaly[] = [];

  const probeRows = await query<{
    alias: string;
    instance_id: string;
    recent_ms: string;
    baseline_ms: string;
  }>(
    `with recent as (
       select i.instance_id, i.alias, avg(s.value) as recent_ms
         from buho.instances i
         join buho.metric_samples s on s.instance_id = i.instance_id
        where i.engine = 'endpoint'
          and s.metric = 'endpoint_http_ms'
          and s.ts >= now() - interval '20 minutes'
          and s.labels = '{}'::jsonb
        group by i.instance_id, i.alias
     ),
     baseline as (
       select i.instance_id, percentile_cont(0.5) within group (order by s.value) as baseline_ms
         from buho.instances i
         join buho.metric_samples s on s.instance_id = i.instance_id
        where i.engine = 'endpoint'
          and s.metric = 'endpoint_http_ms'
          and s.ts >= now() - interval '7 days'
          and s.ts < now() - interval '20 minutes'
          and s.labels = '{}'::jsonb
        group by i.instance_id
       having count(*) >= 20
     )
     select r.alias, r.instance_id::text, r.recent_ms::text, b.baseline_ms::text
       from recent r
       join baseline b using (instance_id)
      where r.recent_ms > b.baseline_ms * 2
        and r.recent_ms > b.baseline_ms + 100
      order by (r.recent_ms / nullif(b.baseline_ms, 0)) desc
      limit $1`,
    [limit],
  );

  for (const row of probeRows) {
    const value = Number(row.recent_ms);
    const baseline = Number(row.baseline_ms);
    out.push({
      entity: row.alias,
      kind: 'probe_latency',
      message: `Probe latency ${Math.round(value)} ms vs 7d median ${Math.round(baseline)} ms (≥2×)`,
      href: `/observability/monitors/${row.instance_id}`,
      value,
      baseline,
    });
  }

  const apmRows = await query<{
    service_name: string;
    recent_err: string;
    baseline_err: string;
  }>(
    `with recent as (
       select service_name,
              avg(case when status_code = 'ERROR' then 1.0 else 0.0 end) as recent_err,
              count(*) as n
         from buho.otlp_spans
        where start_ts >= now() - interval '20 minutes'
        group by service_name
       having count(*) >= 10
     ),
     baseline as (
       select service_name,
              avg(case when status_code = 'ERROR' then 1.0 else 0.0 end) as baseline_err
         from buho.otlp_spans
        where start_ts >= now() - interval '7 days'
          and start_ts < now() - interval '20 minutes'
        group by service_name
       having count(*) >= 50
     )
     select r.service_name, r.recent_err::text, b.baseline_err::text
       from recent r
       join baseline b using (service_name)
      where r.recent_err > greatest(b.baseline_err * 2, b.baseline_err + 0.05)
        and r.recent_err >= 0.05
      order by r.recent_err desc
      limit $1`,
    [limit],
  );

  for (const row of apmRows) {
    const value = Number(row.recent_err);
    const baseline = Number(row.baseline_err);
    out.push({
      entity: row.service_name,
      kind: 'apm_error_rate',
      message: `Error rate ${(value * 100).toFixed(1)}% vs 7d ${(baseline * 100).toFixed(1)}%`,
      href: `/observability/apm/traces?service=${encodeURIComponent(row.service_name)}`,
      value,
      baseline,
    });
  }

  return out.slice(0, limit);
}
