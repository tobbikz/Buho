'use client';

import { useMemo, useState } from 'react';
import { formatDuration, formatNumber } from '@/lib/format';
import type { SuggestionKind } from '@buho/core';

export interface SuggestionEvidenceRow {
  queryid: string | null;
  nodeType: string;
  predicate: string;
  rowsRemoved: number | null;
  rowsReturned: number | null;
  loops: number | null;
  selfMs: number | null;
}

export interface SuggestionCardItem {
  relation: string;
  kind: SuggestionKind;
  reason: string;
  caveat: string;
  ddl: string;
  columns: string[];
  evidence: SuggestionEvidenceRow[];
}

const KIND_LABEL: Record<SuggestionKind, string> = {
  seq_scan_filtrado: 'Seq scan discards most rows',
  indice_no_selectivo: 'Index finds rows but barely filters',
  orden_sin_indice: 'Sort spilled to disk',
  join_sin_indice: 'Join without inner index',
};

const KIND_TAG: Record<SuggestionKind, string> = {
  seq_scan_filtrado: 'tag--warn',
  indice_no_selectivo: 'tag--warn',
  orden_sin_indice: 'tag--info',
  join_sin_indice: 'tag--warn',
};

const KIND_ACTION: Record<SuggestionKind, string> = {
  seq_scan_filtrado: 'Review whether a new index on the filter columns would help.',
  indice_no_selectivo: 'Check if a more selective index (or different columns) would help.',
  orden_sin_indice: 'Consider an index that matches the ORDER BY / GROUP BY keys.',
  join_sin_indice: 'Consider an index on the join key of the inner table.',
};

export function IndexSuggestionCards({
  items,
  instanceId,
}: {
  items: SuggestionCardItem[];
  instanceId: number;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const cards = useMemo(
    () =>
      items.map((item, index) => ({
        item,
        key: `${item.relation}-${item.columns.join('-')}-${index}`,
      })),
    [items],
  );

  return (
    <div className="flex flex-col gap-[0.875rem]">
      {cards.map(({ item, key }) => {
        const open = openKey === key;
        return (
          <section className="panel border border-border/60" key={key}>
            <button
              type="button"
              className="panel-header w-full cursor-pointer text-left hover:bg-[var(--surface-muted)]"
              onClick={() => setOpenKey(open ? null : key)}
              aria-expanded={open}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="panel-title font-mono">{item.relation}</span>
                <span className="tag tag--muted">Suggestion only</span>
                <span className={`tag ${KIND_TAG[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  {item.columns.join(', ')}
                </span>
              </div>
              <span className="font-mono text-[10px] text-foreground-muted">
                {open ? 'hide evidence ▲' : `show evidence (${item.evidence.length}) ▼`}
              </span>
            </button>

            <div className="panel-body text-[12px]">
              <p className="text-foreground-secondary">{item.reason}</p>
              <div className="mb-1 mt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                Candidate DDL (not executed)
              </div>
              <div className="query-block">{item.ddl}</div>

              {open && (
                <div className="mt-4 border-t border-border pt-3">
                  <div className="mb-3 grid gap-2 xl:grid-cols-2">
                    <div>
                      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                        What this is asking
                      </div>
                      <p>{KIND_ACTION[item.kind]}</p>
                      <p className="mt-1 text-foreground-muted">
                        Not a create button — copy the SQL only if you agree after review.
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                        Before you run anything
                      </div>
                      <p className="text-foreground-muted">{item.caveat}</p>
                    </div>
                  </div>

                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                    Evidence from ANALYZE plans
                  </div>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Query</th>
                          <th>Node</th>
                          <th>Condition</th>
                          <th className="text-right">Discarded</th>
                          <th className="text-right">Returned</th>
                          <th className="text-right">Executions</th>
                          <th className="text-right">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.evidence.map((evidence, rowIndex) => (
                          <tr key={`${evidence.queryid ?? 'manual'}-${rowIndex}`}>
                            <td className="font-mono text-[11px]">
                              {evidence.queryid ? (
                                <a
                                  href={`/instances/${instanceId}/queries/${evidence.queryid}`}
                                  className="text-accent hover:underline"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {evidence.queryid.slice(0, 12)}
                                </a>
                              ) : (
                                'manual'
                              )}
                            </td>
                            <td className="font-mono text-[11px]">{evidence.nodeType}</td>
                            <td className="font-mono text-[11px]" style={{ maxWidth: '22rem' }}>
                              {evidence.predicate}
                            </td>
                            <td className="num">
                              {evidence.rowsRemoved === null
                                ? '·'
                                : formatNumber(evidence.rowsRemoved)}
                            </td>
                            <td className="num">
                              {evidence.rowsReturned === null
                                ? '·'
                                : formatNumber(evidence.rowsReturned)}
                            </td>
                            <td className="num">{formatNumber(evidence.loops ?? 1)}</td>
                            <td className="num">
                              {evidence.selfMs === null
                                ? '·'
                                : formatDuration(evidence.selfMs / 1000)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
