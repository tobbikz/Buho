import Link from 'next/link';
import { EstateTabs } from '@/components/EstateTabs';
import { Topbar } from '@/components/Topbar';
import { ENGINE_LABEL, getEngineCounts } from '@/lib/estate';

/**
 * El parque es una sección de flota, no de instancia.
 *
 * "¿Cuál de mis catorce servidores no tiene backup?" no se responde entrando a
 * los catorce. Todas las pantallas de acá listan el parque completo y dejan el
 * clic a la instancia como profundización, no como punto de partida.
 */

export const metadata = { title: 'Estate · Búho' };
export default async function EstateLayout({ children }: { children: React.ReactNode }) {
  let counts: { engine: string; count: number }[] = [];
  try {
    counts = await getEngineCounts();
  } catch {
    // El store caído lo reporta cada página con StoreError; el encabezado no
    // debe ser el que tumbe toda la sección.
  }

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Estate' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Estate</h1>
            <p className="page-sub">
              Recovery first (Backups → RPO → Replication), then capacity and inventory. Refreshed
              hourly. HA lag / growth also under{' '}
              <Link href="/cluster" className="underline decoration-dotted">
                Cluster
              </Link>
              .
            </p>
          </div>
          <div className="flex items-center gap-1">
            {counts.map((entry) => (
              <span key={entry.engine} className="tag tag--muted">
                {ENGINE_LABEL[entry.engine] ?? entry.engine} · {entry.count}
              </span>
            ))}
          </div>
        </header>

        <EstateTabs />
        {children}
      </div>
    </>
  );
}
