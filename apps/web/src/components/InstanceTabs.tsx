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
          { href: base, label: 'Resumen' },
          { href: `${base}/analysis`, label: 'Análisis' },
          { href: `${base}/queries`, label: 'Consultas' },
          { href: `${base}/indexes`, label: 'Índices' },
          { href: `${base}/flow`, label: 'Flujo' },
          { href: `${base}/topology`, label: 'Topología' },
          { href: `${base}/sessions`, label: 'Sesiones' },
          { href: `${base}/capacity`, label: 'Capacidad' },
          { href: `${base}/host`, label: 'Host' },
          { href: `${base}/vacuum`, label: 'Vacuum' },
          { href: `${base}/replication`, label: 'Replicación' },
          { href: `${base}/locks`, label: 'Bloqueos', badge: blockedCount },
          { href: `${base}/logs`, label: 'Log' },
        ]
      : engine === 'mongodb'
        ? [
            { href: base, label: 'Resumen' },
            { href: `${base}/analysis`, label: 'Análisis' },
            { href: `${base}/capacity`, label: 'Capacidad' },
            { href: `${base}/inventory`, label: 'Inventario' },
          ]
        : [
          { href: base, label: 'Resumen' },
          { href: `${base}/analysis`, label: 'Análisis' },
          { href: `${base}/queries`, label: 'Consultas' },
          // Flujo funciona en los tres motores: la atribución sale del texto de
          // la consulta, que se recoge igual en todos. Lo que cambia es el panel
          // de contadores por tabla, que sólo PostgreSQL expone.
          { href: `${base}/flow`, label: 'Flujo' },
          { href: `${base}/topology`, label: 'Topología' },
          // Sesiones: en MariaDB sale de PROCESSLIST y en SQL Server de
          // dm_exec_requests. La taxonomía de esperas se normaliza a las mismas
          // familias que PostgreSQL para que el gráfico se lea igual.
          { href: `${base}/sessions`, label: 'Sesiones' },
          { href: `${base}/capacity`, label: 'Capacidad' },
          { href: `${base}/locks`, label: 'Bloqueos', badge: blockedCount },
          { href: `${base}/logs`, label: 'Log' },
          { href: `${base}/inventory`, label: 'Inventario' },
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
