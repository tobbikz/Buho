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

  // Vacuum y Host son de PostgreSQL: el primero no existe como concepto en los
  // otros motores, y el segundo lee /proc por SSH. El resto —métricas,
  // consultas, bloqueos, log, inventario— existe en los tres.
  const tabs =
    engine === 'postgres'
      ? [
          { href: base, label: 'Overview' },
          { href: `${base}/analysis`, label: 'Analysis' },
          { href: `${base}/queries`, label: 'Queries' },
          { href: `${base}/indexes`, label: 'Indexes' },
          { href: `${base}/flow`, label: 'Flow' },
          { href: `${base}/topology`, label: 'Topology' },
          { href: `${base}/sessions`, label: 'Sessions' },
          { href: `${base}/capacity`, label: 'Capacity' },
          { href: `${base}/host`, label: 'Host' },
          { href: `${base}/vacuum`, label: 'Vacuum' },
          { href: `${base}/replication`, label: 'Replication' },
          { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
          { href: `${base}/logs`, label: 'Log' },
        ]
      : engine === 'mongodb'
        ? [
            { href: base, label: 'Overview' },
            { href: `${base}/analysis`, label: 'Analysis' },
            { href: `${base}/capacity`, label: 'Capacity' },
            { href: `${base}/inventory`, label: 'Inventory' },
          ]
        : [
          { href: base, label: 'Overview' },
          { href: `${base}/analysis`, label: 'Analysis' },
          { href: `${base}/queries`, label: 'Queries' },
          // Flujo funciona en los tres motores: la atribución sale del texto de
          // la consulta, que se recoge igual en todos. Lo que cambia es el panel
          // de contadores por tabla, que sólo PostgreSQL expone.
          { href: `${base}/flow`, label: 'Flow' },
          { href: `${base}/topology`, label: 'Topology' },
          // Sesiones: en MariaDB sale de PROCESSLIST y en SQL Server de
          // dm_exec_requests. La taxonomía de esperas se normaliza a las mismas
          // familias que PostgreSQL para que el gráfico se lea igual.
          { href: `${base}/sessions`, label: 'Sessions' },
          { href: `${base}/capacity`, label: 'Capacity' },
          { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
          { href: `${base}/logs`, label: 'Log' },
          { href: `${base}/inventory`, label: 'Inventory' },
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
