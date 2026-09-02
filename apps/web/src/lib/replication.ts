import { query } from './db';

export interface InstanceReplicationRow {
  role: string;
  peer: string;
  state: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  detail: Record<string, unknown>;
  capturedAt: Date;
}

/**
 * Estado de replicación de una instancia.
 *
 * A diferencia de la vista de parque, acá no se deduplica por servidor: se está
 * mirando una instancia concreta y sus pares, y esconder una fila porque otra
 * instancia del mismo host ya la reportó dejaría la pantalla incompleta.
 */
export async function getInstanceReplication(instanceId: number): Promise<InstanceReplicationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select role, peer, state, lag_bytes, lag_seconds, detail, captured_at
       from buho.replication_state
      where instance_id = $1
      order by case role
                 when 'primary' then 0
                 when 'standby' then 1
                 when 'replica' then 2
                 else 3
               end,
               peer`,
    [instanceId],
  );

  return rows.map((row) => ({
    role: String(row['role'] ?? ''),
    peer: String(row['peer'] ?? ''),
    state: (row['state'] as string | null) ?? null,
    lagBytes: row['lag_bytes'] === null ? null : Number(row['lag_bytes']),
    lagSeconds: row['lag_seconds'] === null ? null : Number(row['lag_seconds']),
    detail: (row['detail'] as Record<string, unknown>) ?? {},
    capturedAt: row['captured_at'] as Date,
  }));
}

export function replicationRowKey(instanceId: number, role: string, peer: string): string {
  return `${instanceId}:${role}:${peer}`;
}

interface LagTrendTarget {
  instanceId: number;
  role: string;
  peer: string;
  detail: Record<string, unknown>;
}

/**
 * Sparkline data for replication lag (replay delay in seconds).
 * Primary standbys use `replication_replay_lag_seconds` (labeled by application).
 * Standby instances use `standby_pending_bytes` (not replay delay — idle DBs lie).
 */
export async function getReplicationLagTrends(
  rows: LagTrendTarget[],
  windowMinutes = 1440,
  bucketSeconds = 300,
): Promise<Record<string, number[]>> {
  const instanceIds = [...new Set(rows.map((row) => row.instanceId))];
  if (instanceIds.length === 0) return {};

  const relation = windowMinutes > 1440 ? 'buho.metric_rollup_1h' : 'buho.metric_rollup_5m';
  const samples = await query<Record<string, unknown>>(
    `select instance_id,
            metric,
            labels,
            date_bin(make_interval(secs => $3::int), bucket, timestamptz 'epoch') as bucket,
            avg(avg_value) as value
       from ${relation}
      where instance_id = any($1::bigint[])
        and metric in (
          'replication_replay_lag_seconds',
          'standby_replay_delay_seconds',
          'standby_pending_bytes'
        )
        and bucket > now() - make_interval(mins => $2::int)
      group by 1, 2, 3, 4
      order by 4`,
    [instanceIds, windowMinutes, bucketSeconds],
  );

  type SeriesKey = string;
  const series = new Map<SeriesKey, { bucket: number; value: number }[]>();

  for (const row of samples) {
    const instanceId = Number(row['instance_id']);
    const metric = String(row['metric']);
    const labels = (row['labels'] as Record<string, string>) ?? {};
    const label =
      metric === 'standby_replay_delay_seconds'
        ? ''
        : (labels['standby'] ?? labels['replica'] ?? '');
    const key = `${instanceId}:${metric}:${label}`;
    const bucket = (row['bucket'] as Date).getTime();
    const value = Number(row['value']);
    if (!Number.isFinite(value)) continue;
    const points = series.get(key) ?? [];
    points.push({ bucket, value });
    series.set(key, points);
  }

  const out: Record<string, number[]> = {};
  for (const row of rows) {
    const key = replicationRowKey(row.instanceId, row.role, row.peer);
    if (row.role === 'slot' || row.role === 'primary') {
      out[key] = [];
      continue;
    }

    if (row.role === 'upstream' || row.role === 'replica') {
      const points = series.get(`${row.instanceId}:standby_pending_bytes:`) ?? [];
      out[key] = points.sort((a, b) => a.bucket - b.bucket).map((point) => point.value);
      continue;
    }

    const application = typeof row.detail['application'] === 'string' ? row.detail['application'] : '';
    let points = series.get(`${row.instanceId}:replication_replay_lag_seconds:${application}`);
    if (!points) {
      const prefix = `${row.instanceId}:replication_replay_lag_seconds:`;
      const matches = [...series.entries()].filter(([seriesKey]) => seriesKey.startsWith(prefix));
      if (matches.length === 1) points = matches[0]![1];
    }
    out[key] = (points ?? []).sort((a, b) => a.bucket - b.bucket).map((point) => point.value);
  }

  return out;
}
