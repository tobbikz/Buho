import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { listServiceDeps } from '@/lib/traces';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dependencies · APM · Búho' };

export default async function ObservabilityApmDependenciesPage() {
  let deps: Awaited<ReturnType<typeof listServiceDeps>>;
  try {
    deps = await listServiceDeps();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const fromServices = new Set(
    deps.map((d) => d.fromService ?? d.fromAlias).filter(Boolean) as string[],
  );
  const toDbs = new Set(deps.map((d) => d.toAlias));

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="APM"
        title="Dependencies"
        sub={
          <>
            Service → database edges from <span className="font-mono">service_deps</span>
          </>
        }
        actions={
          <>
            <Link className="btn" href="/observability/map">
              Service map
            </Link>
            <Link className="btn" href="/observability/apm/setup">
              Add APM
            </Link>
          </>
        }
      />

      <div className="stat-grid">
        <StatCard label="Edges" value={String(deps.length)} hint="depends-on links" />
        <StatCard label="Sources" value={String(fromServices.size)} hint="APM services" />
        <StatCard label="Targets" value={String(toDbs.size)} hint="databases" />
      </div>

      {deps.length === 0 ? (
        <ObsEmpty
          title="No dependencies yet"
          actions={[
            { href: '/observability/apm/setup', label: 'Add APM', primary: true },
            { href: '/observability/map', label: 'Service map' },
          ]}
        >
          Emit OTLP with <span className="font-mono">db.name</span>, or insert rows into{' '}
          <span className="font-mono">service_deps</span>. Probes alone do not create Depends on.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Dependency table</span>
            <span className="text-[11px] text-foreground-muted">{deps.length} rows</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Relation</th>
                  <th>To</th>
                  <th>Engine</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {deps.map((d, i) => {
                  const from = d.fromService ?? d.fromAlias ?? '(unknown)';
                  return (
                    <tr key={`${from}-${d.toInstanceId}-${d.relation}-${i}`}>
                      <td>
                        <div className="text-[12px] font-medium">{from}</div>
                        {d.fromEngine ? (
                          <div className="text-[10px] text-foreground-muted">{d.fromEngine}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className="tag tag--muted">{d.relation}</span>
                      </td>
                      <td>
                        <Link
                          href={`/instances/${d.toInstanceId}`}
                          className="check-score__instance"
                        >
                          {d.toAlias}
                        </Link>
                      </td>
                      <td>
                        <span className="tag tag--muted">{d.toEngine}</span>
                      </td>
                      <td className="font-mono text-[11px]">
                        {d.toHost}:{d.toPort}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
