'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Tab = { href: string; label: string; badge?: number };

type TabGroup = { label?: string; tabs: Tab[] };

function flatTabs(groups: TabGroup[]): Tab[] {
  return groups.flatMap((g) => g.tabs);
}

/** Product DB engines: PostgreSQL (deepest), MSSQL, MariaDB, Oracle. */
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

  const groups: TabGroup[] =
    engine === 'endpoint'
      ? [{ tabs: [{ href: base, label: 'Overview' }, { href: `${base}/analysis`, label: 'Analysis' }] }]
      : engine === 'postgres'
        ? [
            {
              label: 'On-call',
              tabs: [
                { href: base, label: 'Overview' },
                { href: `${base}/analysis`, label: 'Analysis' },
                { href: `${base}/sessions`, label: 'Sessions' },
                { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
                { href: `${base}/replication`, label: 'Replication' },
                { href: `${base}/logs`, label: 'Log' },
                { href: `${base}/blame`, label: 'Blame' },
              ],
            },
            {
              label: 'Workload',
              tabs: [
                { href: `${base}/queries`, label: 'Queries' },
                { href: `${base}/indexes`, label: 'Indexes' },
              ],
            },
            {
              label: 'Model',
              tabs: [
                { href: `${base}/flow`, label: 'Flow' },
                { href: `${base}/orm`, label: 'ORM' },
              ],
            },
            {
              label: 'Storage',
              tabs: [
                { href: `${base}/vacuum`, label: 'Vacuum' },
                { href: `${base}/capacity`, label: 'Capacity' },
                { href: `${base}/host`, label: 'Host' },
                { href: `${base}/backups`, label: 'Backups' },
                { href: `${base}/extensions`, label: 'Extensions' },
                { href: `${base}/inventory`, label: 'Inventory' },
              ],
            },
          ]
          : engine === 'mariadb'
            ? [
                {
                  label: 'On-call',
                  tabs: [
                    { href: base, label: 'Overview' },
                    { href: `${base}/analysis`, label: 'Analysis' },
                    { href: `${base}/sessions`, label: 'Sessions' },
                    { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
                    { href: `${base}/replication`, label: 'Replication' },
                    { href: `${base}/logs`, label: 'Log' },
                    { href: `${base}/blame`, label: 'Blame' },
                  ],
                },
                {
                  label: 'Workload',
                  tabs: [
                    { href: `${base}/queries`, label: 'Queries' },
                    { href: `${base}/slow-queries`, label: 'Slow queries' },
                    { href: `${base}/indexes`, label: 'Indexes' },
                  ],
                },
                {
                  label: 'Model',
                  tabs: [
                    { href: `${base}/flow`, label: 'Flow' },
                    { href: `${base}/orm`, label: 'ORM' },
                  ],
                },
                {
                  label: 'Storage',
                  tabs: [
                    { href: `${base}/vacuum`, label: 'Maintenance' },
                    { href: `${base}/capacity`, label: 'Capacity' },
                    { href: `${base}/host`, label: 'Host' },
                    { href: `${base}/backups`, label: 'Backups' },
                    { href: `${base}/inventory`, label: 'Inventory' },
                  ],
                },
              ]
            : engine === 'mssql'
              ? [
                  {
                    label: 'On-call',
                    tabs: [
                      { href: base, label: 'Overview' },
                      { href: `${base}/analysis`, label: 'Analysis' },
                      { href: `${base}/sessions`, label: 'Sessions' },
                      { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
                      { href: `${base}/replication`, label: 'Replication' },
                      { href: `${base}/logs`, label: 'Log' },
                      { href: `${base}/blame`, label: 'Blame' },
                    ],
                  },
                  {
                    label: 'Workload',
                    tabs: [
                      { href: `${base}/queries`, label: 'Queries' },
                      { href: `${base}/procedures`, label: 'Procedures' },
                      { href: `${base}/indexes`, label: 'Indexes' },
                    ],
                  },
                  {
                    label: 'Model',
                    tabs: [
                      { href: `${base}/flow`, label: 'Flow' },
                      { href: `${base}/orm`, label: 'ORM' },
                    ],
                  },
                  {
                    label: 'Storage',
                    tabs: [
                      { href: `${base}/vacuum`, label: 'Maintenance' },
                      { href: `${base}/capacity`, label: 'Capacity' },
                      { href: `${base}/host`, label: 'Host' },
                      { href: `${base}/backups`, label: 'Backups' },
                      { href: `${base}/inventory`, label: 'Inventory' },
                    ],
                  },
                ]
              : engine === 'oracle'
                ? [
                    {
                      label: 'On-call',
                      tabs: [
                        { href: base, label: 'Overview' },
                        { href: `${base}/analysis`, label: 'Analysis' },
                        { href: `${base}/sessions`, label: 'Sessions' },
                        { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
                        { href: `${base}/replication`, label: 'Replication' },
                        { href: `${base}/logs`, label: 'Log' },
                        { href: `${base}/blame`, label: 'Blame' },
                      ],
                    },
                    {
                      label: 'Workload',
                      tabs: [
                        { href: `${base}/queries`, label: 'Queries' },
                        { href: `${base}/slow-queries`, label: 'Slow queries' },
                        { href: `${base}/indexes`, label: 'Indexes' },
                      ],
                    },
                    {
                      label: 'Model',
                      tabs: [
                        { href: `${base}/flow`, label: 'Flow' },
                        { href: `${base}/orm`, label: 'ORM' },
                      ],
                    },
                    {
                      label: 'Storage',
                      tabs: [
                        { href: `${base}/capacity`, label: 'Capacity' },
                        { href: `${base}/host`, label: 'Host' },
                        { href: `${base}/backups`, label: 'Backups' },
                        { href: `${base}/inventory`, label: 'Inventory' },
                      ],
                    },
                  ]
                : [
                    {
                      tabs: [
                        { href: base, label: 'Overview' },
                        { href: `${base}/analysis`, label: 'Analysis' },
                        { href: `${base}/queries`, label: 'Queries' },
                        { href: `${base}/flow`, label: 'Flow' },
                        { href: `${base}/orm`, label: 'ORM' },
                        { href: `${base}/sessions`, label: 'Sessions' },
                        { href: `${base}/capacity`, label: 'Capacity' },
                        { href: `${base}/host`, label: 'Host' },
                        { href: `${base}/backups`, label: 'Backups' },
                        { href: `${base}/replication`, label: 'Replication' },
                        { href: `${base}/locks`, label: 'Locks', badge: blockedCount },
                        { href: `${base}/logs`, label: 'Log' },
                        { href: `${base}/blame`, label: 'Blame' },
                        { href: `${base}/inventory`, label: 'Inventory' },
                      ],
                    },
                  ];

  const showGroups = groups.length > 1 && groups.some((g) => g.label);

  const isActive = (href: string) => {
    if (pathname === href) return true;
    // Weekly topology lives under the ORM tab (one Model entry).
    if (href === `${base}/orm` && pathname.startsWith(`${base}/topology`)) return true;
    return false;
  };

  return (
    <nav className="tabs tabs--scroll" aria-label="Instance sections">
      {showGroups
        ? groups.map((group, gi) => (
            <span key={group.label ?? gi} className="tabs__group" role="group" aria-label={group.label}>
              {group.label ? <span className="tabs__group-label">{group.label}</span> : null}
              {group.tabs.map((tab) => (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`tab ${isActive(tab.href) ? 'is-active' : ''}`}
                >
                  {tab.label}
                  {tab.badge ? <span className="tag tag--error">{tab.badge}</span> : null}
                </Link>
              ))}
            </span>
          ))
        : flatTabs(groups).map((tab) => (
            <Link key={tab.href} href={tab.href} className={`tab ${isActive(tab.href) ? 'is-active' : ''}`}>
              {tab.label}
              {tab.badge ? <span className="tag tag--error">{tab.badge}</span> : null}
            </Link>
          ))}
    </nav>
  );
}
