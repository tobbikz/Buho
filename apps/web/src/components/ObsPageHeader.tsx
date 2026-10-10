import type { ReactNode } from 'react';

/** Consistent Observability page title block. */
export function ObsPageHeader({
  section,
  title,
  sub,
  actions,
}: {
  section: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="obs-page__header">
      <div>
        <p className="obs-page__eyebrow">Observability · {section}</p>
        <h1 className="obs-page__title">{title}</h1>
        {sub ? <p className="obs-page__sub">{sub}</p> : null}
      </div>
      {actions ? <div className="obs-page__actions">{actions}</div> : null}
    </header>
  );
}
