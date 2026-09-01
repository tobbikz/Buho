'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '@/app/logout/actions';

export interface SidebarInstance {
  instanceId: number;
  alias: string;
  score: number | null;
  critical: number;
  /** Valor de la dimensión por la que se agrupa; vacío = sin agrupar. */
  group: string;
}

function dotClass(instance: SidebarInstance): string {
  if (instance.score === null) return 'status-dot--idle';
  if (instance.critical > 0 || instance.score < 60) return 'status-dot--error';
  if (instance.score < 85) return 'status-dot--warn';
  return 'status-dot--ok';
}

export function Sidebar({
  instances,
  authEnabled = false,
  isAdmin = false,
  username,
}: {
  instances: SidebarInstance[];
  authEnabled?: boolean;
  isAdmin?: boolean;
  username?: string;
}) {
  const pathname = usePathname();

  // Se agrupa acá y no en el servidor porque es presentación: el orden ya viene
  // resuelto y esto sólo inserta los encabezados.
  const groups = new Map<string, SidebarInstance[]>();
  for (const instance of instances) {
    const bucket = groups.get(instance.group) ?? [];
    bucket.push(instance);
    groups.set(instance.group, bucket);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="text-[15px]">Búho</span>
        <span className="tag tag--muted">v0.4</span>
      </div>

      <nav className="sidebar__section">
        <div className="sidebar__label">Fleet</div>
        <Link href="/" className={`sidebar__link ${pathname === '/' ? 'is-active' : ''}`}>
          Overview
        </Link>
        <Link
          href="/checks"
          className={`sidebar__link ${pathname.startsWith('/checks') ? 'is-active' : ''}`}
        >
          Checks
        </Link>
        <Link
          href="/flow"
          className={`sidebar__link ${pathname === '/flow' ? 'is-active' : ''}`}
        >
          Flow
        </Link>
        <Link
          href="/report"
          className={`sidebar__link ${pathname.startsWith('/report') ? 'is-active' : ''}`}
        >
          Report
        </Link>
        <Link
          href="/estate"
          className={`sidebar__link ${pathname.startsWith('/estate') ? 'is-active' : ''}`}
        >
          Estate
        </Link>
        <Link
          href="/security"
          className={`sidebar__link ${pathname.startsWith('/security') ? 'is-active' : ''}`}
        >
          Security
        </Link>
      </nav>

      <nav className="sidebar__section">
        <div className="sidebar__label">Instances ({instances.length})</div>
        {instances.length === 0 ? (
          <div className="px-[0.875rem] py-1 text-[11px] text-foreground-muted">No instances</div>
        ) : (
          [...groups.entries()].map(([group, members]) => (
            <div key={group || 'todas'}>
              {group ? <div className="sidebar__group">{group}</div> : null}
              {members.map((instance) => {
                const href = `/instances/${instance.instanceId}`;
                return (
                  <Link
                    key={instance.instanceId}
                    href={href}
                    className={`sidebar__link ${pathname === href ? 'is-active' : ''}`}
                    title={instance.alias}
                  >
                    <span className={`status-dot ${dotClass(instance)}`} />
                    <span className="truncate">{instance.alias}</span>
                    <span className="sidebar__link-sub">{instance.score ?? '—'}</span>
                  </Link>
                );
              })}
            </div>
          ))
        )}
      </nav>

      {isAdmin ? (
        <nav className="sidebar__section">
          <div className="sidebar__label">Admin</div>
          <Link
            href="/admin/instances"
            className={`sidebar__link ${pathname.startsWith('/admin/instances') ? 'is-active' : ''}`}
          >
            Databases
          </Link>
          <Link
            href="/admin/discovery"
            className={`sidebar__link ${pathname === '/admin/discovery' ? 'is-active' : ''}`}
          >
            Discovery
          </Link>
          <Link
            href="/admin/users"
            className={`sidebar__link ${pathname === '/admin/users' ? 'is-active' : ''}`}
          >
            Users
          </Link>
          <Link
            href="/admin/retention"
            className={`sidebar__link ${pathname === '/admin/retention' ? 'is-active' : ''}`}
          >
            Retention
          </Link>
        </nav>
      ) : null}

      <div className="mt-auto border-t border-border px-[0.875rem] py-2 text-[10px] text-foreground-muted">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">
            {username ? `${username}${isAdmin ? ' · admin' : ' · viewer'}` : 'PostgreSQL · MariaDB · SQL Server'}
          </span>
          {authEnabled ? (
            <form action={logout}>
              <button type="submit" className="underline decoration-dotted hover:text-foreground">
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
