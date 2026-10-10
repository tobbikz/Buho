import Link from 'next/link';
import { FleetLogPatterns } from '@/components/FleetLogPatterns';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  getFleetLogLevelCounts,
  getFleetLogPatterns,
  listFleetLogEvents,
  type FleetLogEvent,
} from '@/lib/logs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Logs · Observability · Búho' };

function levelTag(level: string): string {
  const l = level.toLowerCase();
  if (l === 'fatal' || l === 'panic' || l === 'critical' || l === 'error') return 'tag tag--error';
  if (l === 'warning' || l === 'warn') return 'tag tag--warn';
  return 'tag tag--muted';
}

export default async function ObservabilityLogsPage() {
  let patterns;
  let levelCounts;
  let events: FleetLogEvent[];
  try {
    [patterns, levelCounts, events] = await Promise.all([
      getFleetLogPatterns(24, 40),
      getFleetLogLevelCounts(24),
      listFleetLogEvents(24, 200),
    ]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const errors = levelCounts
    .filter((c) => ['error', 'fatal', 'panic', 'critical'].includes(c.level))
    .reduce((n, c) => n + c.times, 0);
  const warnings = levelCounts
    .filter((c) => c.level === 'warning' || c.level === 'warn')
    .reduce((n, c) => n + c.times, 0);

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Logs"
        title="Logs"
        sub={
          <>
            Database engine logs from monitored instances · last 24h · not app/APM logs ·{' '}
            <Link href="/events" className="underline">
              Databases → Events
            </Link>{' '}
            for acknowledgements
          </>
        }
        actions={
          <Link className="btn" href="/">
            Databases fleet
          </Link>
        }
      />

      <div className="stat-grid">
        <StatCard label="Lines" value={String(events.length)} hint="recent sample" />
        <StatCard label="Errors" value={String(errors)} hint="error/fatal/critical" />
        <StatCard label="Warnings" value={String(warnings)} hint="warn level" />
        <StatCard label="Patterns" value={String(patterns.length)} hint="fingerprints" />
      </div>

      <section className="panel mb-3">
        <div className="panel-header">
          <span className="panel-title">Top patterns</span>
          <span className="text-[11px] text-foreground-muted">last 24h</span>
        </div>
        <div className="panel-body">
          <FleetLogPatterns patterns={patterns} levelCounts={levelCounts} hours={24} />
        </div>
      </section>

      {events.length === 0 ? (
        <ObsEmpty
          title="No database log lines in the last 24h"
          actions={[
            { href: '/', label: 'Open Databases', primary: true },
            { href: '/events', label: 'Databases → Events' },
          ]}
        >
          This page shows <strong>engine logs</strong> (Postgres / MariaDB / MSSQL / …) that the
          collector scraped into <span className="font-mono">buho.log_events</span> — not HTTP
          probe output and not OTLP/APM. Empty usually means the collector is not reading log
          files for your instances yet, or nothing was emitted in the window. Ack stays in
          Databases → Events.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Recent log lines</span>
            <span className="text-[11px] text-foreground-muted">{events.length} shown</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">When</th>
                  <th>Level</th>
                  <th>Instance</th>
                  <th>Kind</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
                      {formatAgo(e.at)}
                    </td>
                    <td>
                      <span className={levelTag(e.level)}>{e.level || '—'}</span>
                    </td>
                    <td>
                      <Link
                        href={`/instances/${e.instanceId}`}
                        className="check-score__instance"
                      >
                        {e.alias}
                      </Link>
                      <div className="text-[10px] text-foreground-muted">{e.engine}</div>
                    </td>
                    <td>
                      <span className="tag tag--muted">{e.kind}</span>
                    </td>
                    <td>
                      <div className="text-[12px] leading-snug break-all">{e.message}</div>
                      {e.database || e.username ? (
                        <div className="font-mono text-[10px] text-foreground-muted mt-0.5">
                          {[e.database, e.username].filter(Boolean).join(' · ')}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
