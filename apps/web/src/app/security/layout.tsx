import { SecurityTabs } from '@/components/SecurityTabs';
import { Topbar } from '@/components/Topbar';

/**
 * Seguridad es su propia sección, no un tab del parque.
 *
 * El parque responde "qué tengo": versiones, disco, respaldos. Seguridad
 * responde "qué tan expuesto estoy", y eso no es inventario sino un juicio con
 * severidad y remediación. Mezclarlas obligaría a que una tabla de hallazgos
 * viviera entre tablas de estado, con la mitad de las columnas vacías.
 */
export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Seguridad' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Seguridad</h1>
            <p className="page-sub">
              Auditoría de autenticación, privilegios, cifrado, superficie de ataque y registro en los tres
              motores. Se revisa cada 6 horas: la postura cambia cuando alguien edita una configuración, no de
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
