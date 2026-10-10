import { ClusterTabs } from '@/components/ClusterTabs';
import { Topbar } from '@/components/Topbar';
import { ENGINE_LABEL, getEngineCounts } from '@/lib/estate';

/**
 * Cluster Monitoring — flota HA + crecimiento de datos.
 *
 * Misma fuente que Estate → Replication / Disk; esta sección es la entrada
 * explícita que empareja el dashboard "Cluster Monitoring" + "Data Growth"
 * de Superset (sin clonar charts 1:1).
 */

export const metadata = { title: 'Cluster · Búho' };
export default async function ClusterLayout({ children }: { children: React.ReactNode }) {
  let counts: { engine: string; count: number }[] = [];
  try {
    counts = await getEngineCounts();
  } catch {
    // Store down → pages show StoreError; header stays up.
  }

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Cluster' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Cluster monitoring</h1>
            <p className="page-sub">
              Fleet HA (roles, lag, Always On / replicas) and data growth (size, forecast, by
              engine). Same inventory as Estate — focused for the old Superset Cluster + Data Growth
              dashboards.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {counts.map((entry) => (
              <span key={entry.engine} className="tag tag--muted">
                {ENGINE_LABEL[entry.engine] ?? entry.engine} · {entry.count}
              </span>
            ))}
          </div>
        </header>

        <ClusterTabs />
        {children}
      </div>
    </>
  );
}
