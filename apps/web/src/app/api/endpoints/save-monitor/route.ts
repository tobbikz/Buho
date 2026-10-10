import { NextResponse } from 'next/server';
import { probeEndpoint } from '@buho/core';
import { evaluateEndpointSamples, endpointHealthScore } from '@buho/checks';
import { Store } from '@buho/store';
import { query } from '@/lib/db';
import { requireAdmin } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Body = {
  alias?: string;
  baseUrl?: string;
  paths?: string[];
  expectStatus?: number[];
  warnMs?: number;
  /** Optional override; if omitted we infer from peers / existing deps. */
  dependsOnAlias?: string;
  environment?: string;
};

/**
 * Infer which DB an HTTP monitor depends on:
 * 1) same host:port peers that already declare dependsOnAlias
 * 2) service_deps from any endpoint on that host:port
 * 3) single postgres instance in the estate (common lab case)
 */
async function inferDependsOnAlias(
  host: string,
  port: number,
): Promise<string | undefined> {
  const fromPeers = await query<{ dep: string }>(
    `select endpoint->>'dependsOnAlias' as dep
       from buho.monitor_targets
      where engine = 'endpoint'
        and host = $1 and port = $2
        and coalesce(endpoint->>'dependsOnAlias', '') <> ''
      order by updated_at desc
      limit 1`,
    [host, port],
  );
  if (fromPeers[0]?.dep) return String(fromPeers[0].dep);

  const fromConfigPeers = await query<{ dep: string }>(
    `select t.alias as dep
       from buho.service_deps d
       join buho.instances f on f.instance_id = d.from_instance_id
       join buho.instances t on t.instance_id = d.to_instance_id
      where f.engine = 'endpoint'
        and f.host = $1 and f.port = $2
        and t.engine <> 'endpoint'
      order by d.dep_id
      limit 1`,
    [host, port],
  );
  if (fromConfigPeers[0]?.dep) return String(fromConfigPeers[0].dep);

  const soleDb = await query<{ alias: string }>(
    `select alias from buho.instances
      where engine in ('postgres','mariadb','mssql','oracle')
        and last_seen_at is not null
      order by last_seen_at desc nulls last
      limit 2`,
  );
  if (soleDb.length === 1) return soleDb[0]?.alias;

  return undefined;
}

/**
 * Persist an Analyze URL run as a continuous endpoint monitor
 * (path inventory + first probe so Documents are not empty).
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireAdmin();
  } catch {
    return NextResponse.json({ error: 'admin required' }, { status: 403 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const alias = (body.alias ?? '').trim();
  const baseUrl = (body.baseUrl ?? '').trim();
  const paths = Array.isArray(body.paths)
    ? Array.from(
        new Set(
          body.paths
            .map((p) => String(p).trim())
            .filter(Boolean)
            .map((p) => (p.startsWith('/') ? p : `/${p}`)),
        ),
      )
    : [];

  if (!alias || !/^[a-zA-Z0-9._-]+$/.test(alias)) {
    return NextResponse.json(
      { error: 'alias required (letters, digits, . _ -)' },
      { status: 400 },
    );
  }
  if (!baseUrl) {
    return NextResponse.json({ error: 'baseUrl required' }, { status: 400 });
  }
  if (paths.length === 0) {
    return NextResponse.json({ error: 'at least one path required' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return NextResponse.json({ error: 'invalid baseUrl' }, { status: 400 });
  }

  const host = parsed.hostname;
  const port =
    parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : 80;
  const ssl = parsed.protocol === 'https:';
  const manualDepends = (body.dependsOnAlias ?? '').trim();
  const dependsOnAlias =
    manualDepends || (await inferDependsOnAlias(host, port)) || undefined;
  const expectStatus =
    Array.isArray(body.expectStatus) && body.expectStatus.length > 0
      ? body.expectStatus.map(Number)
      : [200, 204, 301, 302, 303, 307, 308, 401, 403];
  const warnMs = body.warnMs ?? 1500;
  const environment = (body.environment ?? 'PROD').trim().toUpperCase() || 'PROD';

  const endpoint = {
    baseUrl,
    paths,
    expectStatus,
    warnMs,
    tcp: true,
    tlsCert: ssl,
    ...(dependsOnAlias ? { dependsOnAlias } : {}),
  };

  try {
    const rows = await query<{ target_id: string }>(
      `insert into buho.monitor_targets
         (alias, engine, host, port, database, username, password, environment, ssl,
          tags, host_metrics, endpoint, enabled, created_by)
       values ($1,'endpoint',$2,$3,'',$4,'',$5,$6,
               '{}'::jsonb,'{}'::jsonb,$7::jsonb, true, $8)
       on conflict (tenant, alias) do update set
         engine = 'endpoint',
         host = excluded.host,
         port = excluded.port,
         database = '',
         ssl = excluded.ssl,
         environment = excluded.environment,
         endpoint = excluded.endpoint,
         enabled = true,
         updated_at = now()
       returning target_id`,
      [
        alias,
        host,
        port,
        '',
        environment,
        ssl,
        JSON.stringify(endpoint),
        session.username,
      ],
    );

    await query(
      `insert into buho.instances (tenant, alias, host, port, database, environment, engine, last_seen_at)
       values ('default', $1, $2, $3, '', $4, 'endpoint', null)
       on conflict (tenant, alias) do update set
         host = excluded.host,
         port = excluded.port,
         environment = excluded.environment,
         engine = 'endpoint'`,
      [alias, host, port, environment],
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
        [alias, dependsOnAlias],
      );
    }

    const idRows = await query<{ instance_id: string }>(
      `select instance_id from buho.instances where tenant = 'default' and alias = $1`,
      [alias],
    );
    const instanceId = Number(idRows[0]?.instance_id ?? 0);

    // First probe now so Documents / cards are not empty while waiting for collector.
    let probedPaths = 0;
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
            expectStatus,
            warnMs,
            tcp: true,
            tlsCert: ssl,
          },
        });
        await store.insertSamples(instanceId, result.samples);
        const findings = evaluateEndpointSamples(result.samples);
        const score = endpointHealthScore(findings);
        await store.saveCheckResults(instanceId, findings, score);
        probedPaths = paths.length;
        await store.close();
      } catch {
        // Collector will fill in; save still succeeded.
      }
    }

    await logConsoleEvent(
      session.username,
      'endpoint_monitor.save',
      `${alias} · ${paths.length} paths · ${baseUrl}` +
        (dependsOnAlias ? ` · depends ${dependsOnAlias}${manualDepends ? '' : ' (inferred)'}` : '') +
        (probedPaths ? ` · probed ${probedPaths}` : ''),
    );

    return NextResponse.json({
      ok: true,
      targetId: Number(rows[0]?.target_id),
      instanceId: instanceId || null,
      alias,
      pathCount: paths.length,
      baseUrl,
      dependsOnAlias: dependsOnAlias ?? null,
      dependsInferred: Boolean(dependsOnAlias && !manualDepends),
      probed: probedPaths > 0,
      note: probedPaths
        ? 'First probe done — Documents should show paths now. Collector keeps them fresh.'
        : 'Saved. Collector will probe within ~30s.',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
