'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { formatAgo } from '@/lib/format';
import type { FleetAlert } from '@/lib/alerts';

function severityClass(severity: string): string {
  if (severity === 'critical') return 'tag tag--error';
  if (severity === 'warning') return 'tag tag--warn';
  return 'tag';
}

export function AlertsTable({ alerts }: { alerts: FleetAlert[] }) {
  const [selected, setSelected] = useState<FleetAlert | null>(null);

  return (
    <>
      <div className="table-scroll" style={{ maxHeight: 'none' }}>
        <table className="data-table data-table--alerts data-table--alerts-compact">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Status</th>
              <th>Instance</th>
              <th>Check</th>
              <th className="num">Seen</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr
                key={alert.alertId}
                className="alerts-table__row"
                tabIndex={0}
                role="button"
                onClick={() => setSelected(alert)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(alert);
                  }
                }}
              >
                <td>
                  <span className={severityClass(alert.severity)}>{alert.severity}</span>
                </td>
                <td>
                  <span className="tag">{alert.status}</span>
                  {alert.status === 'pending' ? (
                    <span className="ml-1 text-[10px] text-foreground-muted">×{alert.pendingCount}</span>
                  ) : null}
                </td>
                <td>
                  <Link
                    href={`/instances/${alert.instanceId}`}
                    className="check-score__instance"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {alert.alias}
                  </Link>
                  <div className="text-[10px] text-foreground-muted">{alert.engine}</div>
                </td>
                <td>
                  <div className="text-[12px] font-medium leading-snug truncate max-w-[28rem]">
                    {alert.title}
                  </div>
                  <div className="font-mono text-[10px] text-foreground-muted truncate max-w-[28rem]">
                    {alert.checkId}
                    {alert.object ? ` · ${alert.object}` : ''}
                  </div>
                </td>
                <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
                  {formatAgo(alert.lastSeenAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={selected !== null}
        title={selected?.title ?? 'Alert'}
        subtitle={
          selected
            ? `${selected.alias} · ${selected.checkId}${selected.object ? ` · ${selected.object}` : ''}`
            : undefined
        }
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="flex flex-wrap gap-2">
              <span className={severityClass(selected.severity)}>{selected.severity}</span>
              <span className="tag">{selected.status}</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                seen {formatAgo(selected.lastSeenAt)}
              </span>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                Detail
              </div>
              <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                {selected.message}
              </p>
            </div>
            {selected.remediation ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                  How to fix
                </div>
                <p className="m-0 text-foreground-secondary leading-snug whitespace-pre-wrap">
                  {selected.remediation}
                </p>
              </div>
            ) : null}
            <div>
              <Link href={`/instances/${selected.instanceId}`} className="btn text-[11px]">
                Open instance
              </Link>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
