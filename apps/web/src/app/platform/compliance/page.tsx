import Link from 'next/link';
import { CompliancePackList } from '@/components/CompliancePackList';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Compliance · Búho' };

type Control = {
  id: string;
  title: string;
  verdict: string;
  severity?: string;
  evidence?: string;
  remediation?: string;
};

type RunRow = {
  alias: string;
  engine: string;
  pack: string;
  score: number;
  ran_at: Date;
  results: Control[] | null;
};

function scoreTone(score: number): 'ok' | 'warn' | 'error' {
  if (score >= 90) return 'ok';
  if (score >= 70) return 'warn';
  return 'error';
}

export default async function CompliancePage() {
  let rows: RunRow[] = [];
  try {
    rows = await query<RunRow>(
      `select distinct on (i.alias, r.pack)
              i.alias, i.engine, r.pack, r.score, r.ran_at, r.results
         from buho.compliance_runs r
         join buho.instances i on i.instance_id = r.instance_id
        where coalesce(i.retired, false) = false
        order by i.alias, r.pack, r.ran_at desc`,
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const avg =
    rows.length === 0 ? null : Math.round(rows.reduce((s, r) => s + Number(r.score), 0) / rows.length);
  const failControls = rows.reduce((n, r) => {
    const controls = Array.isArray(r.results) ? r.results : [];
    return n + controls.filter((c) => c.verdict === 'fail').length;
  }, 0);
  const passControls = rows.reduce((n, r) => {
    const controls = Array.isArray(r.results) ? r.results : [];
    return n + controls.filter((c) => c.verdict === 'pass').length;
  }, 0);

  const clientRows = rows.map((r) => ({
    alias: r.alias,
    engine: r.engine,
    pack: r.pack,
    score: Number(r.score),
    ran_at: String(r.ran_at),
    results: Array.isArray(r.results) ? r.results : [],
  }));

  return (
    <div className="flex flex-col gap-[1.25rem]">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="text-[1.1rem] font-semibold m-0">Compliance</h1>
          <Link className="btn text-[11px]" href="/estate/rpo">
            Estate RPO
          </Link>
        </div>
        <p className="text-[12px] text-foreground-secondary m-0 max-w-[62rem]">
          Latest CIS / STIG pack scores for active instances. Click a control for evidence and
          remediation.
        </p>
      </header>

      <div className="stat-grid">
        <StatCard label="Packs" value={String(rows.length)} tone="neutral" />
        <StatCard
          label="Avg score"
          value={avg == null ? '—' : `${avg}`}
          hint="/100"
          tone={avg == null ? 'neutral' : scoreTone(avg)}
        />
        <StatCard label="Controls pass" value={String(passControls)} tone="ok" />
        <StatCard
          label="Controls fail"
          value={String(failControls)}
          tone={failControls > 0 ? 'error' : 'ok'}
        />
      </div>

      {rows.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">No runs yet</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            <p className="m-0">
              Run a pack from Admin credentials via{' '}
              <code>POST /api/compliance/run</code>{' '}
              <code>{`{ "alias": "pg-lab", "pack": "cis-postgres" }`}</code>.
            </p>
          </div>
        </section>
      ) : (
        <CompliancePackList rows={clientRows} />
      )}
    </div>
  );
}
