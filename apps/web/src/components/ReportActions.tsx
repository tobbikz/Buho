'use client';

import { useState } from 'react';
import { Modal } from '@/components/Modal';
import type { WeeklyReport } from '@/lib/report';

type Action = WeeklyReport['actions'][number];

export function ReportActions({ actions }: { actions: Action[] }) {
  const [selected, setSelected] = useState<{ action: Action; index: number } | null>(null);
  if (actions.length === 0) return null;

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Recommended actions</span>
          <span className="text-[10.5px] text-foreground-muted">click for detail</span>
        </div>
        <div className="panel-body report-actions">
          {actions.map((action, index) => (
            <button
              key={action.checkId}
              type="button"
              className={`report-action report-action--button ${
                action.severity === 'critical' ? 'report-action--critical' : 'report-action--warning'
              }`}
              onClick={() => setSelected({ action, index })}
            >
              <div className="report-action__head">
                <span className="report-action__num">{index + 1}</span>
                <span className={`tag ${action.severity === 'critical' ? 'tag--error' : 'tag--warn'}`}>
                  {action.severity}
                </span>
                <h3 className="report-action__title">{action.title}</h3>
              </div>
              <p className="report-action__instances">
                {action.instances.length} instance{action.instances.length === 1 ? '' : 's'}:{' '}
                {action.instances.slice(0, 4).join(', ')}
                {action.instances.length > 4 ? '…' : ''}
              </p>
            </button>
          ))}
        </div>
      </section>

      <Modal
        open={selected !== null}
        title={selected?.action.title ?? 'Action'}
        subtitle={
          selected
            ? `#${selected.index + 1} · ${selected.action.checkId} · ${selected.action.instances.length} instance(s)`
            : undefined
        }
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="flex flex-wrap gap-2">
              <span
                className={`tag ${
                  selected.action.severity === 'critical' ? 'tag--error' : 'tag--warn'
                }`}
              >
                {selected.action.severity}
              </span>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                Instances
              </div>
              <p className="m-0 text-foreground-secondary">{selected.action.instances.join(', ')}</p>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                Finding
              </div>
              <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                {selected.action.message}
              </p>
            </div>
            {selected.action.remediation ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                  How to fix
                </div>
                <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                  {selected.action.remediation}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
