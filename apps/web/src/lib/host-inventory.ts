import { query } from './db';

export type HostRole = 'database' | 'probe' | 'infra';

export type HostInventoryRow = {
  host: string;
  roles: HostRole[];
  engines: string[];
  aliases: Array<{ alias: string; instanceId: number; engine: string }>;
  lastSeenAt: Date | null;
  hostMetricsAt: Date | null;
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  /** Sensors up / total from engine=infra in last 15m (null if no infra). */
  sensorsUp: number | null;
  sensorsTotal: number | null;
};

export type HostSensorRow = {
  instanceId: number;
  alias: string;
  sensorId: string;
  sensorType: string;
  ok: boolean | null;
  durationMs: number | null;
  lastAt: Date | null;
  metrics: Array<{ metric: string; value: number }>;
};

/** Derived Obs host fleet + infra devices (ADR buho-infra-prtg-sensors-2026-10-10). */
export async function listHostInventory(): Promise<HostInventoryRow[]> {
  const rows = await query<Record<string, unknown>>(
    `with inst as (
       select instance_id, alias, engine, host, last_seen_at
         from buho.instances
        where coalesce(nullif(trim(host), ''), '') <> ''
     ),
     latest_metric as (
       select distinct on (i.host, s.metric)
              i.host, s.metric, s.value, s.ts
         from inst i
         join buho.metric_samples s on s.instance_id = i.instance_id
        where s.metric in ('host_cpu_pct', 'host_mem_used_pct', 'host_disk_used_pct')
          and s.ts >= now() - interval '24 hours'
        order by i.host, s.metric, s.ts desc
     ),
     host_metrics as (
       select host,
              max(ts) as host_metrics_at,
              max(value) filter (where metric = 'host_cpu_pct') as cpu_pct,
              max(value) filter (where metric = 'host_mem_used_pct') as mem_used_pct,
              max(value) filter (where metric = 'host_disk_used_pct') as disk_used_pct
         from latest_metric
        group by host
     ),
     sensor_latest as (
       select distinct on (i.host, s.labels->>'sensor_id')
              i.host,
              s.labels->>'sensor_id' as sensor_id,
              s.value as sensor_ok,
              s.ts
         from inst i
         join buho.metric_samples s on s.instance_id = i.instance_id
        where i.engine = 'infra'
          and s.metric = 'sensor_ok'
          and s.ts >= now() - interval '15 minutes'
          and coalesce(s.labels->>'sensor_id', '') <> ''
        order by i.host, s.labels->>'sensor_id', s.ts desc
     ),
     sensor_agg as (
       select host,
              count(*)::int as sensors_total,
              count(*) filter (where sensor_ok >= 1)::int as sensors_up
         from sensor_latest
        group by host
     )
     select i.host,
            array_agg(distinct i.engine order by i.engine) as engines,
            json_agg(json_build_object(
              'alias', i.alias,
              'instanceId', i.instance_id,
              'engine', i.engine
            ) order by i.alias) as aliases,
            max(i.last_seen_at) as last_seen_at,
            max(hm.host_metrics_at) as host_metrics_at,
            max(hm.cpu_pct) as cpu_pct,
            max(hm.mem_used_pct) as mem_used_pct,
            max(hm.disk_used_pct) as disk_used_pct,
            max(sa.sensors_up) as sensors_up,
            max(sa.sensors_total) as sensors_total
       from inst i
       left join host_metrics hm on hm.host = i.host
       left join sensor_agg sa on sa.host = i.host
      group by i.host
      order by i.host`,
  );

  return rows.map((row) => {
    const aliasesRaw = row['aliases'];
    const aliases = (Array.isArray(aliasesRaw) ? aliasesRaw : []) as Array<{
      alias: string;
      instanceId: number | string;
      engine: string;
    }>;
    const engines = (row['engines'] as string[]) ?? [];
    const roles: HostRole[] = [];
    if (engines.some((e) => e !== 'endpoint' && e !== 'infra')) roles.push('database');
    if (engines.includes('endpoint')) roles.push('probe');
    if (engines.includes('infra')) roles.push('infra');
    return {
      host: String(row['host']),
      roles,
      engines,
      aliases: aliases.map((a) => ({
        alias: String(a.alias),
        instanceId: Number(a.instanceId),
        engine: String(a.engine),
      })),
      lastSeenAt: (row['last_seen_at'] as Date | null) ?? null,
      hostMetricsAt: (row['host_metrics_at'] as Date | null) ?? null,
      cpuPct: row['cpu_pct'] == null ? null : Number(row['cpu_pct']),
      memUsedPct: row['mem_used_pct'] == null ? null : Number(row['mem_used_pct']),
      diskUsedPct: row['disk_used_pct'] == null ? null : Number(row['disk_used_pct']),
      sensorsUp: row['sensors_up'] == null ? null : Number(row['sensors_up']),
      sensorsTotal: row['sensors_total'] == null ? null : Number(row['sensors_total']),
    };
  });
}

