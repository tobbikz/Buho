'use client';

import { useMemo, useState } from 'react';
import type { Severity } from '@/lib/queries';

export interface FindingView {
  checkId: string;
  title: string;
  severity: Severity;
  object: string | null;
  message: string;
  remediation: string;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Crítico',
  warning: 'Aviso',
  info: 'Info',
};

const SEVERITY_TAG: Record<Severity, string> = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
};

type Filter = Severity | 'all';

export function FindingsPanel({ findings, checkedAt }: { findings: FindingView[]; checkedAt: string | null }) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const base: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const finding of findings) base[finding.severity] += 1;
    return base;
  }, [findings]);

  const visible = filter === 'all' ? findings : findings.filter((finding) => finding.severity === filter);

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
        <span className="panel-title">Hallazgos</span>
        <div className="flex items-center gap-2">
          {checkedAt && <span className="font-mono text-[10px] text-foreground-muted">corrida {checkedAt}</span>}
          <div className="flex items-center gap-1">
            {chip('all', `Todos ${findings.length}`)}
            {chip('critical', `Críticos ${counts.critical}`)}
            {chip('warning', `Avisos ${counts.warning}`)}
            {chip('info', `Info ${counts.info}`)}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {findings.length === 0
            ? 'Sin hallazgos en la última corrida de checks.'
            : 'Ningún hallazgo con esa severidad.'}
        </div>
      ) : (
        <div>
          {visible.map((finding, index) => (
            <article key={`${finding.checkId}-${finding.object ?? index}`} className={`finding finding--${finding.severity}`}>
              <div>
                <span className={`tag ${SEVERITY_TAG[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
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
      )}
    </section>
  );
}
