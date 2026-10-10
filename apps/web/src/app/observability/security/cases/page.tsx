import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  CATEGORY_LABEL,
  SEVERITY_LABEL,
  getFindings,
  type Finding,
} from '@/lib/security';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cases · Security · Observability · Búho' };

export default async function SecurityCasesPage() {
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

  const cases = findings
    .filter((f) => f.severity === 'critica' || f.severity === 'alta')
    .map((f, i) => ({
      caseId: `SEC-${String(i + 1).padStart(3, '0')}`,
      finding: f,
    }));

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security"
        title="Cases"
        sub={
          <>
            From critical/high findings ·{' '}
            <Link href="/observability/cases" className="underline">
              App cases
            </Link>
          </>
        }
        actions={
          <Link className="btn" href="/observability/security/alerts">
            Security alerts
          </Link>
        }
      />

      <div className="stat-grid obs-services-kpis">
        <StatCard label="Open" value={String(cases.length)} hint="active cases" />
        <StatCard
          label="Critical"
          value={String(cases.filter((c) => c.finding.severity === 'critica').length)}
          tone={cases.some((c) => c.finding.severity === 'critica') ? 'error' : 'ok'}
        />
        <StatCard
          label="High"
          value={String(cases.filter((c) => c.finding.severity === 'alta').length)}
          tone={cases.some((c) => c.finding.severity === 'alta') ? 'error' : 'ok'}
        />
        <StatCard
          label="Instances"
          value={String(new Set(cases.map((c) => c.finding.instanceId)).size)}
          hint="with open cases"
        />
      </div>

      {cases.length === 0 ? (
        <ObsEmpty
          title="No open security cases"
          actions={[{ href: '/observability/security/findings', label: 'Findings' }]}
        >
          Cases open from critical/high findings. Nothing to investigate right now.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Active cases</span>
            <span className="text-[11px] text-foreground-muted">{cases.length} shown</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Severity</th>
                  <th>Instance</th>
                  <th>Category</th>
                  <th>Summary</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {cases.map(({ caseId, finding: f }) => (
                  <tr key={caseId}>
                    <td className="font-mono text-[11px]">{caseId}</td>
                    <td>
                      <span className="tag tag--error">{SEVERITY_LABEL[f.severity]}</span>
                    </td>
                    <td>
                      <Link href={`/instances/${f.instanceId}`} className="check-score__instance">
                        {f.alias}
                      </Link>
                    </td>
                    <td>
                      <span className="tag tag--muted">
                        {CATEGORY_LABEL[f.category] ?? f.category}
                      </span>
                    </td>
                    <td>
                      <div className="text-[12px] font-medium">{f.title}</div>
                      <div className="text-[11px] text-foreground-muted">{f.detail}</div>
                    </td>
                    <td className="num font-mono text-[10px] text-foreground-muted">
                      {formatAgo(f.capturedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
