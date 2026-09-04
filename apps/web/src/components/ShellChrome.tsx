'use client';

import { useEffect, useState } from 'react';
import { Navbar } from '@/components/Navbar';
import { Sidebar, type SidebarInstance } from '@/components/Sidebar';

/**
 * Desktop keeps the fixed sidebar. Tablet/phone collapse it into a drawer
 * opened from the navbar hamburger (CSS breakpoints in globals.css).
 */
export function ShellChrome({
  authEnabled,
  isAdmin,
  username,
  instances,
  children,
}: {
  authEnabled: boolean;
  isAdmin: boolean;
  username?: string;
  instances: SidebarInstance[];
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);

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
    <div className={`app-shell ${navOpen ? 'app-shell--nav-open' : ''}`}>
      <Navbar
        authEnabled={authEnabled}
        isAdmin={isAdmin}
        username={username}
        onMenuClick={() => setNavOpen((open) => !open)}
        menuOpen={navOpen}
      />
      <div className="app-body">
        <div className="sidebar-col" id="buho-sidebar">
          <Sidebar instances={instances} onNavigate={() => setNavOpen(false)} />
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
