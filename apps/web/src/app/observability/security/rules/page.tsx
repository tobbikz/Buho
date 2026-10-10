import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
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
export const metadata = { title: 'Rules · Security · Observability · Búho' };

type RuleRow = {
  checkId: string;
  title: string;
  category: string;
  worstSeverity: Severity;
  hitCount: number;
  instances: number;
};

export default async function SecurityRulesPage() {
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

  const byCheck = new Map<string, RuleRow>();
  const rank: Record<Severity, number> = {
    critica: 0,
    alta: 1,
    media: 2,
    baja: 3,
    no_verificable: 4,
    ok: 5,
  };

  for (const f of findings) {
    const cur = byCheck.get(f.checkId);
    if (!cur) {
      byCheck.set(f.checkId, {
        checkId: f.checkId,
        title: f.title,
        category: f.category,
        worstSeverity: f.severity,
        hitCount: 1,
        instances: 1,
      });
      continue;
    }
    cur.hitCount += 1;
    cur.instances += 1;
    if (rank[f.severity] < rank[cur.worstSeverity]) cur.worstSeverity = f.severity;
    byCheck.set(f.checkId, cur);
  }

  const rules = [...byCheck.values()].sort(
    (a, b) => rank[a.worstSeverity] - rank[b.worstSeverity] || b.hitCount - a.hitCount,
  );

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Security · lab"
        title="Rules"
        sub="Collector audit checks · severity from latest findings"
      />

      <div className="stat-grid obs-services-kpis">
        <StatCard label="Rules" value={String(rules.length)} hint="distinct check_id" />
        <StatCard
          label="Firing"
          value={String(rules.filter((r) => r.worstSeverity !== 'ok').length)}
          hint="non-OK hits"
        />
        <StatCard
          label="Critical"
          value={String(rules.filter((r) => r.worstSeverity === 'critica').length)}
          tone={rules.some((r) => r.worstSeverity === 'critica') ? 'error' : 'ok'}
        />
        <StatCard
          label="High"
          value={String(rules.filter((r) => r.worstSeverity === 'alta').length)}
          tone={rules.some((r) => r.worstSeverity === 'alta') ? 'error' : 'ok'}
        />
      </div>

      {rules.length === 0 ? (
        <ObsEmpty title="No audit rules observed yet" actions={[{ href: '/', label: 'Databases fleet' }]}>
          Rules appear after the collector posts security findings from registered databases.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Detection rules</span>
            <span className="text-[11px] text-foreground-muted">{rules.length} rules</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Rule</th>
                  <th>Category</th>
                  <th className="num">Hits</th>
                  <th className="num">Instances</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.checkId}>
                    <td>
                      <span
                        className={`tag ${
                          r.worstSeverity === 'critica' || r.worstSeverity === 'alta'
                            ? 'tag--error'
                            : r.worstSeverity === 'ok'
                              ? 'tag--ok'
                              : 'tag--warn'
                        }`}
                      >
                        {SEVERITY_LABEL[r.worstSeverity]}
                      </span>
                    </td>
                    <td>
                      <div className="text-[12px] font-medium">{r.title}</div>
                      <div className="font-mono text-[10px] text-foreground-muted">{r.checkId}</div>
                    </td>
                    <td>
                      <span className="tag tag--muted">
                        {CATEGORY_LABEL[r.category] ?? r.category}
                      </span>
                    </td>
                    <td className="num font-mono text-[12px]">{r.hitCount}</td>
                    <td className="num font-mono text-[12px]">{r.instances}</td>
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
