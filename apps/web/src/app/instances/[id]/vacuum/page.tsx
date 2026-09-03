import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance, getSeries } from '@/lib/queries';
import { MeasureBloat } from '@/components/MeasureBloat';
import { PollWhilePending } from '@/components/PollWhilePending';
import { currentSession } from '@/lib/session';
import {
  getLatestBloat,
  getPgstattupleState,
  hasPending,
  requestBloat,
  type BloatMode,
} from '@/lib/bloat';
import {
  getVacuumProgress,
  getVacuumTables,
  getVacuumTotals,
  type VacuumOrder,
  type VacuumProgressRow,
  type VacuumTableRow,
} from '@/lib/vacuum';

export const dynamic = 'force-dynamic';

const ORDERS: { key: VacuumOrder; label: string }[] = [
  { key: 'muertas', label: 'Most dead tuples' },
  { key: 'bloat', label: 'Most wasted space' },
  { key: 'antiguedad', label: 'Longest since vacuum' },
  { key: 'tamano', label: 'Largest' },
  { key: 'wraparound', label: 'Closest to wraparound' },
];

/** Human labels for pg_stat_progress_vacuum / analyze phases. */
const PHASE_LABEL: Record<string, string> = {
  initializing: 'starting',
  'scanning heap': 'scanning the table',
  'vacuuming indexes': 'cleaning indexes',
  'vacuuming heap': 'cleaning the table',
  'cleaning up indexes': 'closing indexes',
  'truncating heap': 'returning space to disk',
  'performing final cleanup': 'final cleanup',
  'acquiring sample rows': 'taking a sample',
  'computing statistics': 'computing statistics',
  'finalizing analyze': 'finishing analyze',
};

function ProgressCard({ entry }: { entry: VacuumProgressRow }) {
  const pct = entry.progressPct;
  const target = `${entry.schema ?? '?'}.${entry.table ?? '?'}`;
  const memory =
    entry.deadTupleBytes !== null && entry.maxDeadTupleBytes
      ? `${formatBytes(entry.deadTupleBytes)} of ${formatBytes(entry.maxDeadTupleBytes)} working memory`
      : null;

  return (
    <div className="vacuum-run">
      <div className="vacuum-run__head">
        <span className={`tag ${entry.kind === 'vacuum' ? 'tag--info' : 'tag--muted'}`}>
          {entry.kind === 'vacuum' ? 'VACUUM' : 'ANALYZE'}
        </span>
        <span className="font-mono text-[12px] font-semibold">{target}</span>
        <span className="text-[11.5px] text-foreground-secondary">
          {PHASE_LABEL[entry.phase ?? ''] ?? entry.phase ?? 'unknown phase'}
        </span>
        <span className="font-mono text-[10px] text-foreground-muted">
          pid {entry.pid}
          {entry.startedAt ? ` · since ${formatAgo(entry.startedAt)}` : ''}
        </span>
      </div>

      {pct !== null ? (
        <div className="vacuum-bar">
          <div className="vacuum-bar__fill" style={{ width: `${Math.max(pct, 1)}%` }} />
          <span className="vacuum-bar__label font-mono">{pct.toFixed(0)}%</span>
        </div>
      ) : (
        <p className="text-[11px] text-foreground-muted">
          This phase reports no progress: PostgreSQL only measures the table scan.
        </p>
      )}

      <div className="vacuum-run__meta">
        {entry.heapBlksTotal !== null && (
          <span>
            {formatNumber(entry.heapBlksScanned ?? 0)} of {formatNumber(entry.heapBlksTotal)} blocks scanned
          </span>
        )}
        {entry.indexVacuumCount !== null && entry.indexVacuumCount > 0 && (
          <span>
            {formatNumber(entry.indexVacuumCount)} index pass
            {entry.indexVacuumCount === 1 ? '' : 'es'}
          </span>
        )}
        {memory && <span>{memory}</span>}
      </div>
    </div>
  );
}

function lastPass(row: VacuumTableRow): { text: string; tone: string } {
  const last =
    row.lastAutovacuum && row.lastVacuum
      ? row.lastAutovacuum > row.lastVacuum
        ? row.lastAutovacuum
        : row.lastVacuum
      : row.lastAutovacuum ?? row.lastVacuum;

  if (!last) return { text: 'never', tone: 'text-[var(--error)]' };

  const hours = (Date.now() - last.getTime()) / 3_600_000;
  return {
    text: formatAgo(last),
    tone: hours > 168 ? 'text-[var(--error)]' : hours > 24 ? 'text-[var(--warning)]' : 'text-foreground-muted',
  };
}

/**
 * How close the table is to a forced freeze vacuum — worst of xid / multixact.
 */
