'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { formatAgo, formatBytes, formatNumber } from '@/lib/format';
import type { IndexRow } from '@/lib/indexes';
import type { IndexStatus } from '@buho/core';

const STATUS_LABEL: Record<IndexStatus, string> = {
  ok: 'Healthy',
  unused: 'Unused',
  redundant: 'Redundant',
  invalid: 'Invalid',
};

const STATUS_TAG: Record<IndexStatus, string> = {
  ok: 'tag--ok',
  unused: 'tag--warn',
  redundant: 'tag--warn',
  invalid: 'tag--error',
};

function rowKey(row: IndexRow): string {
  return `${row.schema}.${row.table}.${row.name}`;
}

export function IndexInventoryTable({
  rows,
  instanceId,
}: {
  rows: IndexRow[];
  instanceId: number;
  /** retained for call-site compat; paging is server-side on the indexes page */
  pageSize?: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = selectedKey ? rows.find((row) => rowKey(row) === selectedKey) ?? null : null;

  if (rows.length === 0) {
    return <div className="empty">No indexes in this category.</div>;
  }

  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Index</th>
              <th style={{ width: '6.5rem' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  className="cursor-pointer"
                  onClick={() => setSelectedKey(key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedKey(key);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Details for ${row.name}`}
                >
                  <td className="font-mono text-[11px]">
                    <span className="underline decoration-dotted underline-offset-2">{row.name}</span>
                    <div className="mt-0.5 text-[10px] text-foreground-muted">
                      {row.schema}.{row.table}
                    </div>
                  </td>
                  <td>
                    <span className={`tag ${STATUS_TAG[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal
        open={selected !== null}
        title={selected?.name ?? 'Index'}
        subtitle={
          selected
            ? `${selected.schema}.${selected.table} · ${STATUS_LABEL[selected.status]}`
            : undefined
        }
        size="default"
        onClose={() => setSelectedKey(null)}
      >
        {selected ? (
          <div className="grid gap-4 text-[12px]">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">Size</div>
                <div className="font-mono">{formatBytes(selected.sizeBytes)}</div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">Scans</div>
                <div className="font-mono">{formatNumber(selected.idxScan)}</div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">Columns</div>
                <div className="font-mono text-[11px]">{selected.columns.join(', ') || '·'}</div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">Flags</div>
                <div className="font-mono text-[11px] text-foreground-secondary">
                  {[
                    selected.isPrimary ? 'PRIMARY KEY' : null,
                    selected.isUnique && !selected.isPrimary ? 'UNIQUE' : null,
                    selected.isPartial ? 'partial' : null,
                    selected.hasExpression ? 'expression' : null,
                    selected.isValid ? null : 'INVALID',
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'none'}
                </div>
              </div>
            </div>

            {selected.coveredBy ? (
              <p className="text-[11px] text-foreground-muted">
                Covered by <span className="font-mono">{selected.coveredBy}</span>
              </p>
            ) : null}

            <p className="text-[11px] text-foreground-muted">
              Tuples read {formatNumber(selected.idxTupRead)} · fetched{' '}
              {formatNumber(selected.idxTupFetch)} · captured {formatAgo(selected.capturedAt)}
            </p>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">
                Definition
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[3px] border border-border bg-[var(--surface)] p-2 font-mono text-[10.5px] leading-relaxed">
                {selected.definition ?? '·'}
              </pre>
            </div>

            <p>
              <Link href={`/instances/${instanceId}/orm`} className="text-accent underline">
                Open ORM map
              </Link>
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
