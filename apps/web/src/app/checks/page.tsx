import Link from 'next/link';
import { ChecksBoard } from '@/components/ChecksBoard';
import { CHECK_FILTERS, ChecksFilter, type CheckFilterKey } from '@/components/ChecksFilter';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatNumber } from '@/lib/format';
import {
  getFleetCheckTotals,
  getFleetChecks,
  getInstanceScores,
  type InstanceScore,
  type Severity,
} from '@/lib/checks';

export const metadata = { title: 'Checks · Búho' };

export const dynamic = 'force-dynamic';

const FILTER_SEVERITIES: Record<CheckFilterKey, Severity[]> = {
  actionable: ['critical', 'warning'],
  critical: ['critical'],
  all: ['critical', 'warning', 'info'],
};

function scoreTone(score: number | null): string {
  if (score === null) return 'text-foreground-muted';
  if (score < 60) return 'text-[var(--error)]';
  if (score < 80) return 'text-[var(--warning)]';
  return 'text-[var(--success)]';
}

function ScoreRow({ instance }: { instance: InstanceScore }) {
  return (
    <tr>
      <td>
        <Link href={`/instances/${instance.instanceId}`} className="check-score__instance">
          {instance.alias}
        </Link>
      </td>
      <td className="text-[11px] text-foreground-muted">{instance.group ?? '—'}</td>
      <td className="text-[11px] text-foreground-muted">{instance.environment}</td>
      <td className={`num font-mono text-[12px] font-semibold ${scoreTone(instance.score)}`}>
        {instance.score ?? '—'}
      </td>
      <td className="num">{instance.critical > 0 ? <span className="tag tag--error">{instance.critical}</span> : '—'}</td>
      <td className="num">{instance.warning > 0 ? <span className="tag tag--warn">{instance.warning}</span> : '—'}</td>
      <td className="num text-[11px] text-foreground-muted">{instance.info || '—'}</td>
      <td className="num font-mono text-[10px] text-foreground-muted">
        {instance.ts ? formatAgo(instance.ts) : 'never ran'}
      </td>
    </tr>
  );
}

export default async function ChecksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; ver?: string }>;
}) {
  const { view, ver } = await searchParams;
  const raw = view ?? ver;
  const legacyMap: Record<string, CheckFilterKey> = {
    accionable: 'actionable',
    critico: 'critical',
    todo: 'all',
  };
  const resolved = raw ? (legacyMap[raw] ?? raw) : 'actionable';
  const filterKey: CheckFilterKey =
    CHECK_FILTERS.find((entry) => entry.key === resolved)?.key ?? 'actionable';

  let groups;
  let totals: Awaited<ReturnType<typeof getFleetCheckTotals>>;
  let scores: InstanceScore[];
  try {
    [groups, totals, scores] = await Promise.all([
      getFleetChecks(FILTER_SEVERITIES[filterKey]),
      getFleetCheckTotals(),
      getInstanceScores(),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Checks' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const repeated = groups.filter((group) => group.instances > 1);

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Checks' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Fleet checks</h1>
            <p className="page-sub">
              All checks across every instance, grouped by problem type. Fix once at the platform level
              and clear findings on every server that shares the same misconfiguration.
            </p>
          </div>
        </header>

        <div className="stat-grid">
          <StatCard
            label="Critical"
            value={formatNumber(totals.critical)}
            tone={totals.critical > 0 ? 'error' : 'ok'}
            hint="data loss or outage risk"
          />
          <StatCard
            label="Warnings"
            value={formatNumber(totals.warning)}
            tone={totals.warning > 0 ? 'warn' : 'ok'}
            hint="should fix soon"
          />
          <StatCard label="Info" value={formatNumber(totals.info)} tone="neutral" hint="informational only" />
          <StatCard
            label="Instances affected"
            value={`${formatNumber(totals.instancesAffected)} of ${formatNumber(totals.instancesReporting)}`}
            tone={totals.instancesAffected > 0 ? 'warn' : 'ok'}
            hint={`${formatNumber(totals.instancesClean)} clean`}
          />
          <StatCard
            label="Worst score"
            value={totals.worstScore === null ? '—' : String(totals.worstScore)}
            tone={
              totals.worstScore === null
                ? 'neutral'
                : totals.worstScore < 60
                  ? 'error'
                  : totals.worstScore < 80
                    ? 'warn'
                    : 'ok'
            }
          />
          <StatCard
            label="Last run"
            value={totals.lastRunAt ? formatAgo(totals.lastRunAt) : '—'}
            tone="neutral"
            hint="every 5 min"
          />
        </div>

        {totals.instancesSilent > 0 ? (
          <div className="checks-notice checks-notice--warn">
            <strong>
              {formatNumber(totals.instancesSilent)} instance{totals.instancesSilent === 1 ? '' : 's'} never
              reported checks.
            </strong>{' '}
            Absence from this list means unknown, not healthy. Usually a collector that is not running or
            monitor credentials missing engine grants (PostgreSQL <span className="font-mono">pg_monitor</span>,
            MSSQL VIEW SERVER STATE / msdb, Maria PROCESS, Oracle catalog views).
          </div>
        ) : null}

        {repeated.length > 0 ? (
          <div className="checks-leverage">
            <span className="checks-leverage__label">Highest leverage</span>
            <p className="checks-leverage__text">
              {repeated
                .slice(0, 3)
                .map((group) => `${group.title} (${group.instances} instances)`)
                .join(' · ')}
              . Platform fixes — not a single-server patch.
            </p>
          </div>
        ) : null}

        <div className="checks-toolbar">
          <ChecksFilter current={filterKey} />
          <span className="checks-toolbar__count">
            {groups.length} check{groups.length === 1 ? '' : 's'} · severity, then reach · 8 per page
          </span>
        </div>

        <section className="panel checks-panel">
          <ChecksBoard
            groups={groups.map((group) => ({
              checkId: group.checkId,
              title: group.title,
              severity: group.severity,
              instances: group.instances,
              findings: group.findings,
              remediation: group.remediation,
              occurrences: group.occurrences.map(({ ts: _ts, ...entry }) => entry),
            }))}
          />
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Health score by instance</span>
            <span className="font-mono text-[10px] text-foreground-muted">worst first</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Group</th>
                  <th>Environment</th>
                  <th className="text-right">Score</th>
                  <th className="text-right">Crit.</th>
                  <th className="text-right">Warn.</th>
                  <th className="text-right">Info</th>
                  <th className="text-right">Last run</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((instance) => (
                  <ScoreRow key={instance.instanceId} instance={instance} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