export async function getHostDetail(host: string): Promise<{
  inventory: HostInventoryRow | null;
  sensors: HostSensorRow[];
  sparks: { cpu: number[]; mem: number[]; disk: number[] };
}> {
  const all = await listHostInventory();
  const inventory = all.find((r) => r.host === host) ?? null;
  if (!inventory) return { inventory: null, sensors: [], sparks: { cpu: [], mem: [], disk: [] } };

  const sensorRows = await query<Record<string, unknown>>(
    `with latest as (
       select distinct on (i.instance_id, s.labels->>'sensor_id', s.metric)
              i.instance_id, i.alias,
              s.labels->>'sensor_id' as sensor_id,
              s.labels->>'sensor_type' as sensor_type,
              s.metric, s.value, s.ts
         from buho.instances i
         join buho.metric_samples s on s.instance_id = i.instance_id
        where i.host = $1
          and i.engine = 'infra'
          and s.ts >= now() - interval '1 hour'
          and coalesce(s.labels->>'sensor_id', '') <> ''
        order by i.instance_id, s.labels->>'sensor_id', s.metric, s.ts desc
     )
     select instance_id, alias, sensor_id, sensor_type, metric, value, ts
       from latest
      order by alias, sensor_id, metric`,
    [host],
  );

  const byKey = new Map<string, HostSensorRow>();
  for (const row of sensorRows) {
    const key = `${row['instance_id']}/${row['sensor_id']}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        instanceId: Number(row['instance_id']),
        alias: String(row['alias']),
        sensorId: String(row['sensor_id']),
        sensorType: String(row['sensor_type'] ?? 'unknown'),
        ok: null,
        durationMs: null,
        lastAt: null,
        metrics: [],
      };
      byKey.set(key, entry);
    }
    const metric = String(row['metric']);
    const value = Number(row['value']);
    const ts = row['ts'] as Date;
    if (!entry.lastAt || ts > entry.lastAt) entry.lastAt = ts;
    if (metric === 'sensor_ok') entry.ok = value >= 1;
    else if (metric === 'sensor_duration_ms') entry.durationMs = value;
    else if (metric.startsWith('sensor_') || metric.startsWith('host_')) {
      entry.metrics.push({ metric, value });
    }
  }

  const sparkRows = await query<Record<string, unknown>>(
    `select s.metric, s.value, s.ts
       from buho.instances i
       join buho.metric_samples s on s.instance_id = i.instance_id
      where i.host = $1
        and s.metric in ('host_cpu_pct', 'host_mem_used_pct', 'host_disk_used_pct')
        and s.ts >= now() - interval '6 hours'
      order by s.ts asc
      limit 500`,
    [host],
  );
  const sparks = { cpu: [] as number[], mem: [] as number[], disk: [] as number[] };
  for (const row of sparkRows) {
    const m = String(row['metric']);
    const v = Number(row['value']);
    if (!Number.isFinite(v)) continue;
    if (m === 'host_cpu_pct') sparks.cpu.push(v);
    if (m === 'host_mem_used_pct') sparks.mem.push(v);
    if (m === 'host_disk_used_pct') sparks.disk.push(v);
  }

  return { inventory, sensors: [...byKey.values()], sparks };
}
