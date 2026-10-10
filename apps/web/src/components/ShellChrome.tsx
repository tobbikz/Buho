'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Navbar } from '@/components/Navbar';
import { Sidebar, type SidebarInstance } from '@/components/Sidebar';
import { spaceFromPath, type BuhoSpace } from '@/lib/space';

/**
 * Single app chrome for Databases + Observability.
 * Observability: nav lives in the top navbar (no persistent sidebar).
 * Databases: desktop keeps the fixed sidebar; tablet/phone → drawer.
 *
 * Space always follows the client pathname — root layout props can lag on
 * soft navigations (x-buho-path only updates on full RSC layout refresh).
 */
export function ShellChrome({
  space: _spaceFromLayout = 'databases',
  authEnabled,
  isAdmin,
  username,
  instances,
  monitors = [],
  children,
}: {
  /** @deprecated layout may lag on soft nav — chrome derives space from pathname */
  space?: BuhoSpace;
  authEnabled: boolean;
  isAdmin: boolean;
  username?: string;
  instances: SidebarInstance[];
  monitors?: SidebarInstance[];
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '/';
  // Live path wins: root layout's x-buho-path prop can stay stuck on soft navigations.
  const space = spaceFromPath(pathname);
  void _spaceFromLayout;
  const [navOpen, setNavOpen] = useState(false);
  const obsTopNav = space === 'observability';

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setNavOpen(false);
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  return (
    <div
      className={`app-shell ${navOpen ? 'app-shell--nav-open' : ''} ${
        obsTopNav ? 'app-shell--obs-topnav' : ''
      }`}
    >
      <Navbar
        space={space}
        authEnabled={authEnabled}
        isAdmin={isAdmin}
        username={username}
        monitors={monitors}
        onMenuClick={() => setNavOpen((open) => !open)}
        menuOpen={navOpen}
      />
      <div className="app-body">
        <div className="sidebar-col" id="buho-sidebar">
          <Sidebar
            space={space}
            instances={instances}
            monitors={monitors}
            onNavigate={() => setNavOpen(false)}
          />
        </div>
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Close navigation"
          tabIndex={navOpen ? 0 : -1}
          onClick={() => setNavOpen(false)}
        />
        <main className="app-main min-w-0">{children}</main>
      </div>
    </div>
  );
}
