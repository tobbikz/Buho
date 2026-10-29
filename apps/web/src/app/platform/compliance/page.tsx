import Link from 'next/link';
import { ComplianceRunButton } from '@/components/ComplianceRunButton';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Compliance · Búho' };

type RunRow = {
  alias: string;
  engine: string;
  pack: string;
  score: number;
  ran_at: Date;
  results: Array<{
    id: string;
    title: string;
    verdict: string;
    severity?: string;
    evidence?: string;
    remediation?: string;
  }> | null;
};

function scoreClass(score: number): string {
  if (score >= 90) return 'text-success';
  if (score >= 70) return 'text-warning';
  return 'text-danger';
}

function verdictClass(verdict: string): string {
  if (verdict === 'pass') return 'text-success';
  if (verdict === 'fail') return 'text-danger';
  return 'text-foreground-muted';
}

export default async function CompliancePage() {
  let rows: RunRow[] = [];
  try {
    rows = await query<RunRow>(
      `select distinct on (i.alias, r.pack)
              i.alias, i.engine, r.pack, r.score, r.ran_at, r.results
         from buho.compliance_runs r
         join buho.instances i on i.instance_id = r.instance_id
        order by i.alias, r.pack, r.ran_at desc`,
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Compliance packs</span>
        <span className="text-[11px] text-foreground-muted">
          CIS PostgreSQL / SQL Server · control detail + re-run
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          No compliance runs yet. From an instance with credentials in Admin → Databases, use{' '}
          <code>POST /api/compliance/run</code> with{' '}
          <code>{`{ "alias": "pg-lab", "pack": "cis-postgres" }`}</code>, or open this page after the
          first run.
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {rows.map((r) => {
            const controls = Array.isArray(r.results) ? r.results : [];
            const pack = r.pack as 'cis-postgres' | 'cis-mssql' | 'stig-postgres';
            const failed = controls.filter((c) => c.verdict === 'fail');
            return (
              <div key={`${r.alias}-${r.pack}`} className="border-t border-border pt-4 first:border-0 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-3 mb-2">
                  <div>
                    <div className="font-medium">
                      {r.alias}{' '}
                      <span className="text-[11px] text-foreground-muted">
                        {r.engine} · {r.pack}
                      </span>
                    </div>
                    <div className="text-[11px] text-foreground-muted">
                      Ran {String(r.ran_at)} · {controls.length} controls · {failed.length} fail
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-lg font-semibold ${scoreClass(r.score)}`}>{r.score}/100</span>
                    <ComplianceRunButton alias={r.alias} pack={pack} />
                  </div>
                </div>
                {controls.length === 0 ? (
                  <div className="text-[11px] text-foreground-muted">No per-control payload stored.</div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Control</th>
                        <th>Verdict</th>
                        <th>Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {controls.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <div className="font-medium text-[12px]">{c.title}</div>
                            <div className="text-[10px] text-foreground-muted">{c.id}</div>
                            {c.verdict === 'fail' && c.remediation ? (
                              <div className="text-[10px] text-foreground-muted mt-1">{c.remediation}</div>
                            ) : null}
                          </td>
                          <td className={verdictClass(c.verdict)}>
                            {c.verdict}
                            {c.severity ? ` · ${c.severity}` : ''}
                          </td>
                          <td className="text-[11px]">{c.evidence ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-foreground-muted" style={{ marginTop: '1rem' }}>
        Backup posture: <Link href="/estate/rpo">Estate RPO</Link>. Storage agent:{' '}
        <code>npm run backup-agent</code>.
      </p>
    </section>
  );
}
