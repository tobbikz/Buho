#!/usr/bin/env node
/**
 * Búho MCP — stdio server for agents.
 *
 * Env:
 *   BUHO_STORE_URL   (required) postgres://… store
 *   BUHO_MCP_ALLOW_WRITE=true  enable compliance run / actions (default off)
 *   BUHO_WEB_URL + BUHO_API_TOKEN  optional: proxy writes through /api/v1
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Pool } from 'pg';
import { Store } from '@buho/store';

const STORE_URL = process.env['BUHO_STORE_URL']?.trim();
if (!STORE_URL) {
  console.error('BUHO_STORE_URL is required');
  process.exit(1);
}

const ALLOW_WRITE = process.env['BUHO_MCP_ALLOW_WRITE'] === 'true';
const WEB_URL = process.env['BUHO_WEB_URL']?.replace(/\/$/, '') ?? '';
const API_TOKEN = process.env['BUHO_API_TOKEN']?.trim() ?? '';

function dumps(data: unknown, max = 100_000): string {
  const text = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
  return text.length > max ? `${text.slice(0, max)}\n… truncated (${text.length} chars)` : text;
}

function pool(): Pool {
  return new Pool({ connectionString: STORE_URL, max: 3 });
}

async function resolveAlias(alias: string): Promise<{ instanceId: number; engine: string; host: string; port: number } | null> {
  const p = pool();
  try {
    const r = await p.query<{ instance_id: string; engine: string; host: string; port: number }>(
      `select instance_id::text, engine, host, port from buho.instances where alias = $1`,
      [alias],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      instanceId: Number(row.instance_id),
      engine: row.engine,
      host: row.host,
      port: Number(row.port),
    };
  } finally {
    await p.end();
  }
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  if (!WEB_URL || !API_TOKEN) {
    throw new Error('BUHO_WEB_URL and BUHO_API_TOKEN required for write tools via API');
  }
  const res = await fetch(`${WEB_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

const server = new McpServer({
  name: 'buho',
  version: '0.1.0',
});

server.tool(
  'buho_health',
  'Config + store connectivity smoke test for the Búho MCP.',
  {},
  async () => {
    const info: Record<string, unknown> = {
      storeConfigured: Boolean(STORE_URL),
      allowWrite: ALLOW_WRITE,
      webUrl: WEB_URL || null,
      apiTokenSet: Boolean(API_TOKEN),
    };
    const p = pool();
    try {
      const r = await p.query<{ n: string }>('select count(*)::text as n from buho.instances');
      info.login = 'ok';
      info.instances = Number(r.rows[0]?.n ?? 0);
    } catch (e) {
      info.login = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await p.end();
    }
    return { content: [{ type: 'text' as const, text: dumps(info) }] };
  },
);

server.tool(
  'buho_list_fleet',
  'List monitored instances with latest health score and key metrics (last ~10 minutes).',
  {
    engine: z.string().optional().describe('Filter by engine (postgres, mariadb, kafka, …)'),
  },
  async ({ engine }) => {
    const p = pool();
    try {
      const r = await p.query(
        `with scores as (
           select distinct on (instance_id) instance_id, score, critical, warning, info, ts
             from buho.health_scores
            order by instance_id, ts desc
         )
         select i.instance_id, i.alias, i.engine, i.host, i.port, i.database, i.environment,
                i.last_seen_at, s.score, s.critical, s.warning, s.info, s.ts as score_ts
           from buho.instances i
           left join scores s using (instance_id)
          where ($1::text is null or i.engine = $1)
          order by i.alias`,
        [engine ?? null],
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({ count: r.rows.length, instances: r.rows }),
          },
        ],
      };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_get_instance',
  'Get one instance by alias (identity + latest health score).',
  { alias: z.string() },
  async ({ alias }) => {
    const p = pool();
    try {
      const r = await p.query(
        `with scores as (
           select distinct on (instance_id) instance_id, score, critical, warning, info, ts
             from buho.health_scores
            order by instance_id, ts desc
         )
         select i.*, s.score, s.critical, s.warning, s.info, s.ts as score_ts,
                e.version_text, e.edition
           from buho.instances i
           left join scores s using (instance_id)
           left join buho.engine_info e using (instance_id)
          where i.alias = $1`,
        [alias],
      );
      if (!r.rows[0]) {
        return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: dumps(r.rows[0]) }] };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_get_metrics',
  'Latest metric samples for an alias (default connection/block/cache/host set). Window: 15 minutes.',
  {
    alias: z.string(),
    names: z
      .array(z.string())
      .optional()
      .describe('Metric names; omit for a sensible default set'),
  },
  async ({ alias, names }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    const metrics =
      names && names.length > 0
        ? names
        : [
            'connections_used_pct',
            'connections_total',
            'blocked_sessions',
            'uptime_seconds',
            'db_cache_hit_pct',
            'replication_replay_lag_seconds',
            'host_cpu_pct',
            'host_mem_used_pct',
            'kafka_under_replicated_partitions',
            'airflow_import_errors',
          ];
    const store = new Store(STORE_URL!);
    try {
      const values = await store.latestMetrics(hit.instanceId, metrics);
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({ alias, ...hit, window: '15m', metrics: values }),
          },
        ],
      };
    } finally {
      await store.close();
    }
  },
);

server.tool(
  'buho_list_alerts',
  'Open / pending alerts across the fleet.',
  {
    status: z
      .array(z.enum(['pending', 'firing', 'resolved']))
      .optional()
      .describe('Default: pending,firing'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ status, limit }) => {
    const store = new Store(STORE_URL!);
    try {
      const alerts = await store.listAlerts({
        status: status ?? ['pending', 'firing'],
        limit: limit ?? 100,
      });
      return { content: [{ type: 'text' as const, text: dumps({ count: alerts.length, alerts }) }] };
    } finally {
      await store.close();
    }
  },
);

server.tool(
  'buho_latest_checks',
  'Latest check_results for an alias (24h, one row per check_id).',
  { alias: z.string() },
  async ({ alias }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    const p = pool();
    try {
      const r = await p.query(
        `select distinct on (check_id)
                check_id, severity, title, object, message, remediation, ts
           from buho.check_results
          where instance_id = $1
            and ts > now() - interval '24 hours'
          order by check_id, ts desc`,
        [hit.instanceId],
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({ alias, instanceId: hit.instanceId, count: r.rows.length, checks: r.rows }),
          },
        ],
      };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_compliance_latest',
  'Latest compliance pack scores (CIS/STIG) per instance.',
  {},
  async () => {
    const p = pool();
    try {
      const r = await p.query(
        `select distinct on (r.instance_id, r.pack)
                i.alias, i.engine, r.pack, r.score, r.ts,
                jsonb_array_length(r.controls) as controls
           from buho.compliance_runs r
           join buho.instances i on i.instance_id = r.instance_id
          order by r.instance_id, r.pack, r.ts desc`,
      );
      return { content: [{ type: 'text' as const, text: dumps({ count: r.rows.length, runs: r.rows }) }] };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_platform_summary',
  'Deep Platform snapshot: Kafka/CDC/Airflow instances with health scores and lag-ish metrics.',
  {},
  async () => {
    const p = pool();
    try {
      const r = await p.query(
        `with scores as (
           select distinct on (instance_id) instance_id, score, critical, warning, ts
             from buho.health_scores
            order by instance_id, ts desc
         ),
         metrics as (
           select distinct on (instance_id, metric) instance_id, metric, value
             from buho.metric_samples
            where ts > now() - interval '15 minutes'
              and metric = any(array[
                'kafka_under_replicated_partitions',
                'kafka_offline_partitions',
                'cdc_apply_lag_seconds',
                'airflow_import_errors',
                'airflow_dag_count',
                'airflow_scheduler_healthy'
              ])
            order by instance_id, metric, ts desc
         )
         select i.alias, i.engine, i.host, i.port, s.score, s.critical, s.warning, s.ts as score_ts,
                coalesce(jsonb_object_agg(m.metric, m.value) filter (where m.metric is not null), '{}'::jsonb) as metrics
           from buho.instances i
           left join scores s using (instance_id)
           left join metrics m using (instance_id)
          where i.engine in ('kafka', 'cdc', 'airflow')
          group by i.alias, i.engine, i.host, i.port, s.score, s.critical, s.warning, s.ts
          order by i.engine, i.alias`,
      );
      return {
        content: [{ type: 'text' as const, text: dumps({ count: r.rows.length, platform: r.rows }) }],
      };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_wait_blame',
  'DPA wait → SQL blame for an alias: non-idle session samples joined to latest plan fingerprint (Store.listWaitSqlBlame).',
  {
    alias: z.string(),
    minutes: z.number().int().min(5).max(10_080).optional().describe('Window in minutes (default 60)'),
  },
  async ({ alias, minutes }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    const store = new Store(STORE_URL!);
    try {
      const windowMinutes = minutes ?? 60;
      const [classShare, blame] = await Promise.all([
        store.listWaitClassShare(hit.instanceId, windowMinutes),
        store.listWaitSqlBlame(hit.instanceId, windowMinutes),
      ]);
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({
              alias,
              instanceId: hit.instanceId,
              windowMinutes,
              waitClassShare: classShare,
              blame,
            }),
          },
        ],
      };
    } finally {
      await store.close();
    }
  },
);

server.tool(
  'buho_plan_fingerprints',
  'Auto-plan fingerprint history for a queryid (Store.listPlanFingerprints).',
  {
    alias: z.string(),
    queryid: z.number().int().positive(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ alias, queryid, limit }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    const store = new Store(STORE_URL!);
    try {
      const fingerprints = await store.listPlanFingerprints(hit.instanceId, queryid, limit ?? 20);
      const distinctShapes = new Set(fingerprints.map((f) => f.fingerprint)).size;
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({
              alias,
              instanceId: hit.instanceId,
              queryid,
              distinctShapes,
              count: fingerprints.length,
              fingerprints,
            }),
          },
        ],
      };
    } finally {
      await store.close();
    }
  },
);

server.tool(
  'buho_lock_episodes',
  'Recent lock_episodes for an alias (blocker/waiter pairs, active flag).',
  {
    alias: z.string(),
    hours: z.number().int().min(1).max(168).optional().describe('Lookback hours (default 24)'),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ alias, hours, limit }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    const p = pool();
    const lookback = hours ?? 24;
    const cap = limit ?? 40;
    try {
      const [rows, counts] = await Promise.all([
        p.query(
          `select episode_id, waiter_pid, blocker_pid, blocker_pids, lock_object, lock_mode,
                  wait_seconds, samples, first_seen_at, last_seen_at,
                  waiter_query, blocker_query,
                  last_seen_at > now() - interval '30 seconds' as active
             from buho.lock_episodes
            where instance_id = $1
              and last_seen_at > now() - make_interval(hours => $2::int)
            order by active desc, wait_seconds desc
            limit $3`,
          [hit.instanceId, lookback, cap],
        ),
        p.query<{ total: string; active: string }>(
          `select count(*)::bigint as total,
                  count(*) filter (where last_seen_at > now() - interval '30 seconds')::bigint as active
             from buho.lock_episodes
            where instance_id = $1
              and last_seen_at > now() - make_interval(hours => $2::int)`,
          [hit.instanceId, lookback],
        ),
      ]);
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({
              alias,
              instanceId: hit.instanceId,
              hours: lookback,
              total: Number(counts.rows[0]?.total ?? 0),
              active: Number(counts.rows[0]?.active ?? 0),
              episodes: rows.rows,
            }),
          },
        ],
      };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_backup_status',
  'Non-DPA backup posture for an alias: RPO exposure metric, recent jobs, artifacts, restore drills.',
  {
    alias: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ alias, limit }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    const store = new Store(STORE_URL!);
    const p = pool();
    const lim = limit ?? 10;
    try {
      const [jobs, artifacts, drills, rpo] = await Promise.all([
        store.listBackupJobs(hit.instanceId, lim),
        store.listLatestBackupArtifacts(hit.instanceId, lim),
        p.query(
          `select drill_id::text, ok, duration_ms, bytes, message, ran_at
             from buho.restore_drills
            where instance_id = $1
            order by ran_at desc
            limit $2`,
          [hit.instanceId, lim],
        ),
        p.query(
          `select value, ts
             from buho.metric_samples
            where instance_id = $1
              and metric = 'rpo_exposure_seconds'
              and ts > now() - interval '24 hours'
            order by ts desc
            limit 1`,
          [hit.instanceId],
        ),
      ]);
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({
              alias,
              engine: hit.engine,
              rpoExposureSeconds: rpo.rows[0]
                ? { value: Number(rpo.rows[0]['value']), ts: rpo.rows[0]['ts'] }
                : null,
              jobs,
              artifacts,
              restoreDrills: drills.rows,
            }),
          },
        ],
      };
    } finally {
      await store.close();
      await p.end();
    }
  },
);

server.tool(
  'buho_lineage_status',
  'DataHub / lineage sync state for an alias (or fleet-wide when alias omitted).',
  {
    alias: z.string().optional(),
  },
  async ({ alias }) => {
    const p = pool();
    try {
      const r = alias
        ? await p.query(
            `select i.alias, i.engine, l.last_ok_at, l.last_error, l.last_urn, l.updated_at
               from buho.lineage_sync_state l
               join buho.instances i using (instance_id)
              where i.alias = $1`,
            [alias],
          )
        : await p.query(
            `select i.alias, i.engine, l.last_ok_at, l.last_error, l.last_urn, l.updated_at
               from buho.lineage_sync_state l
               join buho.instances i using (instance_id)
              order by l.updated_at desc nulls last
              limit 50`,
          );
      return {
        content: [{ type: 'text' as const, text: dumps({ count: r.rows.length, lineage: r.rows }) }],
      };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_platform_instance',
  'Kafka/CDC/Airflow detail for one alias: health score + platform metrics (lag, under-replicated, DAG health, etc.).',
  {
    alias: z.string(),
    minutes: z.number().int().min(5).max(1440).optional(),
  },
  async ({ alias, minutes }) => {
    const hit = await resolveAlias(alias);
    if (!hit) {
      return { content: [{ type: 'text' as const, text: dumps({ error: 'not found', alias }) }], isError: true };
    }
    if (!['kafka', 'cdc', 'airflow'].includes(hit.engine)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({
              error: 'not a platform engine',
              alias,
              engine: hit.engine,
              hint: 'Use kafka|cdc|airflow aliases, or buho_get_metrics for SQL engines',
            }),
          },
        ],
        isError: true,
      };
    }
    const windowMin = minutes ?? 60;
    const p = pool();
    try {
      const [score, metrics, checks] = await Promise.all([
        p.query(
          `select score, critical, warning, ts
             from buho.health_scores
            where instance_id = $1
            order by ts desc
            limit 1`,
          [hit.instanceId],
        ),
        p.query(
          `select distinct on (metric) metric, value, ts
             from buho.metric_samples
            where instance_id = $1
              and ts > now() - ($2 || ' minutes')::interval
              and metric ~ '^(kafka_|cdc_|airflow_)'
            order by metric, ts desc`,
          [hit.instanceId, windowMin],
        ),
        p.query(
          `select check_id, title, severity, message, ts
             from buho.check_results
            where instance_id = $1
              and ts > now() - ($2 || ' minutes')::interval
            order by ts desc
            limit 30`,
          [hit.instanceId, windowMin],
        ),
      ]);
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({
              alias,
              engine: hit.engine,
              host: hit.host,
              port: hit.port,
              windowMinutes: windowMin,
              health: score.rows[0] ?? null,
              metrics: Object.fromEntries(
                metrics.rows.map((row) => [String(row['metric']), Number(row['value'])]),
              ),
              recentChecks: checks.rows,
            }),
          },
        ],
      };
    } finally {
      await p.end();
    }
  },
);

server.tool(
  'buho_run_compliance',
  'Run a CIS/STIG pack against an alias (WRITE). Needs BUHO_MCP_ALLOW_WRITE=true and BUHO_WEB_URL + BUHO_API_TOKEN.',
  {
    alias: z.string(),
    pack: z.enum(['cis-postgres', 'cis-mssql', 'stig-postgres']).optional(),
  },
  async ({ alias, pack }) => {
    if (!ALLOW_WRITE) {
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({ error: 'Write disabled. Set BUHO_MCP_ALLOW_WRITE=true' }),
          },
        ],
        isError: true,
      };
    }
    try {
      const result = await apiPost('/api/v1/compliance/run', { alias, pack: pack ?? 'cis-postgres' });
      return { content: [{ type: 'text' as const, text: dumps(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: dumps({ error: e instanceof Error ? e.message : String(e) }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'buho_run_action',
  'Gated mutative action (cancel_query, kill_session, pause_dag). WRITE — needs allow-write + API token + instance actions.enabled.',
  {
    kind: z.enum(['cancel_query', 'kill_session', 'pause_dag']),
    alias: z.string(),
    reason: z.string().min(3),
    pid: z.number().int().optional(),
    dagId: z.string().optional(),
  },
  async (args) => {
    if (!ALLOW_WRITE) {
      return {
        content: [
          {
            type: 'text' as const,
            text: dumps({ error: 'Write disabled. Set BUHO_MCP_ALLOW_WRITE=true' }),
          },
        ],
        isError: true,
      };
    }
    try {
      const result = await apiPost('/api/v1/actions', {
        kind: args.kind,
        alias: args.alias,
        reason: args.reason,
        pid: args.pid,
        dagId: args.dagId,
        actor: 'buho-mcp',
      });
      return { content: [{ type: 'text' as const, text: dumps(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: dumps({ error: e instanceof Error ? e.message : String(e) }) }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
