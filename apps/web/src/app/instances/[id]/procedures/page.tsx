import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { LabeledBars, type BarRow } from '@/components/LabeledBars';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatDuration, formatNumber } from '@/lib/format';
import { ENGINE_LABEL, getInstanceEngine } from '@/lib/estate';
import { getSlowProcedureEvents, getTopProcedures } from '@/lib/procedures';
import { getInstance, getSeriesByLabel } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
] as const;

const COLOR = ['#005eb8', '#0a6e42', '#9a4a00', '#b01818', '#7a828c'];

/**
 * Stored procedures — intent del zip Superset (Top SP, avg duration, slow events).
 * Fuente: dm_exec_procedure_stats (+ umbral last_elapsed ≥ 1s como “slow SP”).
 */
export default async function ProceduresPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { id } = await params;
  const { w } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  if (engine !== 'mssql') notFound();

  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1]!;

  let instance;
  let top;
  let slow;
  let durationSeries: Awaited<ReturnType<typeof getSeriesByLabel>> = { keys: [], points: [] };
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();
    [top, slow] = await Promise.all([
      getTopProcedures(instanceId, window.minutes, 25),
      getSlowProcedureEvents(instanceId, window.minutes, 40),
    ]);
    try {
      durationSeries = await getSeriesByLabel(
        instanceId,
        'rg_pool_active_requests',
        'resource_pool',
        window.minutes,
        window.bucketSeconds,
        5,
      );
    } catch {
      durationSeries = { keys: [], points: [] };
    }
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const totalCalls = top.reduce((sum, row) => sum + row.calls, 0);
  const totalMs = top.reduce((sum, row) => sum + row.execMs, 0);
  const bars: BarRow[] = top.slice(0, 12).map((row) => ({
    label: `${row.schema}.${row.name}`,
    sub: row.database,
    value: row.execMs,
    display: `${formatNumber(row.execMs / 1000, 2)} s`,
  }));

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Procedures' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Stored procedures</h1>
            <p className="page-sub">
              {ENGINE_LABEL[engine]} · dm_exec_procedure_stats · last {window.key}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((candidate) => (
              <Link
                key={candidate.key}
                href={`/instances/${instanceId}/procedures?w=${candidate.key}`}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </Link>
            ))}
          </div>
        </header>
        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard label="SPs with activity" value={formatNumber(top.length)} />
          <StatCard label="Executions" value={formatNumber(totalCalls)} hint={`in ${window.key}`} />
          <StatCard label="Total time" value={formatDuration(totalMs / 1000)} />
          <StatCard
            label="Slow events"
            value={formatNumber(slow.length)}
            tone={slow.length > 0 ? 'warn' : 'ok'}
            hint="last elapsed ≥ 1s"
          />
        </div>

        <div className="chart-grid chart-grid--2">
          <LabeledBars
            title="Top SPs by elapsed time"
            rows={bars}
            emptyMessage="No procedure activity yet — call SPs or wait for the collector cycle."
            footer="delta of dm_exec_procedure_stats"
          />
          <TimeseriesPanel
            title="Resource pool activity"
            hint={`${window.key} · dm_resource_governor_resource_pools`}
            data={durationSeries.points}
            unit="count"
            series={durationSeries.keys.map((key, index) => ({
              metric: key,
              label: key,
              color: COLOR[index % COLOR.length]!,
            }))}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Top procedures</span>
          </div>
          {top.length === 0 ? (
            <div className="panel-body empty">No procedure deltas in this window.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Procedure</th>
                  <th>Database</th>
                  <th className="text-right">Calls</th>
                  <th className="text-right">Elapsed</th>
                  <th className="text-right">CPU</th>
                  <th className="text-right">Avg dur</th>
                  <th className="text-right">Logical reads</th>
                </tr>
              </thead>
              <tbody>
                {top.map((row) => (
                  <tr key={row.objectId}>
                    <td className="font-mono text-[11px]">
                      {row.schema}.{row.name}
                    </td>
                    <td className="font-mono text-[11px] text-foreground-muted">{row.database}</td>
                    <td className="num">{formatNumber(row.calls)}</td>
                    <td className="num">{formatDuration(row.execMs / 1000)}</td>
                    <td className="num">{formatDuration(row.workerMs / 1000)}</td>
                    <td className="num">
                      {row.avgDurationSec === null ? '—' : `${formatNumber(row.avgDurationSec, 3)} s`}
                    </td>
                    <td className="num">{formatNumber(row.logicalReads)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Slow SP events</span>
            <span className="tag tag--muted">last_elapsed ≥ 1s</span>
          </div>
          {slow.length === 0 ? (
            <div className="panel-body empty">No slow procedure completions captured.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Procedure</th>
                  <th>Database</th>
                  <th className="text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {slow.map((row, index) => (
                  <tr key={`${row.ts.getTime()}-${row.objectId}-${index}`}>
                    <td className="font-mono text-[11px] text-foreground-muted">{formatAgo(row.ts)}</td>
                    <td className="font-mono text-[11px]">
                      {row.schema ? `${row.schema}.` : ''}
                      {row.name}
                    </td>
                    <td className="font-mono text-[11px] text-foreground-muted">{row.database ?? '—'}</td>
                    <td className="num">{formatNumber(row.durationSec, 3)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
