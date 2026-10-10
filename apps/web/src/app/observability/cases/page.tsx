import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { listObservabilityCases, type ObsCaseRow } from '@/lib/obs-ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App cases · Observability · Búho' };

function severityClass(severity: string): string {
  if (severity === 'critical') return 'tag tag--error';
  if (severity === 'warning') return 'tag tag--warn';
  return 'tag';
}

export default async function ObservabilityCasesPage() {
  let cases: ObsCaseRow[];
  try {
    cases = await listObservabilityCases();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const critical = cases.filter((c) => c.severity === 'critical').length;
  const warning = cases.filter((c) => c.severity === 'warning').length;
  const uptime = cases.filter((c) => c.source === 'uptime').length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="App cases"
        title="App cases"
        sub={
          <>
            Tickets from Probes / APM alerts ·{' '}
            <Link href="/observability/alerts" className="underline">
              app alerts
            </Link>
            {' · '}
            <Link href="/observability/security/cases" className="underline">
              Security cases
            </Link>
          </>
        }
      />

      <div className="stat-grid">
        <StatCard label="Open" value={String(cases.length)} hint="active investigations" />
        <StatCard label="Critical" value={String(critical)} hint="severity critical" />
        <StatCard label="Warning" value={String(warning)} hint="severity warning" />
        <StatCard label="Probes" value={String(uptime)} hint="probe-sourced" />
      </div>

      {cases.length === 0 ? (
        <ObsEmpty
          title="No open app cases"
          actions={[{ href: '/observability/alerts', label: 'App alerts' }]}
        >
          When Probes or APM alerts fire they appear here as investigation tickets.
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
                  <th>Source</th>
                  <th>Entity</th>
                  <th>Summary</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.caseId}>
                    <td className="font-mono text-[11px]">{c.caseId}</td>
                    <td>
                      <span className={severityClass(c.severity)}>{c.severity}</span>
                    </td>
                    <td>
                      <span className="tag tag--muted">
                        {c.source === 'uptime' ? 'probes' : c.source}
                      </span>
                    </td>
                    <td>
                      <Link href={c.href} className="check-score__instance">
                        {c.entity}
                      </Link>
                    </td>
                    <td>
                      <div className="text-[12px] font-medium leading-snug">{c.title}</div>
                      <div className="alerts-table__detail mt-0.5">{c.message}</div>
                    </td>
                    <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
                      {formatAgo(c.lastSeenAt)}
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
