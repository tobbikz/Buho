/**
 * Airflow REST handle for Búho (fetch). Supports API v2 with v1 fallback.
 * Optional metadata Postgres for Superset Airflow Monitor–parity KPIs.
 */
import { Client } from 'pg';
import type { InstanceConfig } from '../types';

export interface AirflowHandle {
  command(cmd: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function baseUrlOf(instance: InstanceConfig): string {
  if (instance.airflow?.baseUrl) return instance.airflow.baseUrl.replace(/\/$/, '');
  const proto = instance.ssl ? 'https' : 'http';
  return `${proto}://${instance.host}:${instance.port || 8080}`;
}

export function createAirflowHandle(
  instance: InstanceConfig,
  connectTimeoutMs: number,
): AirflowHandle {
  const base = baseUrlOf(instance);
  const user = instance.airflow?.username ?? instance.user;
  const pass = instance.airflow?.password ?? instance.password ?? '';
  const authHeader =
    user && pass
      ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      : undefined;
  const preferV2 = (instance.airflow?.apiVersion ?? 'v2') === 'v2';
  const meta = instance.airflow?.metadata;
  let metaClient: Client | null = null;

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const ctrl = AbortSignal.timeout(connectTimeoutMs);
    const res = await fetch(`${base}${path}`, {
      signal: ctrl,
      headers: {
        Accept: 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  }

  async function tryPaths(paths: string[]): Promise<Record<string, unknown>> {
    let last: { status: number; body: unknown } | null = null;
    for (const p of paths) {
      const r = await getJson(p);
      last = r;
      if (r.status >= 200 && r.status < 300) {
        return typeof r.body === 'object' && r.body !== null
          ? (r.body as Record<string, unknown>)
          : { raw: r.body };
      }
    }
    throw new Error(
      `Airflow HTTP ${last?.status ?? '?'} for ${paths.join(' | ')}: ${JSON.stringify(last?.body).slice(0, 300)}`,
    );
  }

  async function withMeta<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    if (!meta) throw new Error('airflow.metadata is not configured');
    if (!metaClient) {
      metaClient = new Client({
        host: meta.host,
        port: meta.port ?? 5432,
        database: meta.database,
        user: meta.user,
        password: meta.password,
        ssl: meta.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: connectTimeoutMs,
        statement_timeout: connectTimeoutMs,
      });
      await metaClient.connect();
    }
    return fn(metaClient);
  }

  async function metaKpis(): Promise<Record<string, unknown>> {
    return withMeta(async (client) => {
      const [runs, tasks, dags, pools, imports] = await Promise.all([
        client.query<{ failed_24h: string; running: string; queued: string; open: string }>(`
          select
            count(*) filter (where state = 'failed' and start_date > now() - interval '24 hours')::text as failed_24h,
            count(*) filter (where state = 'running')::text as running,
            count(*) filter (where state = 'queued')::text as queued,
            count(*) filter (where state in ('running', 'queued'))::text as open
          from dag_run
        `),
        client.query<{ failed_24h: string }>(`
          select count(*)::text as failed_24h
            from task_instance
           where state = 'failed'
             and start_date > now() - interval '24 hours'
        `),
        client.query<{ total: string; active: string; paused: string; stale: string }>(`
          select
            count(*)::text as total,
            count(*) filter (where not is_paused and is_active)::text as active,
            count(*) filter (where is_paused)::text as paused,
            count(*) filter (where not is_active)::text as stale
          from dag
        `),
        client.query<{ name: string; slots: string; occupied: string }>(`
          select pool as name, slots::text, occupied_slots::text as occupied
            from slot_pool
           order by pool
        `).catch(() => ({ rows: [] as { name: string; slots: string; occupied: string }[] })),
        client.query<{ n: string }>(`select count(*)::text as n from import_error`).catch(() => ({
          rows: [{ n: '0' }],
        })),
      ]);

      const r = runs.rows[0] ?? { failed_24h: '0', running: '0', queued: '0', open: '0' };
      const t = tasks.rows[0] ?? { failed_24h: '0' };
      const d = dags.rows[0] ?? { total: '0', active: '0', paused: '0', stale: '0' };
      return {
        linked: true,
        failed_runs_24h: Number(r.failed_24h),
        running_runs: Number(r.running),
        queued_runs: Number(r.queued),
        open_runs: Number(r.open),
        failed_tasks_24h: Number(t.failed_24h),
        dags_total: Number(d.total),
        dags_active: Number(d.active),
        dags_paused: Number(d.paused),
        dags_stale: Number(d.stale),
        import_errors: Number(imports.rows[0]?.n ?? 0),
        pools: pools.rows.map((p) => ({
          name: p.name,
          slots: Number(p.slots),
          occupied: Number(p.occupied),
        })),
      };
    });
  }

  return {
    async command(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
      const op = String(cmd['airflow'] ?? cmd['op'] ?? '');
      if (op === 'version' || op === 'health') {
        const paths = preferV2
          ? ['/api/v2/monitor/health', '/api/v1/health', '/health']
          : ['/api/v1/health', '/api/v2/monitor/health', '/health'];
        try {
          const body = await tryPaths(paths);
          return { ok: true, ...body };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (op === 'dags') {
        const limit = Number(cmd['limit'] ?? 100);
        const paths = preferV2
          ? [`/api/v2/dags?limit=${limit}`, `/api/v1/dags?limit=${limit}`]
          : [`/api/v1/dags?limit=${limit}`, `/api/v2/dags?limit=${limit}`];
        return tryPaths(paths);
      }
      if (op === 'importErrors') {
        const paths = preferV2
          ? ['/api/v2/importErrors', '/api/v1/importErrors']
          : ['/api/v1/importErrors', '/api/v2/importErrors'];
        try {
          return await tryPaths(paths);
        } catch {
          return { import_errors: [], note: 'importErrors endpoint unavailable' };
        }
      }
      if (op === 'pools') {
        const paths = preferV2
          ? ['/api/v2/pools', '/api/v1/pools']
          : ['/api/v1/pools', '/api/v2/pools'];
        try {
          return await tryPaths(paths);
        } catch {
          return { pools: [], note: 'pools endpoint unavailable' };
        }
      }
      if (op === 'dagRuns') {
        const dagId = String(cmd['dagId'] ?? '~');
        const limit = Number(cmd['limit'] ?? 50);
        const state = cmd['state'] ? String(cmd['state']) : '';
        const qs = new URLSearchParams({ limit: String(limit), order_by: '-start_date' });
        if (state) qs.set('state', state);
        const enc = encodeURIComponent(dagId);
        const paths = [
          `/api/v2/dags/${enc}/dagRuns?${qs}`,
          `/api/v1/dags/${enc}/dagRuns?${qs}`,
        ];
        try {
          return await tryPaths(paths);
        } catch (err) {
          if (dagId === '~') {
            return {
              dag_runs: [],
              note: err instanceof Error ? err.message : String(err),
            };
          }
          throw err;
        }
      }
      if (op === 'metaKpis') {
        if (!meta) return { linked: false };
        try {
          return await metaKpis();
        } catch (err) {
          return {
            linked: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (op === 'snapshot') {
        const [health, dags, importErrors, pools, dagRuns, metaKpi] = await Promise.all([
          this.command({ airflow: 'health' }),
          this.command({ airflow: 'dags', limit: 100 }),
          this.command({ airflow: 'importErrors' }),
          this.command({ airflow: 'pools' }),
          this.command({ airflow: 'dagRuns', dagId: '~', limit: 50 }),
          this.command({ airflow: 'metaKpis' }),
        ]);
        return { health, dags, importErrors, pools, dagRuns, meta: metaKpi, baseUrl: base };
      }
      if (op === 'pauseDag' || op === 'unpauseDag') {
        const dagId = String(cmd['dagId'] ?? '');
        if (!dagId) throw new Error('pauseDag requires dagId');
        const isPaused = op === 'pauseDag';
        const ctrl = AbortSignal.timeout(connectTimeoutMs);
        const pathV2 = `/api/v2/dags/${encodeURIComponent(dagId)}`;
        const pathV1 = `/api/v1/dags/${encodeURIComponent(dagId)}`;
        for (const path of [pathV2, pathV1]) {
          const res = await fetch(`${base}${path}`, {
            method: 'PATCH',
            signal: ctrl,
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify({ is_paused: isPaused }),
          });
          if (res.ok) {
            return { ok: true, dagId, is_paused: isPaused };
          }
        }
        throw new Error(`Failed to ${op} ${dagId}`);
      }
      throw new Error(`Unknown Airflow command: ${op}`);
    },
    async close() {
      if (metaClient) {
        try {
          await metaClient.end();
        } catch {
          /* ignore */
        }
        metaClient = null;
      }
    },
  };
}
