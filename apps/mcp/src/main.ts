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
