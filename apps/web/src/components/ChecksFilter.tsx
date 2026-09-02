import Link from 'next/link';

export const CHECK_FILTERS = [
  { key: 'actionable', label: 'Actionable', hint: 'Critical + warnings' },
  { key: 'critical', label: 'Critical only', hint: 'Outage or data-loss risk' },
  { key: 'all', label: 'All', hint: 'Include informational' },
] as const;

export type CheckFilterKey = (typeof CHECK_FILTERS)[number]['key'];

export function ChecksFilter({ current }: { current: CheckFilterKey }) {
  return (
    <nav className="checks-filter" aria-label="Severity filter">
      {CHECK_FILTERS.map((entry) => {
        const active = current === entry.key;
        return (
          <Link
            key={entry.key}
            href={`/checks?view=${entry.key}`}
            className={`checks-filter__link ${active ? 'is-active' : ''}`}
            title={entry.hint}
            aria-current={active ? 'page' : undefined}
          >
            {entry.label}
          </Link>
        );
      })}
    </nav>
  );
}
