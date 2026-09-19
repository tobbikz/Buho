'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { logout } from '@/app/logout/actions';

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
  { href: '/security', label: 'Security', match: (path: string) => path.startsWith('/security') },
] as const;

const ADD_DATABASE_LINK = {
  href: '/admin/instances',
  label: 'Add database',
  match: (path: string) => path.startsWith('/admin/instances'),
} as const;

const ADMIN_LINKS = [
  { href: '/admin/instances', label: 'Databases', hint: 'Monitored targets' },
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

export function Navbar({
  authEnabled = false,
  isAdmin = false,
  username,
  onMenuClick,
  menuOpen = false,
}: {
  authEnabled?: boolean;
  isAdmin?: boolean;
  username?: string;
  onMenuClick?: () => void;
  menuOpen?: boolean;
}) {
  const pathname = usePathname();
  const [adminOpen, setAdminOpen] = useState(false);
  const adminRef = useRef<HTMLDivElement>(null);
  const fleetLinks = isAdmin ? [ADD_DATABASE_LINK, ...FLEET_LINKS_BASE] : [...FLEET_LINKS_BASE];

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
              className={`navbar__burger ${menuOpen ? 'is-open' : ''}`}
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

          <Link href="/" className="navbar__brand" onClick={() => menuOpen && onMenuClick?.()}>
            <span className="navbar__mark" aria-hidden>
              <span className="navbar__mark-eye" />
              <span className="navbar__mark-eye" />
            </span>
            <span className="navbar__brand-text">
              <span className="navbar__logo">Búho</span>
              <span className="navbar__version">v1.3.1</span>
            </span>
          </Link>

          <nav className="navbar__rail" aria-label="Main navigation">
            {fleetLinks.map((link) => {
              const active = link.match(pathname);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`navbar__link ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => menuOpen && onMenuClick?.()}
                >
                  {link.label}
                </Link>
              );
            })}
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
                          if (menuOpen) onMenuClick?.();
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
              <span className="navbar__engines">PG · MariaDB · MSSQL · Mongo</span>
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

      {/* Compact primary nav for phone — rail is hidden; this strip scrolls. */}
      <nav className="navbar__mobile-rail" aria-label="Sections">
        {fleetLinks.map((link) => {
          const active = link.match(pathname);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`navbar__link ${active ? 'is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => menuOpen && onMenuClick?.()}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
