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

export async function OracleSummary({
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
  const [connections, activity, memory, cache, waits, sizes] = await Promise.all([
    getSeries(
      instanceId,
      ['connections_total', 'connections_active', 'connections_used_pct', 'blocked_sessions'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      [
        'oracle_execute_count_per_sec',
        'oracle_user_commits_per_sec',
        'oracle_parse_count_per_sec',
        'oracle_physical_reads_per_sec',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['oracle_sga_bytes', 'oracle_pga_bytes', 'oracle_pga_used_pct'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['db_cache_hit_pct'], windowMinutes, bucketSeconds),
    getLabeled(instanceId, 'wait_event_sessions', 12, windowMinutes),
    getLabeled(instanceId, 'database_size_bytes', 12, windowMinutes),
  ]);

  const connPct = ultimo(connections, 'connections_used_pct');
  const hitPct = ultimo(cache, 'db_cache_hit_pct');
  const blocked = ultimo(connections, 'blocked_sessions');
  const sga = ultimo(memory, 'oracle_sga_bytes');
  const pga = ultimo(memory, 'oracle_pga_bytes');

  return (
    <div className="stack gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Sessions"
          value={formatNumber(ultimo(connections, 'connections_total'))}
          hint={connPct != null ? `${formatPct(connPct)} of max` : undefined}
          tone={toneForPct(connPct, 80, 95)}
        />
        <StatCard label="Active" value={formatNumber(ultimo(connections, 'connections_active'))} />
        <StatCard
          label="Blocked"
          value={formatNumber(blocked)}
          tone={blocked && blocked > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Buffer hit"
          value={hitPct != null ? formatPct(hitPct) : '—'}
          tone={toneForMinimum(hitPct, 95, 90)}
        />
        <StatCard label="SGA" value={sga != null ? formatBytes(sga) : '—'} />
        <StatCard label="PGA" value={pga != null ? formatBytes(pga) : '—'} />
      </div>

      <TimeseriesPanel
        title="Sessions"
        hint={windowHint}
        data={connections}
        series={[
          { metric: 'connections_total', label: 'Total', color: COLOR.accent },
          { metric: 'connections_active', label: 'Active', color: COLOR.success },
          { metric: 'blocked_sessions', label: 'Blocked', color: COLOR.error },
        ]}
      />
      <TimeseriesPanel
        title="Activity"
        hint={windowHint}
        data={activity}
        series={[
          { metric: 'oracle_execute_count_per_sec', label: 'Executes/s', color: COLOR.accent },
          { metric: 'oracle_user_commits_per_sec', label: 'Commits/s', color: COLOR.success },
          { metric: 'oracle_parse_count_per_sec', label: 'Parses/s', color: COLOR.warning },
          { metric: 'oracle_physical_reads_per_sec', label: 'Phys reads/s', color: COLOR.muted },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesPanel
          title="Memory"
          hint={windowHint}
          data={memory}
          series={[
            { metric: 'oracle_sga_bytes', label: 'SGA', color: COLOR.accent },
            { metric: 'oracle_pga_bytes', label: 'PGA', color: COLOR.success },
          ]}
        />
        <div className="card">
          <h3 className="card-title">Current waits</h3>
          <p className="page-sub text-xs mb-2">{windowHint}</p>
          {waits.length === 0 ? (
            <p className="text-sm text-foreground-muted">No active waits sampled.</p>
          ) : (
            <ul className="stack gap-1">
              {waits.slice(0, 10).map((row) => {
                const label =
                  row.labels['wait_event'] ??
                  row.labels['wait_event_type'] ??
                  JSON.stringify(row.labels);
                return (
                  <li key={label} className="flex justify-between gap-2 text-sm font-mono">
                    <span className="truncate">{label}</span>
                    <span>{formatNumber(row.value)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="card">
        <h3 className="card-title">Tablespaces</h3>
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
