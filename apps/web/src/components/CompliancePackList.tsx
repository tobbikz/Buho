'use client';

import { useState } from 'react';
import { ComplianceRunButton } from '@/components/ComplianceRunButton';
import { Modal } from '@/components/Modal';

type Control = {
  id: string;
  title: string;
  verdict: string;
  severity?: string;
  evidence?: string;
  remediation?: string;
};

type RunRow = {
  alias: string;
  engine: string;
  pack: string;
  score: number;
  ran_at: string;
  results: Control[];
};

function scoreTone(score: number): 'ok' | 'warn' | 'error' {
  if (score >= 90) return 'ok';
  if (score >= 70) return 'warn';
  return 'error';
}

function verdictTag(verdict: string): string {
  if (verdict === 'pass') return 'tag tag--ok';
  if (verdict === 'fail') return 'tag tag--error';
  return 'tag tag--muted';
}

export function CompliancePackList({ rows }: { rows: RunRow[] }) {
  const [selected, setSelected] = useState<{
    run: RunRow;
    control: Control;
  } | null>(null);

  return (
    <>
      {rows.map((r) => {
        const controls = r.results;
        const pack = r.pack as 'cis-postgres' | 'cis-mssql' | 'stig-postgres';
        const failed = controls.filter((c) => c.verdict === 'fail');
        const ordered = [...failed, ...controls.filter((c) => c.verdict !== 'fail')];
        return (
          <section key={`${r.alias}-${r.pack}`} className="panel">
            <div className="panel-header">
              <div className="flex flex-wrap items-baseline gap-2 min-w-0">
                <span className="panel-title">{r.alias}</span>
                <span className="tag tag--muted">{r.engine}</span>
                <span className="tag tag--muted font-mono">{r.pack}</span>
                <span
                  className={`tag tag--${
                    scoreTone(r.score) === 'ok'
                      ? 'ok'
                      : scoreTone(r.score) === 'warn'
                        ? 'warn'
                        : 'error'
                  }`}
                >
                  {r.score}/100
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[10px] text-foreground-muted">
                  {controls.length} controls · {failed.length} fail · {r.ran_at}
                </span>
                <ComplianceRunButton alias={r.alias} pack={pack} />
              </div>
            </div>
            <div className="panel-body p-0">
              {controls.length === 0 ? (
                <div className="empty">No per-control payload stored for this run.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table data-table--checks-compact">
                    <thead>
                      <tr>
                        <th>Control</th>
                        <th>Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ordered.map((c) => (
                        <tr
                          key={c.id}
                          className="check-card__row"
                          tabIndex={0}
                          role="button"
                          onClick={() => setSelected({ run: r, control: c })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelected({ run: r, control: c });
                            }
                          }}
                        >
                          <td>
                            <div className="font-medium text-[12px]">{c.title}</div>
                            <div className="text-[10px] text-foreground-muted font-mono">{c.id}</div>
                          </td>
                          <td>
                            <span className={verdictTag(c.verdict)}>
                              {c.verdict}
                              {c.severity ? ` · ${c.severity}` : ''}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        );
      })}

      <Modal
        open={selected !== null}
        title={selected?.control.title ?? 'Control'}
        subtitle={
          selected
            ? `${selected.run.alias} · ${selected.run.pack} · ${selected.control.id}`
            : undefined
        }
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="flex flex-wrap gap-2">
              <span className={verdictTag(selected.control.verdict)}>
                {selected.control.verdict}
                {selected.control.severity ? ` · ${selected.control.severity}` : ''}
              </span>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                Evidence
              </div>
              <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                {selected.control.evidence ?? '—'}
              </p>
            </div>
            {selected.control.remediation ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                  How to fix
                </div>
                <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                  {selected.control.remediation}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