function freezeCell(row: VacuumTableRow) {
  const xid = row.xidPct ?? 0;
  const mxid = row.mxidPct ?? 0;
  const worst = Math.max(xid, mxid);
  if (row.freezeMaxAge <= 0) return <span className="text-foreground-muted">—</span>;

  const which = mxid > xid ? 'multixact' : 'transactions';
  const tone = worst >= 90 ? 'text-[var(--error)]' : worst >= 75 ? 'text-[var(--warning)]' : '';
  return (
    <span
      className={tone}
      title={`${which} age: ${Math.round(mxid > xid ? row.mxidAge : row.xidAge).toLocaleString('en-US')} of ${row.freezeMaxAge.toLocaleString('en-US')}`}
    >
      {worst.toFixed(0)}%
      {worst >= 60 && <span className="ml-1 text-[10px] text-foreground-muted">{which}</span>}
    </span>
  );
}

async function requestMeasurement(formData: FormData): Promise<void> {
  'use server';

  const session = await currentSession();
  const instanceId = Number(formData.get('instanceId'));
  const schema = String(formData.get('schema') ?? '');
  const table = String(formData.get('table') ?? '');
  const mode = String(formData.get('mode')) as BloatMode;
  const raw = String(formData.get('estimatedPct') ?? '');
  const estimatedPct = raw === '' ? null : Number(raw);

  if (session.role !== 'admin') {
    redirect(`/instances/${instanceId}/vacuum?error=${encodeURIComponent('Measuring bloat requires an administrator role.')}`);
  }
  if (!schema || !table || (mode !== 'exacto' && mode !== 'aproximado')) {
    redirect(`/instances/${instanceId}/vacuum?error=${encodeURIComponent('Incomplete measurement request.')}`);
  }

  await requestBloat(instanceId, schema, table, mode, session.username, estimatedPct);
  redirect(`/instances/${instanceId}/vacuum`);
}

