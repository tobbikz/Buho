import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatNumber } from '@/lib/format';
import {
  getFleetCheckTotals,
  getFleetChecks,
  getInstanceScores,
  type CheckGroup,
  type InstanceScore,
  type Severity,
} from '@/lib/checks';

export const dynamic = 'force-dynamic';

const FILTERS: { key: string; label: string; severities: Severity[] }[] = [
  { key: 'accionable', label: 'Accionable', severities: ['critical', 'warning'] },
  { key: 'critico', label: 'Critical only', severities: ['critical'] },
  { key: 'todo', label: 'Todo', severities: ['critical', 'warning', 'info'] },
];

const SEVERITY_TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'critical',
  warning: 'warning',
  info: 'informativo',
};

function scoreTone(score: number | null): string {
  if (score === null) return 'text-foreground-muted';
  if (score < 60) return 'text-[var(--error)]';
  if (score < 80) return 'text-[var(--warning)]';
  return 'text-[var(--ok)]';
}

function GroupCard({ group }: { group: CheckGroup }) {
  // Abierto de entrada cuando afecta a una sola instancia: cerrarlo esconde la
  // única línea que importa. Con varias, la lista sí estorba.
  const open = group.instances === 1;

  return (
    <details className="check-group" open={open}>
      <summary className="check-group__head">
        <span className={`tag ${SEVERITY_TAG[group.severity]}`}>{SEVERITY_LABEL[group.severity]}</span>
        <span className="check-group__title">{group.title}</span>
        <span className="check-group__count font-mono">
          {group.instances} instance{group.instances === 1 ? '' : 's'}
          {group.findings > group.instances ? ` · ${group.findings} findings` : ''}
        </span>
        <span className="font-mono text-[10px] text-foreground-muted">{group.checkId}</span>
      </summary>

      <div className="check-group__body">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Instancia</th>
                <th>Object</th>
                <th>What it found</th>
                <th className="text-right">Medido</th>
              </tr>
            </thead>
            <tbody>
              {group.occurrences.map((entry, index) => (
                <tr key={`${entry.instanceId}:${entry.object ?? ''}:${index}`}>
                  <td>
                    <Link href={`/instances/${entry.instanceId}`} className="font-mono text-[11.5px] underline">
                      {entry.alias}
                    </Link>
                    <span className="ml-1.5 text-[10px] text-foreground-muted">
                      {entry.group ?? entry.environment}
                    </span>
                  </td>
                  <td className="font-mono text-[11px] text-foreground-secondary">{entry.object ?? '—'}</td>
                  <td className="text-[11.5px]">{entry.message}</td>
                  <td className="num font-mono text-[11px]">
                    {entry.value === null ? '—' : formatNumber(Math.round(entry.value * 100) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {group.remediation && (
          <div className="check-group__fix">
            <span className="check-group__fix-label">How to fix</span>
            <p>{group.remediation}</p>
          </div>
        )}
      </div>
    </details>
  );
}

function ScoreRow({ instance }: { instance: InstanceScore }) {
  return (
    <tr>
      <td>
        <Link href={`/instances/${instance.instanceId}`} className="font-mono text-[11.5px] underline">
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
  searchParams: Promise<{ ver?: string }>;
}) {
  const { ver } = await searchParams;
  const filter = FILTERS.find((entry) => entry.key === ver) ?? FILTERS[0]!;

  let groups: CheckGroup[];
  let totals: Awaited<ReturnType<typeof getFleetCheckTotals>>;
  let scores: InstanceScore[];
  try {
    [groups, totals, scores] = await Promise.all([
      getFleetChecks(filter.severities),
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
              All 22 checks across every instance in one list, ordered by severity then by
              how many instances they affect. The same problem repeated across half the fleet is fixed once and drops
              many findings: that is what this screen makes visible.
            </p>
          </div>
          <AutoRefresh intervalMs={60000} />
        </header>

        <div className="stat-grid">
          <StatCard
            label="Criticals"
            value={formatNumber(totals.critical)}
            tone={totals.critical > 0 ? 'error' : 'ok'}
            hint="risk of loss or outage"
          />
          <StatCard
            label="Advertencias"
            value={formatNumber(totals.warning)}
            tone={totals.warning > 0 ? 'warn' : 'ok'}
          />
          <StatCard label="Informativos" value={formatNumber(totals.info)} tone="neutral" />
          <StatCard
            label="Instances with findings"
            value={`${formatNumber(totals.instancesAffected)} de ${formatNumber(totals.instancesReporting)}`}
            tone={totals.instancesAffected > 0 ? 'warn' : 'ok'}
            hint={`${formatNumber(totals.instancesClean)} with nothing to report`}
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
            hint="checks run every 5 min"
          />
        </div>

        {totals.instancesSilent > 0 && (
          <div className="notice notice--warn">
            <strong>
              {formatNumber(totals.instancesSilent)} PostgreSQL instance{totals.instancesSilent === 1 ? '' : 's'}
              without checks.
            </strong>{' '}
            They never reported a run, so their absence from this list does not mean they are fine: it means
            that is unknown. Usually a collector that does not start or credentials without{' '}
            <span className="font-mono">pg_monitor</span>.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Ver</span>
          {FILTERS.map((entry) => (
            <a
              key={entry.key}
              href={`/checks?ver=${entry.key}`}
              className={`tag ${entry.key === filter.key ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.label}
            </a>
          ))}
        </div>

        {repeated.length > 0 && (
          <div className="notice">
            <strong>Highest-leverage fixes.</strong>{' '}
            {repeated
              .slice(0, 3)
              .map((group) => `${group.title} (${group.instances} instances)`)
              .join(' · ')}
            . These are platform problems, not one server.
          </div>
        )}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {filter.label} · {groups.length} check{groups.length === 1 ? '' : 's'} with findings
            </span>
            <span className="font-mono text-[10px] text-foreground-muted">
              severity, then reach
            </span>
          </div>

          {groups.length === 0 ? (
            <div className="empty">
              No check with findings at this severity in each instance's last run.
            </div>
          ) : (
            <div className="check-list">
              {groups.map((group) => (
                <GroupCard key={group.checkId} group={group} />
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Score by instance</span>
            <span className="font-mono text-[10px] text-foreground-muted">worst first</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Grupo</th>
                  <th>Entorno</th>
                  <th className="text-right">Score</th>
                  <th className="text-right">Crit.</th>
                  <th className="text-right">Adv.</th>
                  <th className="text-right">Info</th>
                  <th className="text-right">Run</th>
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
