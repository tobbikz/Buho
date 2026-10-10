import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { SecurityFindingRow } from '@/components/SecurityFindingRow';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { CATEGORY_LABEL, getFindings, type Finding } from '@/lib/security';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Alerts · Security · Observability · Búho' };

export default async function SecurityAlertsPage() {
  let findings: Finding[];
  try {
    findings = await getFindings();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const alerts = findings.filter((f) => f.severity === 'critica' || f.severity === 'alta');
  const critical = alerts.filter((f) => f.severity === 'critica');

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security"
        title="Alerts"
        sub={
          <>
            Critical + high findings ·{' '}
            <Link href="/observability/alerts" className="underline">
              App alerts
            </Link>
            {' · '}
            <Link href="/alerts" className="underline">
              Databases
            </Link>
          </>
        }
        actions={
          <>
            <Link className="btn" href="/observability/security/findings">
              Findings
            </Link>
            <Link className="btn btn--primary" href="/observability/security/cases">
              Cases
            </Link>
          </>
        }
      />

      <div className="stat-grid obs-services-kpis">
        <StatCard
          label="Active"
          value={String(alerts.length)}
          hint="critical + high"
          tone={alerts.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Critical"
          value={String(critical.length)}
          tone={critical.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="High"
          value={String(alerts.length - critical.length)}
          tone={alerts.length - critical.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="All findings"
          value={String(findings.length)}
          hint="incl. medium / low"
        />
      </div>

      {alerts.length === 0 ? (
        <ObsEmpty
          title="No security alerts"
          actions={[{ href: '/observability/security/findings', label: 'All findings' }]}
        >
          No critical or high findings. Lower-severity items stay under Findings.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Security alerts</span>
            <span className="text-[11px] text-foreground-muted">{alerts.length} shown</span>
          </div>
          <div className="panel-body p-0">
            {alerts.map((f) => (
              <SecurityFindingRow
                key={`${f.instanceId}-${f.checkId}`}
                instanceId={f.instanceId}
                alias={f.alias}
                categoryLabel={CATEGORY_LABEL[f.category] ?? f.category}
                title={f.title}
                detail={f.detail}
                remediation={f.remediation}
                severityClass={
                  f.severity === 'critica' ? 'finding--critical' : 'finding--critical'
                }
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
