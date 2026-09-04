'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/admin/instances', label: 'Databases' },
  { href: '/admin/alerts', label: 'Alerts' },
  { href: '/admin/discovery', label: 'Discovery' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/retention', label: 'Retention' },
  { href: '/admin/audit', label: 'Audit log' },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav className="tabs">
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} className={`tab ${pathname === tab.href ? 'is-active' : ''}`}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
