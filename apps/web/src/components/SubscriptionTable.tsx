'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { formatDuration } from '@/lib/format';

export interface SubscriptionRow {
  name: string;
  workerUp: boolean;
  lagSeconds: number | null;
}

export interface SubscriptionAlert {
  object: string;
  message: string;
}

export function SubscriptionTable({
  instanceId,
  rows,
  alerts,
}: {
  instanceId: number;
  rows: SubscriptionRow[];
  alerts: SubscriptionAlert[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Subscription</th>
          <th className="text-right">Apply lag</th>
          <th className="text-right">Worker</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const expanded = open === row.name;
          const matching = alerts.filter((alert) => alert.object === row.name || alert.message.includes(row.name));
          return (
            <Fragment key={row.name}>
              <tr>
                <td>
                  <button
                    type="button"
                    className="font-mono text-[11.5px] text-left text-accent hover:underline"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : row.name)}
                  >
                    {row.name}
                  </button>
                </td>
                <td className="num font-mono text-[11px]">
                  {row.lagSeconds === null ? '—' : formatDuration(row.lagSeconds)}
                </td>
                <td className="text-right">
                  <span className={`tag ${row.workerUp ? 'tag--ok' : 'tag--error'}`}>
                    {row.workerUp ? 'applying' : 'down'}
                  </span>
                </td>
              </tr>
              {expanded ? (
                <tr key={`${row.name}-detail`}>
                  <td colSpan={3} className="bg-[var(--surface-muted)]">
                    <div className="space-y-2 py-1 text-[11.5px] text-foreground-secondary">
                      <p>
                        {row.workerUp
                          ? 'The latest sample has an apply worker pid. The subscription is applying.'
                          : 'The latest sample has an empty apply worker pid. Nothing is being applied.'}
                        {row.lagSeconds === null
                          ? ' No apply timestamp yet, so lag is unknown.'
                          : ` Apply lag is ${formatDuration(row.lagSeconds)}, measured from latest_end_time.`}
                      </p>
                      <p>
                        Alerts fire only while that pid is empty. This panel is the sample from the last
                        minute. An alert can still be open from an earlier check, or from another
                        subscription, after this one has recovered.
                      </p>
                      {matching.length > 0 ? (
                        <ul className="list-disc pl-4">
                          {matching.map((alert) => (
                            <li key={alert.message}>{alert.message}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No open check right now for {row.name}.</p>
                      )}
                      <p>
                        Slots for this subscription live on the publisher, not here. Búho does not read
                        pg_subscription (the monitor role is usually denied), so the slot name and the
                        last error text are not on this row.
                      </p>
                      <Link href={`/instances/${instanceId}/replication`} className="text-accent hover:underline">
                        Open the replication page
                      </Link>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