export default async function VacuumPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ orden?: string; error?: string }>;
}) {
  const { id } = await params;
  const { orden, error: notice } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engineKind = await getInstanceEngine(instanceId);
  if (engineKind && engineKind !== 'postgres') redirect(`/instances/${instanceId}`);

  const order = ORDERS.find((entry) => entry.key === orden)?.key ?? 'muertas';

  let instance;
  try {
    instance = await getInstance(instanceId);
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
  if (!instance) notFound();

  const crumbs = [
    { label: 'Fleet', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Vacuum' },
  ];

  let tables: VacuumTableRow[];
  let progress: VacuumProgressRow[];
  let totals: Awaited<ReturnType<typeof getVacuumTotals>>;
  let series: Awaited<ReturnType<typeof getSeries>>;
  let measurements: Awaited<ReturnType<typeof getLatestBloat>>;
  let session: Awaited<ReturnType<typeof currentSession>>;
  let pgstattuple: Awaited<ReturnType<typeof getPgstattupleState>>;
  try {
    [tables, progress, totals, series, measurements, session, pgstattuple] = await Promise.all([
      getVacuumTables(instanceId, order, 40),
      getVacuumProgress(instanceId),
      getVacuumTotals(instanceId),
      getSeries(instanceId, ['bloat_estimated_bytes', 'vacuum_running'], 1440, 300),
      getLatestBloat(instanceId),
      currentSession(),
      getPgstattupleState(instanceId),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Vacuum &amp; bloat · {instance.alias}</h1>
            <p className="page-sub">
              Which tables are worst, when autovacuum last ran, and what is running now. Wasted space
              is an <strong>estimate</strong> from column widths — good for ranking tables, not for
              billing bytes.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} />

        {notice && <div className="notice notice--warn">{notice}</div>}

        {hasPending(measurements.values()) && <PollWhilePending intervalMs={3000} />}

        {totals.tables === 0 && (
          <div className="notice notice--warn">
            No vacuum snapshot yet for this instance. The collector takes one about every two minutes.
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="Dead tuples"
            value={formatNumber(totals.deadTuples)}
            tone={totals.deadTuples > 1_000_000 ? 'warn' : 'neutral'}
            hint={`across ${formatNumber(totals.tables)} tables`}
          />
          <StatCard
            label="Estimated reclaimable space"
            value={formatBytes(totals.bloatBytes)}
            tone={totals.bloatBytes > 1024 ** 3 ? 'warn' : 'neutral'}
            hint="estimate, heap only"
          />
          <StatCard
            label="Overdue"
            value={formatNumber(totals.overdue)}
            tone={totals.overdue > 0 ? 'warn' : 'ok'}
            hint="tables over their threshold"
          />
          <StatCard
            label="Running now"
            value={formatNumber(progress.length)}
            tone={progress.length > 0 ? 'accent' : 'neutral'}
            hint={progress.length > 0 ? 'vacuum or analyze active' : 'nothing in progress'}
          />
          <StatCard
            label="No ANALYZE"
            value={formatNumber(totals.missingAnalyze)}
            tone={totals.missingAnalyze > 0 ? 'warn' : 'ok'}
            hint="cannot estimate or plan well"
          />
          <StatCard
            label="Worst table for wraparound"
            value={totals.worstXidPct === null ? '—' : `${totals.worstXidPct.toFixed(0)}%`}
            tone={
              (totals.worstXidPct ?? 0) >= 90
                ? 'error'
                : (totals.worstXidPct ?? 0) >= 75
                  ? 'warn'
                  : 'ok'
            }
            hint="of the limit that forces freezing"
          />
          <StatCard
            label="Autovacuum off"
            value={formatNumber(totals.autovacuumDisabled)}
            tone={totals.autovacuumDisabled > 0 ? 'error' : 'ok'}
            hint="tables with the option set to false"
          />
        </div>

        {totals.missingAnalyze > 0 && (
          <div className="notice">
            <strong>
              {formatNumber(totals.missingAnalyze)} table{totals.missingAnalyze === 1 ? '' : 's'} without
              statistics.
            </strong>{' '}
            Without ANALYZE, the planner estimates blind and the wasted-space estimate cannot be
            computed. Same root cause as large plan misestimates on Queries.
          </div>
        )}

        {progress.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">In progress</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                phase and progress over the table scan
              </span>
            </div>
            <div className="vacuum-runs">
              {progress.map((entry) => (
                <ProgressCard key={`${entry.kind}:${entry.pid}`} entry={entry} />
              ))}
            </div>
          </section>
        )}

        <TimeseriesPanel
          title="Estimated wasted space"
          hint="window 24 h"
          data={series}
          unit="bytes"
          height={150}
          series={[{ metric: 'bloat_estimated_bytes', label: 'Estimated bloat', color: '#9a4a00' }]}
        />

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Sort by</span>
          {ORDERS.map((entry) => (
            <a
              key={entry.key}
              href={`/instances/${instanceId}/vacuum?orden=${entry.key}`}
              className={`tag ${entry.key === order ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.label}
            </a>
          ))}
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Tables · {tables.length}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {totals.capturedAt ? `snapshot ${formatAgo(totals.capturedAt)}` : 'no snapshot'}
            </span>
          </div>

          {tables.length === 0 ? (
            <div className="empty">No vacuum data yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th className="text-right">Dead</th>
                    <th className="text-right">% dead</th>
                    <th className="text-right">Until trigger</th>
                    <th className="text-right">Last vacuum</th>
                    <th className="text-right">Last analyze</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Est. waste</th>
                    <th className="text-right">Measured</th>
                    <th className="text-right">Freeze</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map((row) => {
                    const last = lastPass(row);
                    const analyze = row.lastAutoanalyze ?? row.lastAnalyze;
                    return (
                      <tr key={`${row.schema}.${row.table}`}>
                        <td className="font-mono text-[11.5px]">
                          <span className="text-foreground-muted">{row.schema}.</span>
                          {row.table}
                          {!row.autovacuumEnabled && (
                            <span className="tag tag--error ml-1.5">autovacuum off</span>
                          )}
                        </td>
                        <td className="num">{formatNumber(row.deadTuples)}</td>
                        <td className="num">
                          <span
                            className={
                              (row.deadPct ?? 0) >= 50
                                ? 'text-[var(--error)]'
                                : (row.deadPct ?? 0) >= 20
                                  ? 'text-[var(--warning)]'
                                  : ''
                            }
                          >
                            {row.deadPct === null ? '—' : `${row.deadPct.toFixed(1)}%`}
                          </span>
                        </td>
                        <td className="num">
                          {row.remaining === null ? (
                            '—'
                          ) : row.remaining < 0 ? (
                            <span className="text-[var(--warning)]">already exceeded</span>
                          ) : (
                            formatNumber(row.remaining)
                          )}
                        </td>
                        <td className={`num font-mono text-[11px] ${last.tone}`}>{last.text}</td>
                        <td className="num font-mono text-[11px] text-foreground-muted">
                          {analyze ? formatAgo(analyze) : 'never'}
                        </td>
                        <td className="num">{formatBytes(row.sizeBytes)}</td>
                        <td className="num">
                          {row.bloatBytes === null ? (
                            <span className="text-[11px] text-foreground-muted" title={row.bloatNote ?? ''}>
                              not estimable
                            </span>
                          ) : (
                            <>
                              {formatBytes(row.bloatBytes)}
                              {row.bloatPct !== null && (
                                <span className="ml-1 text-[10px] text-foreground-muted">
                                  {row.bloatPct.toFixed(0)}% of heap
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="num">
                          <MeasureBloat
                            action={requestMeasurement}
                            instanceId={instanceId}
                            schema={row.schema}
                            table={row.table}
                            sizeBytes={row.sizeBytes}
                            estimatedPct={row.bloatPct}
                            measurement={measurements.get(`${row.schema}.${row.table}`) ?? null}
                            canMeasure={session.role === 'admin' && pgstattuple.executable}
                            blockedReason={
                              session.role !== 'admin'
                                ? 'Measuring bloat requires an administrator role.'
                                : pgstattuple.reason
                            }
                          />
                        </td>
                        <td className="num">{freezeCell(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {totals.unestimated > 0 && (
          <p className="text-[11px] text-foreground-muted">
            {formatNumber(totals.unestimated)} table{totals.unestimated === 1 ? '' : 's'} without a waste
            estimate. Usual causes: missing ANALYZE, empty table, or rows wider than a page living in
            TOAST (this count does not apply there). Exact measurement needs the{' '}
            <span className="font-mono">pgstattuple</span> extension — a full table read, so Búho never
            runs it automatically.
          </p>
        )}
      </div>
    </>
  );
}
