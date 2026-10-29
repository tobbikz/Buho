/**
 * Airflow REST handle for Búho (fetch). Supports API v2 with v1 fallback.
 */
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
        const body = await tryPaths(paths);
        return body;
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
        const dagId = String(cmd['dagId'] ?? '');
        if (!dagId) throw new Error('dagRuns requires dagId');
        const limit = Number(cmd['limit'] ?? 25);
        const paths = [
          `/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns?limit=${limit}`,
          `/api/v1/dags/${encodeURIComponent(dagId)}/dagRuns?limit=${limit}`,
        ];
        return tryPaths(paths);
      }
      if (op === 'snapshot') {
        const [health, dags, importErrors, pools] = await Promise.all([
          this.command({ airflow: 'health' }),
          this.command({ airflow: 'dags', limit: 100 }),
          this.command({ airflow: 'importErrors' }),
          this.command({ airflow: 'pools' }),
        ]);
        return { health, dags, importErrors, pools, baseUrl: base };
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
      throw new Error(`comando Airflow desconocido: ${op}`);
    },
    async close() {
      /* stateless fetch */
    },
  };
}
