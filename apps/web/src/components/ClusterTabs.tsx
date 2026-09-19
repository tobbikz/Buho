'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Cluster Monitoring — intent del zip Superset:
 * HA / lag / roles + Data Growth (tamaño flota, forecast, by engine).
 */
const TABS = [
  { href: '/cluster/ha', label: 'HA & replication' },
  { href: '/cluster/growth', label: 'Data growth' },
] as const;

export function ClusterTabs() {
  const pathname = usePathname();

  return (
    <nav className="tabs" aria-label="Cluster sections">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link key={tab.href} href={tab.href} className={`tab ${active ? 'is-active' : ''}`}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
