'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  const navRef = useRef<HTMLElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  const [moreLeft, setMoreLeft] = useState(false);

  // Vacuum is PostgreSQL-only (no analogous concept elsewhere). Host is shown
  // for all engines but needs host_metrics (docker/local/SSH); without it the
  // page renders an explicit empty-state setup panel.
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

  const syncOverflow = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const overflowing = max > 2;
    setMoreLeft(overflowing && el.scrollLeft > 2);
    setMoreRight(overflowing && el.scrollLeft < max - 2);
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    syncOverflow();
    el.addEventListener('scroll', syncOverflow, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncOverflow) : null;
    ro?.observe(el);
    window.addEventListener('resize', syncOverflow);
    return () => {
      el.removeEventListener('scroll', syncOverflow);
      ro?.disconnect();
      window.removeEventListener('resize', syncOverflow);
    };
  }, [syncOverflow, tabs.length, engine]);

  return (
    <div
      className={`tabs-scroll-wrap${moreLeft ? ' tabs-scroll-wrap--left' : ''}${moreRight ? ' tabs-scroll-wrap--right' : ''}`}
    >
      <nav ref={navRef} className="tabs tabs--scroll" aria-label="Instance sections">
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
    </div>
  );
}
