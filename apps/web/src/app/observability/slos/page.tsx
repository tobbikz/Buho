import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { listObservabilitySlos, type ObsSloRow } from '@/lib/obs-ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'SLOs · Observability · Búho' };

function statusTag(status: ObsSloRow['status']): string {
  if (status === 'met') return 'tag tag--ok';
  if (status === 'breached') return 'tag tag--error';
  return 'tag tag--muted';
}

function kindLabel(kind: ObsSloRow['kind']): string {
  if (kind === 'uptime') return 'probe';
  return kind;
}

export default async function ObservabilitySlosPage() {
  let slos: ObsSloRow[];
  try {
    slos = await listObservabilitySlos();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const met = slos.filter((s) => s.status === 'met').length;
  const breached = slos.filter((s) => s.status === 'breached').length;
  const noData = slos.filter((s) => s.status === 'no_data').length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="SLOs"
        title="SLOs"
        sub="Availability / latency from APM · probe availability · defaults 99% / p95 ≤ 500 ms"
        actions={
          <>
            <Link className="btn" href="/observability/alerts">
              App alerts
            </Link>
            <Link className="btn" href="/observability/services">
              Services
            </Link>
          </>
        }
      />

      <div className="stat-grid">
        <StatCard label="Met" value={String(met)} hint="within target" />
        <StatCard label="Breached" value={String(breached)} hint="over target" />
        <StatCard label="No data" value={String(noData)} hint="not enough samples" />
      </div>

      {slos.length === 0 ? (
        <ObsEmpty
          title="No SLOs to evaluate"
          actions={[
            { href: '/observability/apm/setup', label: 'Add APM', primary: true },
            { href: '/observability/synthetics', label: 'Add probe' },
          ]}
        >
          Ingest OTLP traces or save an HTTP probe to compute availability and latency objectives.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Service & monitor objectives</span>
            <span className="text-[11px] text-foreground-muted">{slos.length} SLOs</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>SLO</th>
                  <th>Kind</th>
                  <th>Target</th>
                  <th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {slos.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className={statusTag(s.status)}>{s.status}</span>
                    </td>
                    <td>
                      <Link href={s.href} className="check-score__instance">
                        {s.name}
                      </Link>
                    </td>
                    <td>
                      <span className="tag tag--muted">{kindLabel(s.kind)}</span>
                    </td>
                    <td className="font-mono text-[12px]">{s.targetLabel}</td>
                    <td className="font-mono text-[12px]">{s.observedLabel}</td>
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
