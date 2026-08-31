'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/admin/discovery', label: 'Descubrimiento' },
  { href: '/admin/users', label: 'Usuarios' },
  { href: '/admin/retention', label: 'Retención' },
  { href: '/admin/audit', label: 'Bitácora' },
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
