import { Topbar } from '@/components/Topbar';
import { AdminTabs } from '@/components/AdminTabs';
import { currentSession } from '@/lib/session';

/**
 * Administración: sólo rol admin.
 *
 * El middleware ya bloquea `/admin` para un viewer, así que este layout no
 * repite la verificación para decidir si renderiza. Sí muestra quién está
 * conectado: en una pantalla donde los botones borran cuentas y cambian
 * retención, saber con qué identidad se está actuando evita el clásico "creí que
 * estaba en el otro entorno".
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();

  return (
    <>
      <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Administración' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Administración</h1>
            <p className="page-sub">
              Descubrimiento de bases en la red, cuentas de la consola y retención de datos. Todo lo de acá queda
              registrado en la bitácora con el usuario que lo hizo.
            </p>
          </div>
          <span className="tag tag--info">
            {session.username} · {session.role}
          </span>
        </header>

        <AdminTabs />
        {children}
      </div>
    </>
  );
}

export const metadata = { title: 'Administración · Búho' };
