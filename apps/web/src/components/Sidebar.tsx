'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { OBS_SIDEBAR_NAV, type ObsNavLeaf } from '@/lib/obs-nav';
import type { BuhoSpace } from '@/lib/space';

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

function ObsLink({
  link,
  pathname,
  onNavigate,
}: {
  link: ObsNavLeaf;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={link.href}
      className={`sidebar__link ${link.match(pathname) ? 'is-active' : ''}`}
      onClick={onNavigate}
    >
      <span className="truncate">{link.label}</span>
      {link.badge ? <span className="sidebar__badge">{link.badge}</span> : null}
    </Link>
  );
}

function ObservabilityNav({
  monitors,
  onNavigate,
}: {
  monitors: SidebarInstance[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      <div className="sidebar__label">Observability</div>
      <nav className="sidebar__section" aria-label="Observability navigation">
        {OBS_SIDEBAR_NAV.map((item, idx) => {
          if (item.type === 'section') {
            return (
              <div key={`sec-${item.label}-${idx}`} className="sidebar__group">
                {item.label}
              </div>
            );
          }
          if (item.type === 'group') {
            return (
              <div key={item.label} className="sidebar__obs-group">
                <div className="sidebar__group">{item.label}</div>
                {item.children.map((child) => (
                  <ObsLink
                    key={child.href}
                    link={child}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            );
          }
          return (
            <ObsLink
              key={item.href}
              link={item}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          );
        })}
      </nav>

      <div className="sidebar__label sidebar__label--instances">Services (probes)</div>
      <nav className="sidebar__section sidebar__section--instances">
        {monitors.length === 0 ? (
          <div className="px-[0.875rem] py-1 text-[11px] text-foreground-muted">
            No probes yet
          </div>
        ) : (
          monitors.map((m) => {
            const href = `/observability/services/${encodeURIComponent(m.alias)}?tab=uptime`;
            const serviceBase = `/observability/services/${encodeURIComponent(m.alias)}`;
            const active =
              pathname === serviceBase ||
              pathname.startsWith(`${serviceBase}/`) ||
              pathname === `/observability/monitors/${m.instanceId}`;
            return (
              <Link
                key={m.instanceId}
                href={href}
                className={`sidebar__link ${active ? 'is-active' : ''}`}
                title={m.alias}
                onClick={onNavigate}
              >
                <span className={`status-dot ${dotClass(m)}`} />
                <span className="truncate">{m.alias}</span>
                <span className="sidebar__link-sub">{m.score ?? '—'}</span>
              </Link>
            );
          })
        )}
      </nav>
    </>
  );
}

function DatabasesNav({
  instances,
  onNavigate,
}: {
  instances: SidebarInstance[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups = new Map<string, SidebarInstance[]>();
  for (const instance of instances) {
    const bucket = groups.get(instance.group) ?? [];
    bucket.push(instance);
    groups.set(instance.group, bucket);
  }

  return (
    <>
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
    </>
  );
}

export function Sidebar({
  space = 'databases',
  instances,
  monitors = [],
  onNavigate,
}: {
  space?: BuhoSpace;
  instances: SidebarInstance[];
  monitors?: SidebarInstance[];
  onNavigate?: () => void;
}) {
  return (
    <aside className="sidebar">
      {space === 'observability' ? (
        <ObservabilityNav monitors={monitors} onNavigate={onNavigate} />
      ) : (
        <DatabasesNav instances={instances} onNavigate={onNavigate} />
      )}
    </aside>
  );
}
