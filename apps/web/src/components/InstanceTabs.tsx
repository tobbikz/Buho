'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function InstanceTabs({
  instanceId,
  blockedCount,
  engine = 'postgres',
}: {
  instanceId: number;
  blockedCount?: number;
  engine?: string;
}) {
  const pathname = usePathname();
  const base = `/instances/${instanceId}`;

  // Ofrecer "Consultas" o "Bloqueos" en un SQL Server sería prometer algo que
  // no existe: esas pantallas leen vistas de PostgreSQL.
  if (engine !== 'postgres') {
    return (
      <nav className="tabs">
        <Link href={base} className="tab is-active">
          Inventario
        </Link>
      </nav>
    );
  }

  const tabs = [
    { href: base, label: 'Resumen' },
    { href: `${base}/analysis`, label: 'Análisis' },
    { href: `${base}/queries`, label: 'Consultas' },
    { href: `${base}/host`, label: 'Host' },
    { href: `${base}/vacuum`, label: 'Vacuum' },
    { href: `${base}/replication`, label: 'Replicación' },
    { href: `${base}/locks`, label: 'Bloqueos', badge: blockedCount },
    { href: `${base}/logs`, label: 'Log' },
  ];

  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={`tab ${pathname === tab.href ? 'is-active' : ''}`}>
          {tab.label}
          {tab.badge ? <span className="tag tag--error">{tab.badge}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
