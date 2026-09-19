import { StatCard, toneForPct } from '@/components/StatCard';
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

function statusLabel(code: number | null): string {
  if (code === 0) return 'green';
  if (code === 1) return 'yellow';
  if (code === 2) return 'red';
  return '—';
}

export async function ElasticsearchSummary({
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
  const [health, heap, search, store, shards, indices] = await Promise.all([
    getSeries(
      instanceId,
      [
        'es_cluster_status',
        'es_number_of_nodes',
        'es_unassigned_shards',
        'es_active_shards_pct',
        'es_pending_tasks',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['es_jvm_heap_used_pct_avg', 'es_jvm_heap_used_bytes_total', 'es_os_cpu_pct_avg'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['es_search_query_total_per_sec', 'es_indexing_index_total_per_sec', 'connections_total'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['es_store_bytes', 'es_docs_count', 'es_indices_count'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      [
        'es_active_shards',
        'es_active_primary_shards',
        'es_relocating_shards',
        'es_initializing_shards',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getLabeled(instanceId, 'database_size_bytes', 12, windowMinutes),
  ]);

  const status = ultimo(health, 'es_cluster_status');
  const heapPct = ultimo(heap, 'es_jvm_heap_used_pct_avg');
  const unassigned = ultimo(health, 'es_unassigned_shards');
  const storeBytes = ultimo(store, 'es_store_bytes');
  const docs = ultimo(store, 'es_docs_count');

  return (
    <div className="stack gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Cluster"
          value={statusLabel(status)}
          tone={status === 2 ? 'error' : status === 1 ? 'warn' : 'ok'}
        />
        <StatCard label="Nodes" value={formatNumber(ultimo(health, 'es_number_of_nodes'))} />
        <StatCard
          label="Unassigned"
          value={formatNumber(unassigned)}
          tone={unassigned && unassigned > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="JVM heap"
          value={heapPct != null ? formatPct(heapPct) : '—'}
          tone={toneForPct(heapPct, 85, 95)}
        />
        <StatCard label="Store" value={storeBytes != null ? formatBytes(storeBytes) : '—'} />
        <StatCard
          label="Docs"
          value={formatNumber(docs)}
          hint={`indices ${formatNumber(ultimo(store, 'es_indices_count'))}`}
        />
      </div>

      <TimeseriesPanel
        title="Cluster health"
        hint={windowHint}
        data={health}
        series={[
          { metric: 'es_cluster_status', label: 'Status (0=g/1=y/2=r)', color: COLOR.accent },
          { metric: 'es_unassigned_shards', label: 'Unassigned', color: COLOR.error },
          { metric: 'es_active_shards_pct', label: 'Active %', color: COLOR.success },
          { metric: 'es_pending_tasks', label: 'Pending tasks', color: COLOR.warning },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesPanel
          title="JVM / CPU"
          hint={windowHint}
          data={heap}
          series={[
            { metric: 'es_jvm_heap_used_pct_avg', label: 'Heap %', color: COLOR.accent },
            { metric: 'es_os_cpu_pct_avg', label: 'OS CPU %', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Search / index"
          hint={windowHint}
          data={search}
          series={[
            { metric: 'es_search_query_total_per_sec', label: 'Search/s', color: COLOR.accent },
            { metric: 'es_indexing_index_total_per_sec', label: 'Index/s', color: COLOR.success },
            { metric: 'connections_total', label: 'HTTP open', color: COLOR.muted },
          ]}
        />
      </div>
      <TimeseriesPanel
        title="Shards"
        hint={windowHint}
        data={shards}
        series={[
          { metric: 'es_active_shards', label: 'Active', color: COLOR.accent },
          { metric: 'es_active_primary_shards', label: 'Primaries', color: COLOR.success },
          { metric: 'es_relocating_shards', label: 'Relocating', color: COLOR.warning },
          { metric: 'es_initializing_shards', label: 'Initializing', color: COLOR.muted },
        ]}
      />
      <div className="card">
        <h3 className="card-title">Index store size</h3>
        {indices.length === 0 ? (
          <p className="text-sm text-foreground-muted">No size samples yet.</p>
        ) : (
          <ul className="stack gap-1">
            {indices.slice(0, 12).map((row) => {
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
