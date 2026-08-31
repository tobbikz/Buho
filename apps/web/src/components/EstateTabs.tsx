'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Los siete dominios del parque.
 *
 * Backups va primero a propósito: es la única pregunta de esta sección cuya
 * respuesta equivocada cuesta la empresa.
 */
const TABS = [
  { href: '/estate', label: 'Backups' },
  { href: '/estate/disk', label: 'Disco' },
  { href: '/estate/jobs', label: 'Jobs' },
  { href: '/estate/replication', label: 'Replicación' },
  { href: '/estate/configuration', label: 'Configuración' },
  { href: '/estate/licensing', label: 'Licencias' },
  { href: '/estate/versions', label: 'Versiones' },
];

export function EstateTabs({ counters = {} }: { counters?: Record<string, number> }) {
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
