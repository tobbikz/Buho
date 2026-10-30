import Link from 'next/link';
import { FleetScopeFilters } from '@/components/FleetScopeFilters';
import { SecurityFindingsBoard } from '@/components/SecurityFindingsBoard';
import { Sparkline } from '@/components/Sparkline';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  CATEGORY_LABEL,
  engineLabel,
  getFindings,
  getPosture,
  getPostureScoreSeries,
  getSecurityFindingHeat,
  scoreTone,
  type Finding,
  type Posture,
} from '@/lib/security';
import { listScopeChoices, matchesScope, scopeEngines } from '@/lib/fleet-scope';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Security · Búho' };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ engine?: string; conn?: string }>;
}) {
  const { engine: engineParam, conn: connParam } = await searchParams;
  const engine = engineParam ?? '';
  const conn = connParam ?? '';
  let findings: Finding[];
  let posture: Posture[];
  let scoreSeries: Record<number, number[]>;
  let findingHeat: Awaited<ReturnType<typeof getSecurityFindingHeat>>;
  let choices: Awaited<ReturnType<typeof listScopeChoices>> = [];
  try {
    [findings, posture, scoreSeries, findingHeat, choices] = await Promise.all([
      getFindings(),
      getPosture(),
      getPostureScoreSeries(30),
      getSecurityFindingHeat(14),
      listScopeChoices(),
    ]);
    findings = findings.filter((row) => matchesScope(row, engine, conn));
    posture = posture.filter((row) => matchesScope(row, engine, conn));
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const filters = (
    <FleetScopeFilters
      engines={scopeEngines(choices)}
      instances={choices}
      engine={engine}
      conn={conn}
    />
  );

  if (posture.length === 0) {
    return (
      <div className="flex flex-col gap-[0.875rem]">
        {filters}
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">{engine || conn ? 'No audits match this filter' : 'No audits yet'}</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            The collector runs a security audit every 6 hours; the first run happens at startup. If this
            stays empty, check the collector log — the audit must connect to each instance.
          </div>
        </section>
      </div>
    );
  }

  const critical = findings.filter((finding) => finding.severity === 'critica');
  const high = findings.filter((finding) => finding.severity === 'alta');
  const blind = findings.filter((finding) => finding.severity === 'no_verificable');
  const exposed = new Set(critical.map((finding) => finding.instanceId));
  const worst = posture[0];
  const verified = posture.reduce((sum, row) => sum + row.verified, 0);
  const totalChecks = posture.reduce((sum, row) => sum + row.total, 0);
  const coveragePct = totalChecks > 0 ? Math.round((verified / totalChecks) * 100) : 0;

  return (
    <div className="flex flex-col gap-[0.875rem]">
      {filters}
      <div className="stat-grid">
        <StatCard
          label="Critical findings"
          value={String(critical.length)}
          hint="access without a valid credential"
          tone={critical.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="High findings"
          value={String(high.length)}
          hint="exposed credentials or data"
          tone={high.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Compromisable instances"
          value={`${exposed.size}/${posture.length}`}
          hint="with at least one critical finding"
          tone={exposed.size > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Worst posture"
          value={String(worst.score)}
          unit="/100"
          hint={worst.alias}
          tone={scoreTone(worst.score)}
        />
        <StatCard
          label="Audit coverage"
          value={String(coveragePct)}
          unit="%"
          hint={`${verified} of ${totalChecks} checks verified`}
          tone={coveragePct >= 90 ? 'ok' : coveragePct >= 70 ? 'warn' : 'error'}
        />
        <StatCard
          label="Blind spots"
          value={String(blind.length)}
          hint="checks lacking permissions"
          tone={blind.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Critical / high findings · last 14d</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            sum of latest scorecard per instance per day
          </span>
        </div>
        <div className="panel-body">
          {findingHeat.length === 0 ? (
            <div className="empty">No posture history yet — fills after a few audit cycles.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {findingHeat.map((row) => {
                const bad = row.critical + row.high;
                const tone =
                  row.critical > 0 ? 'tag--error' : row.high > 0 ? 'tag--warn' : 'tag--ok';
                return (
                  <span key={row.day} className={`tag ${tone}`} title={`${row.day}`}>
                    {row.day.slice(5)} · {bad}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Posture by instance</span>
          <span className="text-[11px] text-foreground-muted">
            score is calculated only over checks that could be verified · sparkline = 30d
          </span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Engine</th>
              <th className="text-right">Posture</th>
              <th>Trend</th>
              <th className="text-right">Critical</th>
              <th className="text-right">High</th>
              <th className="text-right">Medium</th>
              <th className="text-right">Low</th>
              <th className="text-right">Verified</th>
              <th>Last audit</th>
            </tr>
          </thead>
          <tbody>
            {posture.map((row) => (
              <tr key={row.instanceId}>
                <td>
                  <Link href={`/instances/${row.instanceId}`}>{row.alias}</Link>
                </td>
                <td>{engineLabel(row.engine)}</td>
                <td className="text-right">
                  <span className={`score score--${scoreTone(row.score)}`}>{row.score}</span>
                </td>
                <td>
                  <Sparkline
                    values={scoreSeries[row.instanceId] ?? []}
                    color={row.score < 70 ? '#b01818' : '#005eb8'}
                    title={`${row.alias} posture`}
                  />
                </td>
                <td className="text-right">
                  {row.critical > 0 ? <span className="tag tag--error">{row.critical}</span> : '—'}
                </td>
                <td className="text-right">
                  {row.high > 0 ? <span className="tag tag--error">{row.high}</span> : '—'}
                </td>
                <td className="text-right">
                  {row.medium > 0 ? <span className="tag tag--warn">{row.medium}</span> : '—'}
                </td>
                <td className="text-right">{row.low > 0 ? row.low : '—'}</td>
                <td className="text-right">
                  {row.verified}/{row.total}
                </td>
                <td>{formatAgo(row.capturedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <SecurityFindingsBoard
        findings={findings
          .filter((finding) => finding.severity !== 'ok')
          .map((finding) => ({
            instanceId: finding.instanceId,
            checkId: finding.checkId,
            alias: finding.alias,
            categoryLabel: CATEGORY_LABEL[finding.category] ?? finding.category,
            title: finding.title,
            detail: finding.detail,
            remediation: finding.remediation,
            severity:
              finding.severity === 'ok' ? 'baja' : finding.severity,
          }))}
      />
    </div>
  );
}
