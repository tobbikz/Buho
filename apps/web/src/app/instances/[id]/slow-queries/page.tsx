import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { LabeledBars, type BarRow } from '@/components/LabeledBars';
import { SlowEventsTable } from '@/components/SlowEventsTable';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatDuration, formatNumber } from '@/lib/format';
import { ENGINE_LABEL, getInstanceEngine } from '@/lib/estate';
import { getInstance, getSeries } from '@/lib/queries';
import { getSlowStatementAggs, getSlowStatementEvents } from '@/lib/slow-queries';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
] as const;

const SOURCE_LABEL: Record<string, string> = {
  digest: 'digest',
  slow_log: 'slow_log',
  processlist: 'processlist',
  slowlog: 'slowlog',
};

/**
 * Slow queries — MariaDB / Redis / Oracle (≥1s events).
 * Maria: digests / slow_log / PROCESSLIST · Redis: SLOWLOG · Oracle: v$sql avg ≥1s.
 */
export default async function SlowQueriesPage({
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
  if (engine !== 'mariadb' && engine !== 'redis' && engine !== 'oracle') notFound();

  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1]!;

  let instance;
  let top;
  let events;
  let series: Awaited<ReturnType<typeof getSeries>> = [];
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();
    [top, events, series] = await Promise.all([
      getSlowStatementAggs(instanceId, window.minutes, 25),
      getSlowStatementEvents(instanceId, window.minutes, 50),
      getSeries(
        instanceId,
        ['slow_queries_per_sec', 'slow_digest_count'],
        window.minutes,
        window.bucketSeconds,
      ),
    ]);
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

  const bars: BarRow[] = top.slice(0, 12).map((row) => ({
    label: row.query.slice(0, 72) + (row.query.length > 72 ? '…' : ''),
    sub: [row.database, row.sources.map((s) => SOURCE_LABEL[s] ?? s).join('+')]
      .filter(Boolean)
      .join(' · '),
    value: row.maxDurationSec,
    display: `${formatNumber(row.maxDurationSec, 2)} s`,
  }));

  const bySource = events.reduce<Record<string, number>>((acc, row) => {
    acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Slow queries' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">{engine === 'redis' ? 'Slowlog' : 'Slow queries'}</h1>
            <p className="page-sub">
              {ENGINE_LABEL[engine]} ·{' '}
              {engine === 'redis'
                ? 'SLOWLOG (microseconds, not SQL digests)'
                : engine === 'oracle'
                  ? 'v$sql avg ≥1s'
                  : 'digests / slow_log / PROCESSLIST'}{' '}
              · ≥1 s · last {window.key}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((candidate) => (
              <Link
                key={candidate.key}
                href={`/instances/${instanceId}/slow-queries?w=${candidate.key}`}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </Link>
            ))}
          </div>
        </header>
        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard label="Distinct slow SQL" value={formatNumber(top.length)} hint={`in ${window.key}`} />
          <StatCard
            label="Events"
            value={formatNumber(events.length)}
            tone={events.length > 0 ? 'warn' : 'ok'}
            hint="captured completions / peaks"
          />
          <StatCard
            label="Worst duration"
            value={top[0] ? formatDuration(top[0].maxDurationSec) : '—'}
          />
          <StatCard
            label="Sources"
            value={
              Object.keys(bySource).length === 0
                ? '—'
                : Object.entries(bySource)
                    .map(([src, n]) => `${SOURCE_LABEL[src] ?? src}:${n}`)
                    .join(' ')
            }
            hint={
              engine === 'oracle'
                ? 'v$sql avg ≥1s'
                : engine === 'redis'
                  ? 'SLOWLOG'
                  : 'digest · slow_log · processlist'
            }
          />
        </div>

        <div className="chart-grid chart-grid--2">
          <LabeledBars
            title="Top slow by max duration"
            rows={bars}
            emptyMessage={
              engine === 'oracle'
                ? 'No slow events yet — wait for v$sql averages ≥1s.'
                : engine === 'redis'
                  ? 'No slow events yet — check SLOWLOG or wait for samples ≥1s.'
                  : 'No slow events yet — enable slow_query_log or wait for digests ≥1s.'
            }
            footer="statement_slow_events"
          />
          <TimeseriesPanel
            title="Slow queries /s & digests"
            hint={`${window.key} · SLOW_QUERIES + digest count`}
            data={series}
            unit="count"
            series={[
              {
                metric: 'slow_queries_per_sec',
                label: 'Slow/s',
                color: '#b01818',
                filled: true,
              },
              {
                metric: 'slow_digest_count',
                label: 'Slow digests',
                color: '#9a4a00',
              },
            ]}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Top slow statements</span>
          </div>
          {top.length === 0 ? (
            <div className="panel-body empty">No slow statement aggregates in this window.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Database</th>
                  <th>Sources</th>
                  <th className="text-right">Events</th>
                  <th className="text-right">Max</th>
                  <th className="text-right">Avg</th>
                </tr>
              </thead>
              <tbody>
                {top.map((row) => (
                  <tr key={row.queryid}>
                    <td className="font-mono text-[11px] max-w-[28rem]">
                      <Link
                        href={`/instances/${instanceId}/queries/${row.queryid}`}
                        className="text-accent hover:underline"
                      >
                        {row.query.slice(0, 160)}
                        {row.query.length > 160 ? '…' : ''}
                      </Link>
                    </td>
                    <td className="font-mono text-[11px] text-foreground-muted">
                      {row.database ?? '—'}
                    </td>
                    <td className="font-mono text-[10px] text-foreground-muted">
                      {row.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ')}
                    </td>
                    <td className="num">{formatNumber(row.events)}</td>
                    <td className="num">{formatNumber(row.maxDurationSec, 3)} s</td>
                    <td className="num">{formatNumber(row.avgDurationSec, 3)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Slow events · {events.length}</span>
            <span className="tag tag--muted">duration ≥ 1s</span>
          </div>
          <SlowEventsTable
            instanceId={instanceId}
            events={events.map((row) => ({
              ts: row.ts.toISOString(),
              queryid: row.queryid,
              database: row.database,
              query: row.query,
              durationSec: row.durationSec,
              rowsExamined: row.rowsExamined,
              source: row.source,
            }))}
          />
        </section>
      </div>
    </>
  );
}
