'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { logout } from '@/app/logout/actions';
import {
  OBS_NAV_OPS,
  OBS_NAV_PRIMARY,
  OBS_NAV_SECURITY,
  OBS_NAV_VIEWS,
  type ObsNavLeaf,
} from '@/lib/obs-nav';
import type { BuhoSpace } from '@/lib/space';
import type { SidebarInstance } from '@/components/Sidebar';

const FLEET_LINKS_BASE = [
  { href: '/', label: 'Overview', match: (path: string) => path === '/' },
  { href: '/checks', label: 'Checks', match: (path: string) => path.startsWith('/checks') },
  { href: '/alerts', label: 'Alerts', match: (path: string) => path.startsWith('/alerts') },
  { href: '/events', label: 'Events', match: (path: string) => path.startsWith('/events') },
  { href: '/flow', label: 'Flow', match: (path: string) => path === '/flow' },
  { href: '/report', label: 'Report', match: (path: string) => path.startsWith('/report') },
  { href: '/estate', label: 'Estate', match: (path: string) => path.startsWith('/estate') },
  {
    href: '/cluster',
    label: 'Cluster',
    match: (path: string) => path.startsWith('/cluster'),
  },
] as const;

const ADD_DATABASE_LINK = {
  href: '/admin/targets',
  label: 'Add database',
  match: (path: string) =>
    path.startsWith('/admin/targets') || path.startsWith('/admin/instances'),
} as const;

const ADMIN_LINKS = [
  { href: '/admin/targets', label: 'Targets', hint: 'Monitored databases' },
  { href: '/admin/alerts', label: 'Alerts', hint: 'Webhooks and silences' },
  { href: '/admin/discovery', label: 'Discovery', hint: 'Network scan' },
  { href: '/admin/users', label: 'Users', hint: 'Console accounts' },
  { href: '/admin/retention', label: 'Retention', hint: 'Data lifecycle' },
  { href: '/admin/audit', label: 'Audit log', hint: 'Change history' },
] as const;

function userInitial(username?: string): string {
  if (!username) return '?';
  return username.charAt(0).toUpperCase();
}

function adminActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavDropdown({
  label,
  items,
  pathname,
  onNavigate,
}: {
  label: string;
  items: ObsNavLeaf[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = items.some((i) => i.match(pathname));

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="navbar__menu navbar__menu--rail" ref={ref}>
      <button
        type="button"
        className={`navbar__menu-trigger ${active ? 'is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="navbar__menu-value">
          {label}
          {items.some((i) => i.badge) ? (
            <span className="tag tag--muted" style={{ marginLeft: '0.35rem', fontSize: '10px' }}>
              {items.find((i) => i.badge)?.badge}
            </span>
          ) : null}
        </span>
        <span className={`navbar__chevron ${open ? 'is-open' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="navbar__dropdown" role="menu">
          {items.map((link) => {
            const isActive = link.match(pathname);
            return (
              <Link
                key={link.href}
                href={link.href}
                role="menuitem"
                className={`navbar__dropdown-item ${isActive ? 'is-active' : ''}`}
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              >
                <span className="navbar__dropdown-label">{link.label}</span>
                {link.badge ? (
                  <span className="navbar__dropdown-hint">{link.badge}</span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ServicesMenu({
  monitors,
  pathname,
  onNavigate,
}: {
  monitors: SidebarInstance[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = monitors.some((m) => {
    const base = `/observability/services/${encodeURIComponent(m.alias)}`;
    return pathname === base || pathname.startsWith(`${base}/`);
  });

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (monitors.length === 0) return null;

  return (
    <div className="navbar__menu navbar__menu--rail" ref={ref}>
      <button
        type="button"
        className={`navbar__menu-trigger ${active ? 'is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="navbar__menu-value">Probes</span>
        <span className={`navbar__chevron ${open ? 'is-open' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="navbar__dropdown navbar__dropdown--wide" role="menu">
          {monitors.map((m) => {
            const href = `/observability/services/${encodeURIComponent(m.alias)}?tab=uptime`;
            const base = `/observability/services/${encodeURIComponent(m.alias)}`;
            const isActive = pathname === base || pathname.startsWith(`${base}/`);
            return (
              <Link
                key={m.instanceId}
                href={href}
                role="menuitem"
                className={`navbar__dropdown-item ${isActive ? 'is-active' : ''}`}
                onClick={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              >
                <span className="navbar__dropdown-label font-mono">{m.alias}</span>
                <span className="navbar__dropdown-hint">{m.score ?? '—'}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function Navbar({
  space = 'databases',
  authEnabled = false,
  isAdmin = false,
  username,
  onMenuClick,
  menuOpen = false,
  monitors = [],
}: {
  space?: BuhoSpace;
  authEnabled?: boolean;
  isAdmin?: boolean;
  username?: string;
  onMenuClick?: () => void;
  menuOpen?: boolean;
  monitors?: SidebarInstance[];
}) {
  const pathname = usePathname();
  const [adminOpen, setAdminOpen] = useState(false);
  const adminRef = useRef<HTMLDivElement>(null);
  const fleetLinks = isAdmin ? [ADD_DATABASE_LINK, ...FLEET_LINKS_BASE] : [...FLEET_LINKS_BASE];
  const closeMenu = () => {
    if (menuOpen) onMenuClick?.();
  };

  const onAdmin = pathname.startsWith('/admin');
  const activeAdmin = ADMIN_LINKS.find((link) => adminActive(pathname, link.href));

  useEffect(() => {
    setAdminOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!adminOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (adminRef.current && !adminRef.current.contains(event.target as Node)) {
        setAdminOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setAdminOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [adminOpen]);

  return (
    <header className="navbar">
      <div className="navbar__accent" aria-hidden />

      <div className="navbar__inner">
        <div className="navbar__start">
          {onMenuClick ? (
            <button
              type="button"
              className={`navbar__burger ${menuOpen ? 'is-open' : ''} ${
                space === 'observability' ? 'navbar__burger--obs' : ''
              }`}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="buho-sidebar"
              onClick={onMenuClick}
            >
              <span />
              <span />
              <span />
            </button>
          ) : null}

          <Link
            href={space === 'observability' ? '/observability/services' : '/'}
            className="navbar__brand"
            onClick={closeMenu}
          >
            <span className="navbar__mark" aria-hidden>
              <span className="navbar__mark-eye" />
              <span className="navbar__mark-eye" />
            </span>
            <span className="navbar__brand-text">
              <span className="navbar__logo">Búho</span>
              <span className="navbar__version">v1.6.1</span>
            </span>
          </Link>

          <nav className="navbar__solutions" aria-label="Product space">
            <Link
              href="/"
              className={`navbar__solution ${space === 'databases' ? 'is-active' : ''}`}
              onClick={closeMenu}
            >
              Databases
            </Link>
            <Link
              href="/observability/services"
              className={`navbar__solution ${space === 'observability' ? 'is-active' : ''}`}
              onClick={closeMenu}
            >
              Observability
            </Link>
          </nav>

          <nav className="navbar__rail" aria-label="Main navigation">
            {space === 'observability' ? (
              <>
                {/* Scroll primary links only — menus sit outside overflow so dropdowns aren't clipped to 0×0 */}
                <div className="navbar__rail-scroll">
                  {OBS_NAV_PRIMARY.map((link) => {
                    const active = link.match(pathname);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={`navbar__link ${active ? 'is-active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                        onClick={closeMenu}
                      >
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
                <div className="navbar__rail-menus">
                  <NavDropdown
                    label="Security"
                    items={OBS_NAV_SECURITY}
                    pathname={pathname}
                    onNavigate={closeMenu}
                  />
                  <NavDropdown
                    label="Ops"
                    items={OBS_NAV_OPS}
                    pathname={pathname}
                    onNavigate={closeMenu}
                  />
                  <NavDropdown
                    label="Views"
                    items={OBS_NAV_VIEWS}
                    pathname={pathname}
                    onNavigate={closeMenu}
                  />
                  <ServicesMenu
                    monitors={monitors}
                    pathname={pathname}
                    onNavigate={closeMenu}
                  />
                </div>
              </>
            ) : (
              <div className="navbar__rail-scroll">
                {fleetLinks.map((link) => {
                  const active = link.match(pathname);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={`navbar__link ${active ? 'is-active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={closeMenu}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            )}
          </nav>
        </div>

        <div className="navbar__end">
          <div className="navbar__menu" ref={adminRef}>
            <button
              type="button"
              className={`navbar__menu-trigger ${onAdmin ? 'is-active' : ''}`}
              aria-expanded={adminOpen}
              aria-haspopup="menu"
              onClick={() => setAdminOpen((open) => !open)}
            >
              <span className="navbar__menu-value">
                {activeAdmin?.label ?? (isAdmin ? 'Admin' : 'Alert setup')}
              </span>
              <span className={`navbar__chevron ${adminOpen ? 'is-open' : ''}`} aria-hidden />
            </button>

            {adminOpen ? (
              <div className="navbar__dropdown" role="menu">
                {(isAdmin
                  ? ADMIN_LINKS
                  : ADMIN_LINKS.filter((link) => link.href === '/admin/alerts')
                ).map((link) => {
                  const active = adminActive(pathname, link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      role="menuitem"
                      className={`navbar__dropdown-item ${active ? 'is-active' : ''}`}
                      onClick={() => {
                        setAdminOpen(false);
                        closeMenu();
                      }}
                    >
                      <span className="navbar__dropdown-label">{link.label}</span>
                      <span className="navbar__dropdown-hint">
                        {isAdmin ? link.hint : 'Custom SQL alerts'}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="navbar__account">
            {username ? (
              <div className="navbar__profile">
                <span className="navbar__avatar" aria-hidden>
                  {userInitial(username)}
                </span>
                <span className="navbar__identity">
                  <span className="navbar__username">{username}</span>
                  <span className={`navbar__role ${isAdmin ? 'navbar__role--admin' : ''}`}>
                    {isAdmin ? 'admin' : 'viewer'}
                  </span>
                </span>
              </div>
            ) : (
              <span className="navbar__engines">PG · MSSQL · MariaDB · Oracle</span>
            )}

            {authEnabled ? (
              <form action={logout}>
                <button type="submit" className="navbar__signout">
                  Sign out
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </div>

      <nav className="navbar__mobile-rail" aria-label="Sections">
        {(space === 'observability' ? OBS_NAV_PRIMARY : fleetLinks).map((link) => {
          const active = link.match(pathname);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`navbar__link ${active ? 'is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={closeMenu}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
