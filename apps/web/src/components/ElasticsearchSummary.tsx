import { FindingsPanel } from '@/components/FindingsPanel';
import { StatCard, toneForPct, toneForScore } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatAgo, formatBytes, formatClock, formatNumber, formatPct } from '@/lib/format';
import {
  getFindings,
  getInstance,
  getLabeled,
  getSeries,
  type ChartPoint,
  type SeriesPoint,
} from '@/lib/queries';

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
  muted: '#7a828c',
};

function ultimo(points: SeriesPoint[], metric: string): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const valor = points[index]?.[metric];
    if (typeof valor === 'number') return valor;
  }
  return null;
}

function statusLabel(code: number | null): string {
  if (code === 0) return 'green';
  if (code === 1) return 'yellow';
  if (code === 2) return 'red';
  return 'unknown';
}

function statusNoticeClass(code: number | null): string {
  if (code === 2) return 'notice notice--error';
  if (code === 1) return 'notice notice--warn';
  if (code === 0) return 'notice notice--ok';
  return 'notice';
}

function statusHint(code: number | null, unassigned: number | null): string {
  if (code === 2) {
    return 'Primaries missing or blocked — restore nodes / free disk / fix allocation.';
  }
  if (code === 1) {
    return unassigned && unassigned > 0
      ? `${formatNumber(unassigned)} unassigned shard(s) — typical on single-node with replicas>0.`
      : 'Cluster yellow — replicas not fully allocated.';
  }
  if (code === 0) return 'All primary and replica shards allocated.';
  return 'Waiting for cluster.health samples from the collector.';
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
  const [instance, findings, health, heap, search, store, shards, fsSeries, indices, nodeHeap] =
    await Promise.all([
      getInstance(instanceId),
      getFindings(instanceId),
      getSeries(
        instanceId,
        [
          'es_cluster_status',
          'es_number_of_nodes',
          'es_number_of_data_nodes',
          'es_unassigned_shards',
          'es_delayed_unassigned_shards',
          'es_active_shards_pct',
          'es_pending_tasks',
          'es_task_max_waiting_ms',
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
          'es_shards_total',
          'es_shards_primaries',
        ],
        windowMinutes,
        bucketSeconds,
      ),
      getSeries(instanceId, ['es_fs_used_pct'], windowMinutes, bucketSeconds),
      getLabeled(instanceId, 'database_size_bytes', 12, windowMinutes),
      getLabeled(instanceId, 'es_jvm_heap_used_pct', 8, 15),
    ]);

  const status = ultimo(health, 'es_cluster_status');
  const heapPct = ultimo(heap, 'es_jvm_heap_used_pct_avg');
  const unassigned = ultimo(health, 'es_unassigned_shards');
  const delayed = ultimo(health, 'es_delayed_unassigned_shards');
  const storeBytes = ultimo(store, 'es_store_bytes');
  const docs = ultimo(store, 'es_docs_count');
  const activePct = ultimo(health, 'es_active_shards_pct');
  const nodes = ultimo(health, 'es_number_of_nodes');
  const dataNodes = ultimo(health, 'es_number_of_data_nodes');
  const relocating = ultimo(shards, 'es_relocating_shards');
  const initializing = ultimo(shards, 'es_initializing_shards');
  const fsPct = ultimo(fsSeries, 'es_fs_used_pct');
  const pending = ultimo(health, 'es_pending_tasks');
  const score = instance?.score ?? null;

  const shardTone =
    (unassigned ?? 0) >= 10 || status === 2
      ? 'error'
      : (unassigned ?? 0) > 0 || (relocating ?? 0) > 0 || (initializing ?? 0) > 0
        ? 'warn'
        : 'ok';

  return (
    <div className="stack gap-4">
      <div className={statusNoticeClass(status)}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <span className="font-mono text-[11px] uppercase tracking-wide">Cluster health</span>
            <div className="mt-1 font-mono text-[22px] font-semibold uppercase leading-none">
              {statusLabel(status)}
            </div>
          </div>
          <div className="font-mono text-[11px] opacity-90">
            nodes {formatNumber(nodes)}
            {dataNodes != null ? ` · data ${formatNumber(dataNodes)}` : ''}
            {' · '}
            shards {formatNumber(ultimo(shards, 'es_active_shards'))}/
            {formatNumber(ultimo(shards, 'es_shards_total'))}
            {' · '}
            active {activePct != null ? formatPct(activePct) : '—'}
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-snug">{statusHint(status, unassigned)}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Health score"
          value={score === null ? '—' : formatNumber(score)}
          unit={score === null ? undefined : '/100'}
          tone={toneForScore(score)}
          hint={
            instance?.scoreTs
              ? `${instance.critical} crit · ${instance.warning} warn · ${formatAgo(instance.scoreTs)}`
              : 'no check runs'
          }
        />
        <StatCard
          label="Cluster"
          value={statusLabel(status)}
          tone={status === 2 ? 'error' : status === 1 ? 'warn' : status === 0 ? 'ok' : 'neutral'}
        />
        <StatCard
          label="Unassigned"
          value={formatNumber(unassigned)}
          tone={shardTone}
          hint={
            delayed && delayed > 0
              ? `delayed ${formatNumber(delayed)}`
              : relocating || initializing
                ? `reloc ${formatNumber(relocating)} · init ${formatNumber(initializing)}`
                : 'allocation clear'
          }
        />
        <StatCard
          label="JVM heap"
          value={heapPct != null ? formatPct(heapPct) : '—'}
          tone={toneForPct(heapPct, 85, 95)}
          hint={
            ultimo(heap, 'es_jvm_heap_used_bytes_total') != null
              ? formatBytes(ultimo(heap, 'es_jvm_heap_used_bytes_total'))
              : undefined
          }
        />
        <StatCard
          label="Disk (FS)"
          value={fsPct != null ? formatPct(fsPct) : '—'}
          tone={toneForPct(fsPct, 85, 95)}
          hint="data path used %"
        />
        <StatCard
          label="Store / docs"
          value={storeBytes != null ? formatBytes(storeBytes) : '—'}
          hint={`docs ${formatNumber(docs)} · idx ${formatNumber(ultimo(store, 'es_indices_count'))}`}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          label="Active shards %"
          value={activePct != null ? formatPct(activePct) : '—'}
          tone={toneForMinimumShards(activePct)}
        />
        <StatCard
          label="Primaries"
          value={formatNumber(ultimo(shards, 'es_active_primary_shards'))}
          hint={`of ${formatNumber(ultimo(shards, 'es_shards_primaries'))} declared`}
        />
        <StatCard
          label="Pending tasks"
          value={formatNumber(pending)}
          tone={pending && pending > 0 ? 'warn' : 'ok'}
          hint={
            ultimo(health, 'es_task_max_waiting_ms') != null
              ? `max wait ${formatNumber(ultimo(health, 'es_task_max_waiting_ms'))} ms`
              : undefined
          }
        />
        <StatCard
          label="OS CPU"
          value={
            ultimo(heap, 'es_os_cpu_pct_avg') != null
              ? formatPct(ultimo(heap, 'es_os_cpu_pct_avg'))
              : '—'
          }
          tone={toneForPct(ultimo(heap, 'es_os_cpu_pct_avg'), 75, 90)}
        />
      </div>

      <FindingsPanel
        findings={findings}
        checkedAt={findings[0] ? formatClock(findings[0].ts) : null}
      />

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
          title="JVM / CPU / disk"
          hint={windowHint}
          data={mergeSeries(heap, fsSeries)}
          series={[
            { metric: 'es_jvm_heap_used_pct_avg', label: 'Heap %', color: COLOR.accent },
            { metric: 'es_os_cpu_pct_avg', label: 'OS CPU %', color: COLOR.warning },
            { metric: 'es_fs_used_pct', label: 'FS used %', color: COLOR.error },
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

      {nodeHeap.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Nodes — JVM heap</span>
            <span className="font-mono text-[10px] text-foreground-muted">latest sample</span>
          </div>
          <div className="panel-body">
            <ul className="stack gap-1">
              {nodeHeap.map((row) => {
                const label = row.labels['node'] ?? JSON.stringify(row.labels);
                const pct = row.value;
                return (
                  <li key={label} className="flex justify-between gap-2 text-sm font-mono">
                    <span className="truncate">{label}</span>
                    <span
                      style={{
                        color:
                          pct >= 95 ? COLOR.error : pct >= 85 ? COLOR.warning : undefined,
                      }}
                    >
                      {formatPct(pct)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

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

function toneForMinimumShards(activePct: number | null): 'ok' | 'warn' | 'error' | 'neutral' {
  if (activePct === null) return 'neutral';
  if (activePct < 50) return 'error';
  if (activePct < 100) return 'warn';
  return 'ok';
}

/** Une dos series por bucket para un solo TimeseriesPanel (mismas ventanas). */
function mergeSeries(a: SeriesPoint[], b: SeriesPoint[]): ChartPoint[] {
  const byBucket = new Map<number, ChartPoint>();
  for (const row of a) {
    byBucket.set(row.bucket, { ...row });
  }
  for (const row of b) {
    const prev = byBucket.get(row.bucket) ?? { bucket: row.bucket };
    byBucket.set(row.bucket, { ...prev, ...row });
  }
  return [...byBucket.values()].sort((x, y) => x.bucket - y.bucket);
}
