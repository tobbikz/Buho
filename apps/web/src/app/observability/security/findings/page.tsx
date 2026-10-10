import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { SecurityFindingRow } from '@/components/SecurityFindingRow';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import {
  CATEGORY_LABEL,
  SEVERITY_LABEL,
  getFindings,
  type Finding,
  type Severity,
} from '@/lib/security';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Findings · Security · Observability · Búho' };

const ORDER: Severity[] = ['critica', 'alta', 'media', 'baja', 'no_verificable', 'ok'];

function findingClass(severity: Severity): string {
  if (severity === 'critica' || severity === 'alta') return 'finding--critical';
  if (severity === 'media' || severity === 'baja') return 'finding--warning';
  return 'finding--info';
}

export default async function SecurityFindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const view = tab === 'vulnerabilities' ? 'vulnerabilities' : 'misconfigurations';

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

  const open = findings.filter((f) => f.severity !== 'ok');
  const grouped = ORDER.map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.items.length > 0 && g.severity !== 'ok');

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security"
        title="Findings"
        sub="DB config & privilege posture · not CVE scanning"
        actions={
          <>
            <Link className="btn" href="/observability/security/alerts">
              Alerts
            </Link>
            <Link className="btn" href="/observability/security/dashboards">
              Dashboards
            </Link>
          </>
        }
      />

      <div className="discover__tabs mb-3">
        <Link
          href="/observability/security/findings"
          className={`discover__tab ${view === 'misconfigurations' ? 'is-active' : ''}`}
        >
          Misconfigurations
        </Link>
        <Link
          href="/observability/security/findings?tab=vulnerabilities"
          className={`discover__tab ${view === 'vulnerabilities' ? 'is-active' : ''}`}
        >
          Vulnerabilities
        </Link>
      </div>

      {view === 'vulnerabilities' ? (
        <ObsEmpty
          title="Vulnerabilities out of scope"
          actions={[
            { href: '/observability/security/findings', label: 'Misconfigurations', primary: true },
          ]}
        >
          CVE / package scanning is out of scope for Búho. Use Misconfigurations for database
          config and privilege posture.
        </ObsEmpty>
      ) : (
        <>
          <div className="stat-grid obs-services-kpis">
            <StatCard label="Open" value={String(open.length)} hint="non-OK findings" />
            <StatCard
              label="Critical"
              value={String(findings.filter((f) => f.severity === 'critica').length)}
              tone={findings.some((f) => f.severity === 'critica') ? 'error' : 'ok'}
            />
            <StatCard
              label="High"
              value={String(findings.filter((f) => f.severity === 'alta').length)}
              tone={findings.some((f) => f.severity === 'alta') ? 'error' : 'ok'}
            />
            <StatCard
              label="Blind spots"
              value={String(findings.filter((f) => f.severity === 'no_verificable').length)}
              hint="not verifiable"
              tone="warn"
            />
          </div>

          {grouped.length === 0 ? (
            <ObsEmpty
              title="No findings yet"
              actions={[
                { href: '/observability/security/dashboards', label: 'Dashboards' },
                { href: '/', label: 'Databases fleet' },
              ]}
            >
              The collector runs a security audit every 6 hours. Findings appear after the next
              successful audit.
            </ObsEmpty>
          ) : (
            grouped.map((group) => (
              <section className="panel" key={group.severity}>
                <div className="panel-header">
                  <span className="panel-title">{SEVERITY_LABEL[group.severity]}</span>
                  <span
                    className={`tag ${
                      group.severity === 'critica' || group.severity === 'alta'
                        ? 'tag--error'
                        : group.severity === 'no_verificable'
                          ? 'tag--muted'
                          : 'tag--warn'
                    }`}
                  >
                    {group.items.length}
                  </span>
                </div>
                <div className="panel-body p-0">
                  {group.items.map((finding) => (
                    <SecurityFindingRow
                      key={`${finding.instanceId}-${finding.checkId}`}
                      instanceId={finding.instanceId}
                      alias={finding.alias}
                      categoryLabel={CATEGORY_LABEL[finding.category] ?? finding.category}
                      title={finding.title}
                      detail={finding.detail}
                      remediation={finding.remediation}
                      severityClass={findingClass(finding.severity)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
}
