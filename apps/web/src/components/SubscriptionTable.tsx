import Link from 'next/link';
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

/**
 * Native <details>, not a React click handler. The row opens even when the
 * client bundle has not hydrated, which is what the overview panel needs.
 */
export function SubscriptionTable({
  instanceId,
  rows,
  alerts,
}: {
  instanceId: number;
  rows: SubscriptionRow[];
  alerts: SubscriptionAlert[];
}) {
  return (
    <div className="sub-list">
      <div className="sub-list__head">
        <span />
        <span>Subscription</span>
        <span className="sub-list__lag">Apply lag</span>
        <span className="sub-list__worker">Worker</span>
      </div>
      {rows.map((row) => {
        const matching = alerts.filter(
          (alert) => alert.object === row.name || alert.message.includes(row.name),
        );
        return (
          <details key={row.name} className="sub-row">
            <summary className="sub-row__summary">
              <span className="sub-row__chevron" aria-hidden />
              <span className="sub-row__name">{row.name}</span>
              <span className="sub-row__lag">{row.lagSeconds === null ? '—' : formatDuration(row.lagSeconds)}</span>
              <span className="sub-row__worker">
                <span className={`tag ${row.workerUp ? 'tag--ok' : 'tag--error'}`}>
                  {row.workerUp ? 'applying' : 'down'}
                </span>
              </span>
            </summary>
            <div className="sub-row__body">
              <p>
                {row.workerUp
                  ? 'The latest sample has an apply worker pid. The subscription is applying.'
                  : 'The latest sample has an empty apply worker pid. Nothing is being applied.'}
                {row.lagSeconds === null
                  ? ' No apply timestamp yet, so lag is unknown.'
                  : ` Apply lag is ${formatDuration(row.lagSeconds)}, measured from latest_end_time.`}
              </p>
              <p>
                Alerts fire only while that pid is empty. This row is the sample from the last minute.
                An alert can still be open from an earlier check, or from another subscription, after
                this one has recovered.
              </p>
              {matching.length > 0 ? (
                <ul>
                  {matching.map((alert) => (
                    <li key={alert.message}>{alert.message}</li>
                  ))}
                </ul>
              ) : (
                <p>No open check right now for {row.name}.</p>
              )}
              <p>
                Slots for this subscription live on the publisher, not here. Búho does not read
                pg_subscription (the monitor role is usually denied), so the slot name and the last
                error text are not on this row.
              </p>
              <Link href={`/instances/${instanceId}/replication`}>Open the replication page</Link>
            </div>
          </details>
        );
      })}
    </div>
  );
}
