import { probeEndpoint } from '@buho/core';
import { evaluateEndpointSamples, endpointHealthScore } from '@buho/checks';
import { Store } from '@buho/store';
import { query } from './db';
import { listApmServiceDbLinks } from './traces';

/** Infer probe base URL + path from recent OTLP span attributes. */
export async function inferApmProbeUrl(serviceName: string): Promise<{
  baseUrl: string;
  path: string;
} | null> {
  const rows = await query<{ url: string | null }>(
    `select coalesce(
              nullif(attributes->>'url.full', ''),
              nullif(attributes->>'http.url', ''),
              nullif(attributes->>'http.target', '')
            ) as url
       from buho.otlp_spans
      where service_name = $1
        and start_ts > now() - interval '24 hours'
        and (
              coalesce(attributes->>'url.full', '') <> ''
           or coalesce(attributes->>'http.url', '') <> ''
           or coalesce(attributes->>'http.target', '') <> ''
        )
      order by start_ts desc
      limit 20`,
    [serviceName],
  );

  for (const row of rows) {
    const raw = row.url?.trim();
    if (!raw) continue;
    if (raw.startsWith('/')) {
      return { baseUrl: `http://${serviceName}.lab`, path: raw.split('?')[0] || '/' };
    }
    try {
      const u = new URL(raw);
      return { baseUrl: `${u.protocol}//${u.host}`, path: u.pathname || '/' };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function preferDependsAlias(serviceName: string): Promise<string | undefined> {
  const links = await listApmServiceDbLinks(null);
  const list = links.get(serviceName) ?? [];
  if (list.length === 0) return undefined;
  const preferred =
    list.find((l) => !/standby|replica|secondary/i.test(l.alias)) ?? list[0];
  return preferred?.alias;
}

/**
 * Create (or refresh) an uptime monitor for an APM service name.
 * Uses OTLP url.full / http.url when available.
 */
export async function ensureUptimeForService(
  serviceName: string,
  createdBy = 'system',
): Promise<
  | { ok: true; instanceId: number; baseUrl: string; path: string; created: boolean }
  | { ok: false; error: string }
> {
  const existing = await query<{ instance_id: number }>(
    `select instance_id from buho.instances
      where tenant = 'default' and alias = $1 and engine = 'endpoint'`,
    [serviceName],
  );
  if (existing[0]) {
    return {
      ok: true,
      instanceId: Number(existing[0].instance_id),
      baseUrl: '',
      path: '/',
      created: false,
    };
  }

  const inferred = await inferApmProbeUrl(serviceName);
  if (!inferred) {
    return {
      ok: false,
      error: 'No http.url / url.full in OTLP spans — cannot infer probe URL.',
    };
  }

  const { baseUrl, path } = inferred;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'Invalid inferred baseUrl' };
  }

  const host = parsed.hostname;
  const port =
    parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : 80;
  const ssl = parsed.protocol === 'https:';
  const dependsOnAlias = await preferDependsAlias(serviceName);
  const paths = [path.startsWith('/') ? path : `/${path}`];
  const endpoint = {
    baseUrl,
    paths,
    expectStatus: [200, 204, 301, 302, 303, 307, 308, 401, 403],
    warnMs: 1500,
    tcp: true,
    tlsCert: ssl,
    ...(dependsOnAlias ? { dependsOnAlias } : {}),
  };

  await query(
    `insert into buho.monitor_targets
       (alias, engine, host, port, database, username, password, environment, ssl,
        tags, host_metrics, endpoint, enabled, created_by)
     values ($1,'endpoint',$2,$3,'','','','LAB',$4,
             '{}'::jsonb,'{}'::jsonb,$5::jsonb, true, $6)
     on conflict (tenant, alias) do update set
       engine = 'endpoint',
       host = excluded.host,
       port = excluded.port,
       ssl = excluded.ssl,
       endpoint = excluded.endpoint,
       enabled = true,
       updated_at = now()`,
    [serviceName, host, port, ssl, JSON.stringify(endpoint), createdBy],
  );

  await query(
    `insert into buho.instances (tenant, alias, host, port, database, environment, engine, last_seen_at)
     values ('default', $1, $2, $3, '', 'LAB', 'endpoint', null)
     on conflict (tenant, alias) do update set
       host = excluded.host,
       port = excluded.port,
       environment = excluded.environment,
       engine = 'endpoint'`,
    [serviceName, host, port],
  );

  if (dependsOnAlias) {
    await query(
      `insert into buho.service_deps (from_instance_id, to_instance_id, relation)
       select f.instance_id, t.instance_id, 'depends_on'
         from buho.instances f
         join buho.instances t on t.alias = $2
        where f.alias = $1
       on conflict (from_instance_id, to_instance_id) do update
         set relation = excluded.relation`,
      [serviceName, dependsOnAlias],
    );
  }

  const idRows = await query<{ instance_id: string }>(
    `select instance_id from buho.instances where tenant = 'default' and alias = $1`,
    [serviceName],
  );
  const instanceId = Number(idRows[0]?.instance_id ?? 0);

  if (instanceId && process.env['BUHO_STORE_URL']) {
    try {
      const store = new Store(process.env['BUHO_STORE_URL']);
      const result = await probeEndpoint({
        host,
        port,
        ssl,
        probe: {
          baseUrl,
          paths,
          expectStatus: endpoint.expectStatus,
          warnMs: 1500,
          tcp: true,
          tlsCert: ssl,
        },
      });
      await store.insertSamples(instanceId, result.samples);
      const findings = evaluateEndpointSamples(result.samples);
      await store.saveCheckResults(instanceId, findings, endpointHealthScore(findings));
      await store.close();
    } catch {
      /* collector will fill */
    }
  }

  return { ok: true, instanceId, baseUrl, path: paths[0]!, created: true };
}
