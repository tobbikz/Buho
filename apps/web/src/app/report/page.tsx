import Link from 'next/link';
import { ReportFleetOverview } from '@/components/ReportFleetOverview';
import { ReportInstanceCard } from '@/components/ReportInstanceCard';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import type { BackupState } from '@/lib/estate';
import { formatBytes, formatNumber } from '@/lib/format';
import { getWeeklyReport, type WeeklyReport } from '@/lib/report';

export const metadata = { title: 'Weekly report · Búho' };

export const dynamic = 'force-dynamic';

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' });
const DATETIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const BACKUP_TAG: Record<BackupState, string> = {
  sin_recuperacion: 'tag--error',
  atrasado: 'tag--warn',
  no_verificable: 'tag--muted',
  ok: 'tag--ok',
};

const BACKUP_KIND: Record<string, string> = {
  full: 'Full',
  differential: 'Differential',
  log: 'Log',
  wal_archive: 'WAL archive',
};

const WEEKS = [
  { key: 0, label: 'Last 7 days' },
  { key: 1, label: 'Previous week' },
  { key: 2, label: 'Two weeks ago' },
  { key: 3, label: 'Three weeks ago' },
];

function scoreHeroClass(score: number | null): string {
  if (score === null) return 'report-hero-score--neutral';
  if (score < 60) return 'report-hero-score--error';
  if (score < 85) return 'report-hero-score--warn';
  return 'report-hero-score--ok';
}

function Verdict({ report }: { report: WeeklyReport }) {
  const { totals } = report;
  const trend =
    totals.scoreAvg !== null && totals.scorePrevAvg !== null
      ? totals.scoreAvg - totals.scorePrevAvg
      : null;

  const parts: string[] = [];
  if (totals.critical > 0) {
    parts.push(
      `${totals.critical} critical finding${totals.critical === 1 ? '' : 's'} still open at week close`,
    );
  } else if (totals.warning > 0) {
    parts.push(`no criticals; ${totals.warning} warning${totals.warning === 1 ? '' : 's'} remain`);
  } else {
    parts.push('the week closes clean — no critical or warning findings');
  }

  if (trend !== null) {
    if (Math.abs(trend) < 1) parts.push('estate health held steady');
    else if (trend > 0) parts.push(`health improved ${trend.toFixed(0)} points vs prior week`);
    else parts.push(`health dropped ${Math.abs(trend).toFixed(0)} points vs prior week`);
  }
  if (totals.deadlocks > 0) {
    parts.push(`${totals.deadlocks} deadlock${totals.deadlocks === 1 ? '' : 's'} in logs`);
  }
  if (totals.lockEpisodes > 0) {
    parts.push(`${totals.lockEpisodes} session${totals.lockEpisodes === 1 ? '' : 's'} waited on locks`);
  }
  if (totals.growthBytes !== null && totals.growthBytes > 0) {
    parts.push(`data grew ${formatBytes(totals.growthBytes)} across the estate`);
  }
  if (totals.lockWaitShare !== null && totals.lockWaitShare >= 0.1) {
    parts.push(`${(totals.lockWaitShare * 100).toFixed(0)}% of session time went to locks`);
  }
  if (totals.ioWaitShare !== null && totals.ioWaitShare >= 0.2) {
    parts.push(`${(totals.ioWaitShare * 100).toFixed(0)}% of session time waited on disk`);
  }

  return <p className="report-verdict">{parts.join('. ')}.</p>;
}

