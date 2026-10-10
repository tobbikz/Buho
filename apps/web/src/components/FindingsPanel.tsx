'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Severity } from '@/lib/queries';

export interface FindingView {
  checkId: string;
  title: string;
  severity: Severity;
  object: string | null;
  message: string;
  remediation: string;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info'];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const SEVERITY_TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

const SEVERITY_STRIPE: Record<Severity, string> = {
  critical: 'check-card--critical',
  warning: 'check-card--warning',
  info: 'check-card--info',
};

type Filter = Severity | 'all';

const PAGE_SIZE = 10;

export function FindingsPanel({ findings, checkedAt }: { findings: FindingView[]; checkedAt: string | null }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  const visible = useMemo(
    () => (filter === 'all' ? findings : findings.filter((finding) => finding.severity === filter)),
    [filter, findings],
  );

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [filter, findings]);

  const chip = (value: Filter, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setFilter(value)}
      className={`tag ${filter === value ? 'tag--info' : 'tag--muted'}`}
      style={{ cursor: 'pointer' }}
    >
      {label}
    </button>
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Findings</span>
        <div className="flex items-center gap-2">
          {checkedAt ? <span className="font-mono text-[10px] text-foreground-muted">run {checkedAt}</span> : null}
          <div className="flex items-center gap-1">
            {chip('all', `All ${findings.length}`)}
            {chip('critical', `Critical ${counts.critical}`)}
            {chip('warning', `Warnings ${counts.warning}`)}
            {chip('info', `Info ${counts.info}`)}
          </div>
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="empty">
          {findings.length === 0 ? 'No findings in the last check run.' : 'No findings at that severity.'}
        </div>
      ) : (
        <>
          <div>
            {pageRows.map((finding, index) => (
              <article
                key={`${finding.checkId}-${finding.object ?? index}-${safePage}`}
                className={`finding finding--${finding.severity}`}
              >
                <div>
                  <span className={`tag ${SEVERITY_TAG[finding.severity]}`}>
                    {SEVERITY_LABEL[finding.severity]}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="finding__title">{finding.title}</span>
                    {finding.object && <span className="finding__object">{finding.object}</span>}
                    <span className="font-mono text-[10px] text-foreground-muted">{finding.checkId}</span>
                  </div>
                  <p className="finding__message">{finding.message}</p>
                  <p className="finding__remediation">{finding.remediation}</p>
                </div>
              </article>
            ))}
          </div>
          {visible.length > PAGE_SIZE ? (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
              <span className="font-mono text-[11px] text-foreground-muted">
                {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, visible.length)} of{' '}
                {visible.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="tag tag--muted"
                  style={{ cursor: safePage === 0 ? 'default' : 'pointer', opacity: safePage === 0 ? 0.5 : 1 }}
                  disabled={safePage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Prev
                </button>
                <span className="font-mono text-[11px] text-foreground-muted">
                  {safePage + 1}/{pageCount}
                </span>
                <button
                  type="button"
                  className="tag tag--muted"
                  style={{
                    cursor: safePage >= pageCount - 1 ? 'default' : 'pointer',
                    opacity: safePage >= pageCount - 1 ? 0.5 : 1,
                  }}
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
