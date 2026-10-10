import { query } from '@/lib/db';
import { getInstanceInventory } from '@/lib/estate';
import { formatAgo } from '@/lib/format';

export type ChangeKind =
  | 'collector'
  | 'settings'
  | 'jobs'
  | 'connections'
  | 'replication'
  | 'log';

export interface ChangeEvent {
  at: Date;
  kind: ChangeKind;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  title: string;
  detail: string;
  href?: string;
}

/**
 * Last 24h "what changed" for Blame / postmortems — derived from store signals
 * already collected (no new collectors).
 */
export async function getChangeTimeline(
  instanceId: number,
  hours = 24,
): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];

  const [collectorRows, connSpike, inventory, logRows] = await Promise.all([
    query<{ ts: Date; level: string; component: string; message: string }>(
      `select ts, level, component, message
         from buho.collector_events
        where instance_id = $1
          and ts > now() - ($2 || ' hours')::interval
        order by ts desc
        limit 40`,
      [instanceId, hours],
    ).catch(() => [] as { ts: Date; level: string; component: string; message: string }[]),
    query<{ ts: Date; value: number }>(
      `select date_trunc('hour', ts) as ts, max(value) as value
         from buho.metric_samples
        where instance_id = $1
          and metric in ('db_connections_used_pct', 'connections_used_pct', 'pg_connections_used_pct')
          and ts > now() - ($2 || ' hours')::interval
        group by 1
        having max(value) >= 75
        order by 1 desc
        limit 12`,
      [instanceId, hours],
    ).catch(() => [] as { ts: Date; value: number }[]),
    getInstanceInventory(instanceId).catch(() => null),
    query<{ ts: Date; kind: string; message: string }>(
      `select ts, kind, left(coalesce(message, ''), 160) as message
         from buho.log_events
        where instance_id = $1
          and ts > now() - ($2 || ' hours')::interval
          and kind in ('error', 'fatal', 'deadlock', 'connection')
        order by ts desc
        limit 20`,
      [instanceId, hours],
    ).catch(() => [] as { ts: Date; kind: string; message: string }[]),
  ]);

  for (const row of collectorRows) {
    events.push({
      at: new Date(row.ts),
      kind: 'collector',
      tone: row.level === 'error' ? 'error' : row.level === 'warn' ? 'warn' : 'neutral',
      title: `${row.component}: ${row.message.slice(0, 90)}`,
      detail: formatAgo(new Date(row.ts)),
      href: `/events`,
    });
  }

  for (const row of connSpike) {
    events.push({
      at: new Date(row.ts),
      kind: 'connections',
      tone: row.value >= 90 ? 'error' : 'warn',
      title: `Connection pressure peaked at ${row.value.toFixed(0)}%`,
      detail: 'Hourly max of connection-used %',
      href: `/instances/${instanceId}/sessions`,
    });
  }

  if (inventory) {
    for (const n of inventory.notes.filter((x) => x.domain === 'settings' && x.level !== 'info')) {
      events.push({
        at: new Date(),
        kind: 'settings',
        tone: n.level === 'error' ? 'error' : 'warn',
        title: n.message.slice(0, 100),
        detail: 'Pending / mismatched settings (inventory)',
        href: `/instances/${instanceId}/inventory`,
      });
    }
    for (const j of inventory.jobs.filter(
      (x) => x.lastStatus === 'failed' || x.lastStatus === 'falló',
    )) {
      events.push({
        at: j.lastRunAt ?? new Date(),
        kind: 'jobs',
        tone: 'error',
        title: `Job failed: ${j.name}`,
        detail: j.lastRunAt ? `Last run ${formatAgo(j.lastRunAt)}` : 'Last run unknown',
        href: `/instances/${instanceId}/inventory`,
      });
    }
    for (const r of inventory.replication) {
      if (r.lagSeconds != null && r.lagSeconds >= 30) {
        events.push({
          at: new Date(),
          kind: 'replication',
          tone: r.lagSeconds >= 60 ? 'error' : 'warn',
          title: `Replication lag ${Math.round(r.lagSeconds)}s · ${r.peer ?? r.role}`,
          detail: r.state ?? 'replication',
          href: `/instances/${instanceId}/replication`,
        });
      }
    }
  }

  for (const row of logRows) {
    events.push({
      at: new Date(row.ts),
      kind: 'log',
      tone: row.kind === 'fatal' || row.kind === 'deadlock' ? 'error' : 'warn',
      title: `Log ${row.kind}: ${row.message || '(no message)'}`,
      detail: formatAgo(new Date(row.ts)),
      href: `/instances/${instanceId}/logs`,
    });
  }

  // Deduplicate near-identical titles, keep newest first.
  const seen = new Set<string>();
  return events
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .filter((e) => {
      const key = `${e.kind}:${e.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30);
}
