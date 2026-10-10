import Link from 'next/link';
import type { ReactNode } from 'react';

export type ObsEmptyAction = { href: string; label: string; primary?: boolean };

/** Empty / blind-spot panel used across Observability apps. */
export function ObsEmpty({
  title,
  children,
  actions = [],
}: {
  title?: string;
  children: ReactNode;
  actions?: ObsEmptyAction[];
}) {
  return (
    <section className="panel">
      <div className="panel-body obs-empty">
        {title ? <div className="obs-empty__title">{title}</div> : null}
        <div className="obs-empty__body">{children}</div>
        {actions.length > 0 ? (
          <div className="obs-empty__actions">
            {actions.map((a) => (
              <Link
                key={a.href + a.label}
                href={a.href}
                className={`btn ${a.primary ? 'btn--primary' : ''}`}
              >
                {a.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
