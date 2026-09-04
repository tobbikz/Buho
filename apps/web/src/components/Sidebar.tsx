'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

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
  onNavigate,
}: {
  instances: SidebarInstance[];
  onNavigate?: () => void;
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
      <div className="sidebar__label sidebar__label--instances">Instances</div>
      <nav className="sidebar__section sidebar__section--instances">
        {instances.length === 0 ? (
          <div className="px-[0.875rem] py-1 text-[11px] text-foreground-muted">No instances</div>
        ) : (
          [...groups.entries()].map(([group, members]) => (
            <div key={group || 'all'}>
              {group ? <div className="sidebar__group">{group}</div> : null}
              {members.map((instance) => {
                const href = `/instances/${instance.instanceId}`;
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={instance.instanceId}
                    href={href}
                    className={`sidebar__link ${active ? 'is-active' : ''}`}
                    title={instance.alias}
                    onClick={onNavigate}
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
    </aside>
  );
}
