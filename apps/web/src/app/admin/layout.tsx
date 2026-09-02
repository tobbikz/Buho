import { Topbar } from '@/components/Topbar';
import { currentSession } from '@/lib/session';

/**
 * Administración: sólo rol admin.
 *
 * El middleware ya bloquea `/admin` para un viewer, así que este layout no
 * repite la verificación para decidir si renderiza. Sí muestra who está
 * conectado: en una pantalla donde los botones borran cuentas y cambian
 * retención, saber con qué identidad se está actuando evita el clásico "creí que
 * estaba en el otro entorno".
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Admin' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Admin</h1>
            <p className="page-sub">
              Network database discovery, console accounts, data retention, and databases added from
              the UI. Everything here is written to the audit log with the user who did it.
            </p>
          </div>
          <span className="tag tag--info">
            {session.username} · {session.role}
          </span>
        </header>

        {children}
      </div>
    </>
  );
}

export const metadata = { title: 'Admin · Búho' };
