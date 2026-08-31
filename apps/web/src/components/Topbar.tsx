import Link from 'next/link';
import { AutoRefresh } from './AutoRefresh';

export interface Crumb {
  label: string;
  href?: string;
}

export function Topbar({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <div className="topbar">
      <div className="breadcrumb">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex items-center gap-[0.375rem]">
            {index > 0 && <span className="text-border-strong">/</span>}
            {crumb.href ? (
              <Link href={crumb.href}>{crumb.label}</Link>
            ) : (
              <span className="breadcrumb__current">{crumb.label}</span>
            )}
          </span>
        ))}
      </div>
      <AutoRefresh />
    </div>
  );
}
