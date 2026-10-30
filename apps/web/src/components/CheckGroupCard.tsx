'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Modal } from '@/components/Modal';
import { Pager, slicePage } from '@/components/Pager';
import { formatNumber } from '@/lib/format';
import type { CheckGroup, CheckOccurrence } from '@/lib/checks';

export type CheckGroupView = Omit<CheckGroup, 'occurrences'> & {
  occurrences: Omit<CheckOccurrence, 'ts'>[];
};

const ROWS_PER_PAGE = 12;

const SEVERITY_TAG = {
  critical: 'tag--error',
  warning: 'tag--warn',
  info: 'tag--info',
} as const;

const SEVERITY_LABEL = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
} as const;

const SEVERITY_STRIPE = {
  critical: 'check-card--critical',
  warning: 'check-card--warning',
  info: 'check-card--info',
} as const;

export function CheckGroupCard({ group }: { group: CheckGroupView }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const rows = slicePage(group.occurrences, page, ROWS_PER_PAGE);
  const distinctGroups = new Set(group.occurrences.map((entry) => entry.group ?? ''));
  const showGroupHeaders = distinctGroups.size > 1;

  return (
    <>
      <button
        type="button"
        className={`check-card check-card--button ${SEVERITY_STRIPE[group.severity]}`}
        onClick={() => {
          setPage(1);
          setOpen(true);
        }}
      >
        <span className={`tag ${SEVERITY_TAG[group.severity]}`}>
          {SEVERITY_LABEL[group.severity]}
        </span>
        <div className="check-card__main">
          <span className="check-card__title">{group.title}</span>
          <span className="check-card__id">{group.checkId}</span>
        </div>
        <div className="check-card__meta">
          <span className="check-card__reach">
            {group.instances} instance{group.instances === 1 ? '' : 's'}
            {group.findings > group.instances ? ` · ${group.findings} findings` : ''}
          </span>
          {group.instances > 1 ? <span className="check-card__platform">platform-wide</span> : null}
        </div>
        <span className="check-card__open-hint" aria-hidden>
          Details
        </span>
      </button>

      <Modal
        open={open}
        title={group.title}
        subtitle={`${group.checkId} · ${group.instances} instance${group.instances === 1 ? '' : 's'}`}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col gap-3 text-[12px]">
          <div className="flex flex-wrap gap-2">
            <span className={`tag ${SEVERITY_TAG[group.severity]}`}>
              {SEVERITY_LABEL[group.severity]}
            </span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {group.findings} finding{group.findings === 1 ? '' : 's'}
            </span>
          </div>

          <div className="table-scroll border border-[var(--border)]">
            <table className="data-table data-table--checks">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Object</th>
                  <th>Finding</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry, index) => {
                  const previous = rows[index - 1];
                  const groupLabel = entry.group ?? 'No group';
                  const showHeader =
                    showGroupHeaders &&
                    (index === 0 || (previous?.group ?? 'No group') !== groupLabel);
                  return (
                    <Fragment key={`${entry.instanceId}:${entry.object ?? ''}:${index}`}>
                      {showHeader ? (
                        <tr className="check-card__group-row">
                          <td colSpan={4}>{groupLabel}</td>
                        </tr>
                      ) : null}
                      <tr>
                        <td>
                          <Link
                            href={`/instances/${entry.instanceId}`}
                            className="check-card__instance"
                          >
                            {entry.alias}
                          </Link>
                          <span className="check-card__context">
                            {entry.group ?? entry.environment}
                          </span>
                        </td>
                        <td className="font-mono text-[11px] text-foreground-secondary">
                          {entry.object ?? '—'}
                        </td>
                        <td className="text-[11.5px] leading-snug text-foreground-secondary">
                          {entry.message}
                        </td>
                        <td className="num font-mono text-[11px]">
                          {entry.value === null
                            ? '—'
                            : formatNumber(Math.round(entry.value * 100) / 100)}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pager
            page={page}
            total={group.occurrences.length}
            size={ROWS_PER_PAGE}
            onPage={setPage}
            label={`${group.title} instances`}
          />

          {group.remediation ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                How to fix
              </div>
              <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                {group.remediation}
              </p>
            </div>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
