import { SecurityTabs } from '@/components/SecurityTabs';
import { Topbar } from '@/components/Topbar';

/**
 * Seguridad es su propia sección, no un tab del parque.
 *
 * El parque responde "qué tengo": versiones, disco, respaldos. Seguridad
 * responde "qué tan expuesto estoy", y eso no es inventario sino un juicio con
 * severidad y remediación. Mezclarlas obligaría a que una tabla de findings
 * viviera entre tablas de estado, con la mitad de las columnas vacías.
 */
export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Security' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Security</h1>
            <p className="page-sub">
              Audit of authentication, privileges, encryption, attack surface, and logging across the three
              engines. Reviewed every 6 hours: posture changes when someone edits configuration, not
              forma continua.
            </p>
          </div>
        </header>

        <SecurityTabs />
        {children}
      </div>
    </>
  );
}
