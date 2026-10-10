import Link from 'next/link';
import { formatBytes, formatDuration } from '@/lib/format';

export interface SubscriptionRow {
  name: string;
  workerUp: boolean;
  lagSeconds: number | null;
  /** WAL received but not yet applied, measured on this subscriber. */
  lagBytes: number | null;
}

export interface SubscriptionAlert {
  object: string;
  message: string;
}

function lagLabel(row: SubscriptionRow): string {
  if (row.lagBytes === 0 || row.lagSeconds === 0) return 'caught up';
  if (row.lagBytes !== null && row.lagBytes > 0 && row.lagSeconds === null) return formatBytes(row.lagBytes);
  if (row.lagSeconds !== null && row.lagSeconds > 0) return formatDuration(row.lagSeconds);
  return '—';
}

function lagExplanation(row: SubscriptionRow): string {
  if (row.lagBytes === 0 || row.lagSeconds === 0) {
    return ' Apply is caught up: the apply LSN has reached the WAL this server already received.';
  }
  if (row.lagBytes !== null && row.lagBytes > 0) {
    const time = row.lagSeconds !== null && row.lagSeconds > 0 ? ` (${formatDuration(row.lagSeconds)})` : '';
    return ` ${formatBytes(row.lagBytes)} of received WAL is not applied yet${time}.`;
  }
  return ' No received LSN and no apply LSN yet, so this subscriber cannot compute lag.';
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
              <span className="sub-row__lag">{lagLabel(row)}</span>
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
                {lagExplanation(row)}
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
                This lag is measured on the subscriber: WAL already received minus WAL already
                applied (`received_lsn` versus `latest_end_lsn`). The publisher clock is not on
                this server. Slots live on the publisher. Búho does not read pg_subscription, so
                the slot name and the last error text are not on this row.
              </p>
              <Link href={`/instances/${instanceId}/replication`}>Open the replication page</Link>
            </div>
          </details>
        );
      })}
    </div>
  );
}
