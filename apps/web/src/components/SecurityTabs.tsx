'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/security', label: 'Findings' },
  { href: '/security/accounts', label: 'Accounts' },
  { href: '/security/coverage', label: 'Coverage' },
];

export function SecurityTabs({ counters = {} }: { counters?: Record<string, number> }) {
  const pathname = usePathname();

  return (
    <nav className="tabs">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        const count = counters[tab.href];
        return (
          <Link key={tab.href} href={tab.href} className={`tab ${active ? 'is-active' : ''}`}>
            {tab.label}
            {count ? <span className="tag tag--error">{count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
