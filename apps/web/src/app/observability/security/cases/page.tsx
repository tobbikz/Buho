import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { listSecurityCases } from '@/lib/security-cases';
import { getFindings } from '@/lib/security';
import { openCaseFromFinding, setCaseStatus } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cases · Security · Observability · Búho' };

function statusTag(status: string): string {
  if (status === 'closed') return 'tag tag--muted';
  if (status === 'acked') return 'tag tag--warn';
  return 'tag tag--error';
}

export default async function SecurityCasesPage() {
  let cases;
  let findings;
  try {
    [cases, findings] = await Promise.all([listSecurityCases(100), getFindings()]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const open = cases.filter((c) => c.status === 'open').length;
  const acked = cases.filter((c) => c.status === 'acked').length;
  const closed = cases.filter((c) => c.status === 'closed').length;
  const hotFindings = findings.filter(
    (f) => f.severity === 'critica' || f.severity === 'alta',
  );

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security · lab"
        title="Cases"
        sub={
          <>
            Persisted open/ack/close workflow · not Elastic SIEM ·{' '}
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

      <div className="notice">
        Lab depth: cases store title, severity, finding keys, assignee, status. No SOAR / detection
        engine claims.
      </div>

      <div className="stat-grid obs-services-kpis">
        <StatCard label="Open" value={String(open)} hint="active" />
        <StatCard label="Acked" value={String(acked)} hint="seen" />
        <StatCard label="Closed" value={String(closed)} hint="done" />
        <StatCard
          label="Hot findings"
          value={String(hotFindings.length)}
          hint="critical/high without requiring a case"
        />
      </div>

      {hotFindings.length > 0 ? (
        <section className="panel mb-3">
          <div className="panel-header">
            <span className="panel-title">Open case from finding</span>
            <span className="text-[11px] text-foreground-muted">critical / high</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: '16rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Instance</th>
                  <th>Finding</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {hotFindings.slice(0, 12).map((f) => (
                  <tr key={`${f.instanceId}:${f.checkId}`}>
                    <td>
                      <span className="tag tag--error">{f.severity}</span>
                    </td>
                    <td>
                      <Link href={`/instances/${f.instanceId}`} className="underline">
                        {f.alias}
                      </Link>
                    </td>
                    <td className="text-[12px]">{f.title}</td>
                    <td>
                      <form action={openCaseFromFinding}>
                        <input type="hidden" name="title" value={f.title} />
                        <input type="hidden" name="severity" value={f.severity} />
                        <input type="hidden" name="instanceId" value={String(f.instanceId)} />
                        <input type="hidden" name="checkId" value={f.checkId} />
                        <button type="submit" className="btn btn--primary">
                          Open case
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {cases.length === 0 ? (
        <ObsEmpty
          title="No security cases yet"
          actions={[{ href: '/observability/security/findings', label: 'Findings' }]}
        >
          Open a case from a critical/high finding. Cases persist in{' '}
          <span className="font-mono">buho.security_cases</span>.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Cases</span>
            <span className="text-[11px] text-foreground-muted">{cases.length} shown</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Status</th>
                  <th>Severity</th>
                  <th>Assignee</th>
                  <th>Summary</th>
                  <th className="num">Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.caseId}>
                    <td className="font-mono text-[11px]">SEC-{c.caseId}</td>
                    <td>
                      <span className={statusTag(c.status)}>{c.status}</span>
                    </td>
                    <td>
                      <span className="tag tag--muted">{c.severity}</span>
                    </td>
                    <td className="text-[12px]">{c.assignee ?? '—'}</td>
                    <td className="text-[12px]">
                      <div className="font-medium">{c.title}</div>
                      {c.note ? (
                        <div className="text-[10px] text-foreground-muted mt-0.5">{c.note}</div>
                      ) : null}
                    </td>
                    <td className="num font-mono text-[10px] text-foreground-muted">
                      {formatAgo(c.updatedAt)}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {c.status !== 'acked' ? (
                          <form action={setCaseStatus}>
                            <input type="hidden" name="caseId" value={c.caseId} />
                            <input type="hidden" name="title" value={c.title} />
                            <input type="hidden" name="status" value="acked" />
                            <button type="submit" className="btn">
                              Ack
                            </button>
                          </form>
                        ) : null}
                        {c.status !== 'closed' ? (
                          <form action={setCaseStatus}>
                            <input type="hidden" name="caseId" value={c.caseId} />
                            <input type="hidden" name="title" value={c.title} />
                            <input type="hidden" name="status" value="closed" />
                            <button type="submit" className="btn">
                              Close
                            </button>
                          </form>
                        ) : null}
                        {c.status === 'closed' ? (
                          <form action={setCaseStatus}>
                            <input type="hidden" name="caseId" value={c.caseId} />
                            <input type="hidden" name="title" value={c.title} />
                            <input type="hidden" name="status" value="open" />
                            <button type="submit" className="btn">
                              Reopen
                            </button>
                          </form>
                        ) : null}
                      </div>
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