function Plan({ report }: { report: WeeklyReport }) {
  if (report.plan.length === 0) return null;
  return (
    <div className="report-plan">
      <div className="report-plan__label">This week&apos;s plan</div>
      <ol className="report-plan__list">
        {report.plan.map((item, index) => (
          <li key={index}>
            <span className="report-plan__num">{index + 1}</span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Number(Array.isArray(params['semana']) ? params['semana'][0] : params['semana']);
  const weeksAgo = Number.isFinite(raw) ? Math.max(0, Math.min(12, raw)) : 0;

  let report: WeeklyReport;
  try {
    report = await getWeeklyReport(weeksAgo);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Report' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const { totals, window: w } = report;
  const trend =
    totals.scoreAvg !== null && totals.scorePrevAvg !== null
      ? totals.scoreAvg - totals.scorePrevAvg
      : null;

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Weekly report' }]} />

      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Weekly report</h1>
            <p className="page-sub">
              {DATE.format(w.from)} – {DATE.format(w.to)} · generated {DATETIME.format(report.generatedAt)}
            </p>
          </div>
          <div className="page-header__actions">
            <a
              className="btn btn--primary"
              href={weeksAgo === 0 ? '/report/export' : `/report/export?semana=${weeksAgo}`}
            >
              Download Markdown
            </a>
          </div>
        </header>

        <div className="report-week-tabs">
          {WEEKS.map((option) => (
            <Link
              key={option.key}
              href={option.key === 0 ? '/report' : `/report?semana=${option.key}`}
              className={`tag ${option.key === weeksAgo ? 'tag--info' : 'tag--muted'}`}
            >
              {option.label}
            </Link>
          ))}
        </div>

        <section className="panel report-hero">
          <div className="report-hero__grid">
            <div className={`report-hero-score ${scoreHeroClass(totals.scoreAvg)}`}>
              <span className="report-hero-score__label">Estate health</span>
              <span className="report-hero-score__value">
                {totals.scoreAvg === null ? '—' : totals.scoreAvg.toFixed(0)}
              </span>
              {trend !== null ? (
                <span className={`report-hero-score__trend ${trend >= 0 ? 'is-up' : 'is-down'}`}>
                  {trend >= 0 ? '+' : '−'}
                  {Math.abs(trend).toFixed(0)} vs prior week
                </span>
              ) : (
                <span className="report-hero-score__trend">no prior week</span>
              )}
            </div>
            <div className="report-hero__copy">
              <Verdict report={report} />
              <Plan report={report} />
            </div>
          </div>

          <div className="report-kpi-grid">
            <StatCard
              label="Critical"
              value={String(totals.critical)}
              tone={totals.critical > 0 ? 'error' : 'ok'}
              hint="open at close"
            />
            <StatCard
              label="Warnings"
              value={String(totals.warning)}
              tone={totals.warning > 0 ? 'warn' : 'ok'}
              hint="open at close"
            />
            <StatCard
              label="Lock waits"
              value={String(totals.lockEpisodes)}
              tone={totals.lockEpisodes > 0 ? 'warn' : 'ok'}
              hint="sessions that waited"
            />
            <StatCard
              label="Time in lock"
              value={totals.lockWaitShare === null ? '—' : `${(totals.lockWaitShare * 100).toFixed(0)}%`}
              tone={
                totals.lockWaitShare !== null && totals.lockWaitShare >= 0.15
                  ? 'error'
                  : totals.lockWaitShare !== null && totals.lockWaitShare >= 0.05
                    ? 'warn'
                    : 'ok'
              }
              hint="of session time"
            />
            <StatCard
              label="Time in I/O"
              value={totals.ioWaitShare === null ? '—' : `${(totals.ioWaitShare * 100).toFixed(0)}%`}
              tone={totals.ioWaitShare !== null && totals.ioWaitShare >= 0.25 ? 'warn' : 'ok'}
              hint="of session time"
            />
            <StatCard
              label="Deadlocks"
              value={String(totals.deadlocks)}
              tone={totals.deadlocks > 0 ? 'error' : 'ok'}
              hint="from logs"
            />
            <StatCard
              label="Data growth"
              value={totals.growthBytes === null ? '—' : formatBytes(totals.growthBytes)}
              hint="in the period"
            />
            <StatCard label="Instances" value={String(totals.instances)} hint="monitored" />
          </div>
        </section>

        {report.actions.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Recommended actions</span>
              <span className="text-[10.5px] text-foreground-muted">by severity and reach</span>
            </div>
            <div className="panel-body report-actions">
              {report.actions.map((action, index) => (
                <article
                  key={action.checkId}
                  className={`report-action ${action.severity === 'critical' ? 'report-action--critical' : 'report-action--warning'}`}
                >
                  <div className="report-action__head">
                    <span className="report-action__num">{index + 1}</span>
                    <span className={`tag ${action.severity === 'critical' ? 'tag--error' : 'tag--warn'}`}>
                      {action.severity}
                    </span>
                    <h3 className="report-action__title">{action.title}</h3>
                  </div>
                  <p className="report-action__instances">
                    {action.instances.length} instance{action.instances.length === 1 ? '' : 's'}:{' '}
                    {action.instances.join(', ')}
                  </p>
                  <p className="report-action__message">{action.message}</p>
                  <p className="report-action__fix">{action.remediation}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {report.backups.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Backups</span>
            </div>
            <div className="panel-body space-y-2">
              <div className="table-scroll">
                <table className="data-table data-table--compact">
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Database</th>
                      <th>Type</th>
                      <th>State</th>
                      <th>Last</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.backups.map((backup, index) => (
                      <tr key={`${backup.alias}:${backup.kind}:${index}`}>
                        <td className="font-mono text-[11px]">{backup.alias}</td>
                        <td className="font-mono text-[11px]">{backup.database}</td>
                        <td>{BACKUP_KIND[backup.kind] ?? backup.kind}</td>
                        <td>
                          <span
                            className={`tag ${backup.stateLabel === 'Archive off' ? 'tag--muted' : BACKUP_TAG[backup.state]}`}
                            title={backup.stateHint ?? undefined}
                          >
                            {backup.stateLabel}
                          </span>
                        </td>
                        <td className="font-mono text-[11px]">
                          {backup.finishedAt ? DATETIME.format(backup.finishedAt) : 'no record'}
                        </td>
                        <td className="font-mono text-[11px] text-foreground-secondary">{backup.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11.5px] text-foreground-muted">
                PostgreSQL rows reflect <span className="font-mono">archive_mode</span> / WAL archiving for
                point-in-time recovery — not whether a streaming standby exists. External backup tools without a
                trail in the engine do not appear here.
              </p>
            </div>
          </section>
        ) : null}

        <ReportFleetOverview instances={report.instances} />

        <section className="report-instances-section">
          <div className="report-instances-section__head">
            <h2 className="report-section-title">Instance detail</h2>
            <span className="text-[11px] text-foreground-muted">expand for metrics, waits, maintenance and queries</span>
          </div>
          <div className="report-instances-list">
            {report.instances.map((row, index) => (
              <ReportInstanceCard key={row.instanceId} row={row} defaultOpen={index === 0} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
