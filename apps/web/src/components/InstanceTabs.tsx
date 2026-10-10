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
          { href: `${base}/extensions`, label: 'Extensions' },
          { href: `${base}/flow`, label: 'Flow' },
          { href: `${base}/topology`, label: 'Catalog' },
          { href: `${base}/sessions`, label: 'Sessions' },
          { href: `${base}/capacity`, label: 'Capacity' },
          { href: `${base}/host`, label: 'Host' },
          { href: `${base}/backups`, label: 'Backups' },
          { href: `${base}/vacuum`, label: 'Vacuum' },
          { href: `${base}/replication`, label: 'Replication' },
          { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
          { href: `${base}/logs`, label: 'Log' },
        ]
      : engine === 'mongodb' ||
          engine === 'redis' ||
          engine === 'cassandra' ||
          engine === 'elasticsearch'
        ? [
            { href: base, label: 'Overview' },
            { href: `${base}/analysis`, label: 'Analysis' },
            ...(engine === 'redis'
              ? [
                  { href: `${base}/queries`, label: 'Queries' },
                  { href: `${base}/slow-queries`, label: 'Slow queries' },
                ]
              : []),
            { href: `${base}/sessions`, label: 'Sessions' },
            { href: `${base}/capacity`, label: 'Capacity' },
            { href: `${base}/host`, label: 'Host' },
            { href: `${base}/backups`, label: 'Backups' },
            { href: `${base}/replication`, label: 'Replication' },
            { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
            { href: `${base}/inventory`, label: 'Inventory' },
          ]
        : [
          { href: base, label: 'Overview' },
          { href: `${base}/analysis`, label: 'Analysis' },
          { href: `${base}/queries`, label: 'Queries' },
          ...(engine === 'mssql' ? [{ href: `${base}/procedures`, label: 'Procedures' }] : []),
          ...(engine === 'mariadb' || engine === 'oracle'
            ? [
                { href: `${base}/slow-queries`, label: 'Slow queries' },
                ...(engine === 'mariadb' ? [{ href: `${base}/indexes`, label: 'Indexes' }] : []),
              ]
            : []),
          { href: `${base}/flow`, label: 'Flow' },
          { href: `${base}/topology`, label: 'Catalog' },
          { href: `${base}/sessions`, label: 'Sessions' },
          { href: `${base}/capacity`, label: 'Capacity' },
          { href: `${base}/host`, label: 'Host' },
          { href: `${base}/backups`, label: 'Backups' },
          { href: `${base}/replication`, label: 'Replication' },
          { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
          { href: `${base}/logs`, label: 'Log' },
          { href: `${base}/inventory`, label: 'Inventory' },
        ];

  return (
    <nav className="tabs tabs--scroll" aria-label="Instance sections">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={`tab ${
            pathname === tab.href ||
            (tab.href.endsWith('/topology') && (pathname.endsWith('/topology') || pathname.endsWith('/orm')))
              ? 'is-active'
              : ''
          }`}
        >
          {tab.label}
          {tab.badge ? <span className="tag tag--error">{tab.badge}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
