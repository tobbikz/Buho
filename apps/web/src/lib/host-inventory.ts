import { query } from './db';

export type HostInventoryRow = {
  host: string;
  roles: Array<'database' | 'probe'>;
  engines: string[];
  aliases: Array<{ alias: string; instanceId: number; engine: string }>;
  lastSeenAt: Date | null;
  hostMetricsAt: Date | null;
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
};

/** Derived Obs host fleet from instances + latest host_* samples (not Elastic Agent). */
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
            max(hm.disk_used_pct) as disk_used_pct
       from inst i
       left join host_metrics hm on hm.host = i.host
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
    const roles: Array<'database' | 'probe'> = [];
    if (engines.some((e) => e !== 'endpoint')) roles.push('database');
    if (engines.includes('endpoint')) roles.push('probe');
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
    };
  });
}
