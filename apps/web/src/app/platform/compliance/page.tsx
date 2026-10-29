import Link from 'next/link';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Compliance · Búho' };

type Row = {
  alias: string;
  pack: string;
  score: number;
  ran_at: Date;
};

export default async function CompliancePage() {
  let rows: Row[] = [];
  try {
    rows = await query<Row>(
      `select distinct on (i.alias, r.pack)
              i.alias, r.pack, r.score, r.ran_at
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
          CIS PostgreSQL / SQL Server · POST /api/compliance/run
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          No compliance runs yet. Trigger via{' '}
          <code>POST /api/compliance/run</code> with{' '}
          <code>{`{ "alias": "…", "pack": "cis-postgres" }`}</code>.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Pack</th>
              <th>Score</th>
              <th>Ran</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.alias}-${r.pack}-${String(r.ran_at)}`}>
                <td>{r.alias}</td>
                <td>{r.pack}</td>
                <td>{r.score}/100</td>
                <td>{String(r.ran_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-foreground-muted" style={{ marginTop: '1rem' }}>
        Also see <Link href="/estate/rpo">Estate RPO</Link> for backup posture and restore drills.
      </p>
    </section>
  );
}
