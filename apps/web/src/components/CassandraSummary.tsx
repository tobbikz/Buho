import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatNumber, formatPct } from '@/lib/format';
import { getLabeled, getSeries } from '@/lib/queries';

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
  muted: '#7a828c',
};

function ultimo(points: Array<Record<string, number | null>>, metric: string): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const valor = points[index]?.[metric];
    if (valor !== null && valor !== undefined) return valor;
  }
  return null;
}

export async function CassandraSummary({
  instanceId,
  windowMinutes,
  bucketSeconds,
  windowHint,
}: {
  instanceId: number;
  windowMinutes: number;
  bucketSeconds: number;
  windowHint: string;
}) {
  const [clients, pools, cache, cluster, compaction, sizes] = await Promise.all([
    getSeries(
      instanceId,
      ['connections_total', 'connections_active', 'cassandra_clients'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['cassandra_pools_active', 'cassandra_pools_pending', 'blocked_sessions'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['db_cache_hit_pct', 'cassandra_cache_hit_pct'], windowMinutes, bucketSeconds),
    getSeries(
      instanceId,
      ['cassandra_peer_count', 'cassandra_cluster_nodes', 'cassandra_bootstrapped'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['cassandra_sstable_tasks'], windowMinutes, bucketSeconds),
    getLabeled(instanceId, 'cassandra_keyspace_bytes', 12, windowMinutes),
  ]);

  const hitPct = ultimo(cache, 'db_cache_hit_pct');
  const blocked = ultimo(pools, 'blocked_sessions');
  const nodes = ultimo(cluster, 'cassandra_cluster_nodes');
  const tasks = ultimo(compaction, 'cassandra_sstable_tasks');

  return (
    <div className="stack gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Clients"
          value={formatNumber(ultimo(clients, 'connections_total'))}
        />
        <StatCard
          label="Pool active"
          value={formatNumber(ultimo(pools, 'cassandra_pools_active'))}
          hint={`pending ${formatNumber(ultimo(pools, 'cassandra_pools_pending'))}`}
        />
        <StatCard
          label="Blocked pools"
          value={formatNumber(blocked)}
          tone={blocked && blocked > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Key cache hit"
          value={hitPct != null ? formatPct(hitPct) : '—'}
          tone={toneForMinimum(hitPct, 90, 80)}
        />
        <StatCard label="Nodes" value={formatNumber(nodes)} />
        <StatCard
          label="SSTable tasks"
          value={formatNumber(tasks)}
          tone={toneForPct(tasks != null && tasks > 0 ? Math.min(tasks * 5, 100) : 0, 40, 80)}
        />
      </div>

      <TimeseriesPanel
        title="Clients"
        hint={windowHint}
        data={clients}
        series={[
          { metric: 'connections_total', label: 'Native clients', color: COLOR.accent },
          { metric: 'cassandra_clients', label: 'Clients (gauge)', color: COLOR.success },
        ]}
      />
      <TimeseriesPanel
        title="Thread pools"
        hint={windowHint}
        data={pools}
        series={[
          { metric: 'cassandra_pools_active', label: 'Active', color: COLOR.accent },
          { metric: 'cassandra_pools_pending', label: 'Pending', color: COLOR.warning },
          { metric: 'blocked_sessions', label: 'Blocked', color: COLOR.error },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesPanel
          title="Cluster"
          hint={windowHint}
          data={cluster}
          series={[
            { metric: 'cassandra_cluster_nodes', label: 'Nodes', color: COLOR.accent },
            { metric: 'cassandra_peer_count', label: 'Peers', color: COLOR.success },
            { metric: 'cassandra_bootstrapped', label: 'Bootstrapped', color: COLOR.muted },
          ]}
        />
        <TimeseriesPanel
          title="Compaction"
          hint={windowHint}
          data={compaction}
          series={[{ metric: 'cassandra_sstable_tasks', label: 'SSTable tasks', color: COLOR.warning }]}
        />
      </div>
      <div className="card">
        <h3 className="card-title">Keyspace disk</h3>
        {sizes.length === 0 ? (
          <p className="text-sm text-foreground-muted">No size samples yet.</p>
        ) : (
          <ul className="stack gap-1">
            {sizes.slice(0, 12).map((row) => {
              const label = row.labels['database'] ?? JSON.stringify(row.labels);
              return (
                <li key={label} className="flex justify-between gap-2 text-sm font-mono">
                  <span className="truncate">{label}</span>
                  <span>{formatBytes(row.value)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
