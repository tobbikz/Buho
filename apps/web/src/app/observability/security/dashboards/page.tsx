import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { Sparkline } from '@/components/Sparkline';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  engineLabel,
  getFindings,
  getPosture,
  getPostureScoreSeries,
  getSecurityFindingHeat,
  scoreTone,
  type Finding,
  type Posture,
} from '@/lib/security';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboards · Security · Observability · Búho' };

export default async function SecurityDashboardsPage() {
  let findings: Finding[];
  let posture: Posture[];
  let scoreSeries: Record<number, number[]>;
  let findingHeat: Awaited<ReturnType<typeof getSecurityFindingHeat>>;
  try {
    [findings, posture, scoreSeries, findingHeat] = await Promise.all([
      getFindings(),
      getPosture(),
      getPostureScoreSeries(30),
      getSecurityFindingHeat(14),
    ]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  if (posture.length === 0) {
    return (
      <div className="obs-page">
        <ObsPageHeader
          section="Security"
          title="Dashboards"
          sub="Security posture overview across the fleet"
        />
        <ObsEmpty title="No posture samples yet" actions={[{ href: '/', label: 'Databases fleet' }]}>
          The collector runs a security audit every 6 hours. Dashboards populate after the first
          successful audit.
        </ObsEmpty>
      </div>
    );
  }

  const critical = findings.filter((f) => f.severity === 'critica');
  const high = findings.filter((f) => f.severity === 'alta');
  const exposed = new Set(critical.map((f) => f.instanceId));
  const worst = posture[0]!;
  const verified = posture.reduce((sum, row) => sum + row.verified, 0);
  const totalChecks = posture.reduce((sum, row) => sum + row.total, 0);
  const coveragePct = totalChecks > 0 ? Math.round((verified / totalChecks) * 100) : 0;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security"
        title="Dashboards"
        sub={
          <>
            Fleet security posture ·{' '}
            <Link href="/observability/security/findings" className="underline">
              open findings
            </Link>
          </>
        }
        actions={
          <Link className="btn btn--primary" href="/observability/security/alerts">
            Alerts
          </Link>
        }
      />

      <div className="stat-grid obs-services-kpis">
        <StatCard
          label="Critical"
          value={String(critical.length)}
          hint="severity critical"
          tone={critical.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="High"
          value={String(high.length)}
          hint="severity high"
          tone={high.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Exposed"
          value={`${exposed.size}/${posture.length}`}
          hint="≥1 critical"
          tone={exposed.size > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Worst"
          value={String(worst.score)}
          unit="/100"
          hint={`${worst.alias} · cover ${coveragePct}%`}
          tone={scoreTone(worst.score)}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Critical / high · last 14d</span>
        </div>
        <div className="panel-body">
          {findingHeat.length === 0 ? (
            <div className="empty">No posture history yet.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {findingHeat.map((row) => {
                const bad = row.critical + row.high;
                const tone =
                  row.critical > 0 ? 'tag--error' : row.high > 0 ? 'tag--warn' : 'tag--ok';
                return (
                  <span key={row.day} className={`tag ${tone}`} title={row.day}>
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
          <span className="text-[11px] text-foreground-muted">sparkline = 30d</span>
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
                  {row.verified}/{row.total}
                </td>
                <td>{formatAgo(row.capturedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
