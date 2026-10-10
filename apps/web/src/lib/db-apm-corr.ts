import { query } from './db';

export type DbApmCorrLink = {
  instanceId: number;
  alias: string;
  host: string;
  serviceName: string | null;
  tracesHref: string | null;
  logsHref: string;
};

/** Same-host / declared-dep links between DB instances and APM services. */
export async function listDbApmCorr(limit = 80): Promise<DbApmCorrLink[]> {
  const rows = await query<Record<string, unknown>>(
    `with svc as (
       select distinct service_name
         from buho.otlp_spans
        where start_ts >= now() - interval '24 hours'
     ),
     deps as (
       select d.to_instance_id as instance_id,
              d.from_service_name as service_name
         from buho.service_deps d
        where d.from_service_name is not null
     )
     select i.instance_id, i.alias, i.host,
            coalesce(d.service_name, s.service_name) as service_name
       from buho.instances i
       left join deps d on d.instance_id = i.instance_id
       left join svc s on lower(s.service_name) = lower(i.alias)
                      or lower(s.service_name) = lower(split_part(i.host, '.', 1))
      where i.engine in ('postgres', 'mariadb', 'mssql', 'oracle')
        and (d.service_name is not null or s.service_name is not null)
      order by i.alias
      limit $1`,
    [limit],
  );

  return rows.map((row) => {
    const instanceId = Number(row['instance_id']);
    const serviceName = (row['service_name'] as string | null) ?? null;
    return {
      instanceId,
      alias: String(row['alias']),
      host: String(row['host'] ?? ''),
      serviceName,
      tracesHref: serviceName
        ? `/observability/apm/traces?service=${encodeURIComponent(serviceName)}`
        : '/observability/apm/traces',
      logsHref: `/instances/${instanceId}/logs`,
    };
  });
}
