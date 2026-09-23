'use client';

import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
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

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export function IndexInventoryTable({
  rows,
  instanceId,
  pageSize = 25,
}: {
  rows: IndexRow[];
  instanceId: number;
  pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(
    PAGE_SIZE_OPTIONS.includes(pageSize as (typeof PAGE_SIZE_OPTIONS)[number])
      ? (pageSize as (typeof PAGE_SIZE_OPTIONS)[number])
      : 25,
  );
  const [openKey, setOpenKey] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const safePage = Math.min(page, totalPages - 1);

  const pageRows = useMemo(() => {
    const start = safePage * size;
    return rows.slice(start, start + size);
  }, [rows, safePage, size]);

  if (rows.length === 0) {
    return <div className="empty">No indexes in this category.</div>;
  }

  return (
    <div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Index</th>
              <th>Table</th>
              <th>Columns</th>
              <th className="text-right">Size</th>
              <th className="text-right">Scans</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const key = `${row.schema}.${row.table}.${row.name}`;
              const open = openKey === key;
              return (
                <Fragment key={key}>
                  <tr
                    className="cursor-pointer hover:bg-[var(--surface-muted)]"
                    onClick={() => setOpenKey(open ? null : key)}
                    aria-expanded={open}
                  >
                    <td className="font-mono text-[11px]">
                      <span className="mr-1 text-foreground-muted">{open ? '▾' : '▸'}</span>
                      {row.name}
                    </td>
                    <td className="font-mono text-[11px]">
                      {row.schema}.{row.table}
                    </td>
                    <td className="font-mono text-[11px]">{row.columns.join(', ') || '·'}</td>
                    <td className="num">{formatBytes(row.sizeBytes)}</td>
                    <td className="num">{formatNumber(row.idxScan)}</td>
                    <td>
                      <span className={`tag ${STATUS_TAG[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="bg-[var(--surface-muted)]">
                      <td colSpan={6} className="!whitespace-normal p-3 text-[12px]">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">
                              Flags
                            </div>
                            <div className="font-mono text-[11px] text-foreground-secondary">
                              {[
                                row.isPrimary ? 'PRIMARY KEY' : null,
                                row.isUnique && !row.isPrimary ? 'UNIQUE' : null,
                                row.isPartial ? 'partial' : null,
                                row.hasExpression ? 'expression' : null,
                                row.isValid ? null : 'INVALID',
                              ]
                                .filter(Boolean)
                                .join(' · ') || 'none'}
                            </div>
                            {row.coveredBy ? (
                              <p className="mt-2 text-[11px] text-foreground-muted">
                                Covered by <span className="font-mono">{row.coveredBy}</span>
                              </p>
                            ) : null}
                            <p className="mt-2 text-[11px] text-foreground-muted">
                              Tuples read {formatNumber(row.idxTupRead)} · fetched{' '}
                              {formatNumber(row.idxTupFetch)} · captured {formatAgo(row.capturedAt)}
                            </p>
                            <p className="mt-2">
                              <Link
                                href={`/instances/${instanceId}/orm`}
                                className="text-accent underline"
                              >
                                Open ORM map
                              </Link>
                            </p>
                          </div>
                          <div>
                            <div className="mb-1 text-[10px] uppercase tracking-wide text-foreground-muted">
                              Definition
                            </div>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-[3px] border border-border bg-[var(--surface)] p-2 font-mono text-[10.5px] leading-relaxed">
                              {row.definition ?? '·'}
                            </pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-foreground-muted">
        <span>
          Showing {formatNumber(safePage * size + 1)}–
          {formatNumber(Math.min(rows.length, (safePage + 1) * size))} of {formatNumber(rows.length)}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1">
            Per page
            <select
              className="input py-0.5"
              value={size}
              onChange={(event) => {
                setSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
                setPage(0);
              }}
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Prev
          </button>
          <span className="font-mono">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
