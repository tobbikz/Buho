import Link from 'next/link';
import { silenceOpenAlert } from '@/app/alerts/actions';
import { AlertDayHeat } from '@/components/AlertDayHeat';
import { AlertPlanesNotice } from '@/components/AlertPlanesNotice';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { alertDeepLink } from '@/lib/alert-deep-link';
import { formatAgo } from '@/lib/format';
import { findingLane } from '@/lib/health-posture';
import {
  countOpenAlerts,
  getAlertDayHeatmap,
  listFleetAlerts,
  type FleetAlert,
} from '@/lib/alerts';

export const metadata = { title: 'Alerts · Búho' };

export const dynamic = 'force-dynamic';

type LaneView = 'live' | 'posture' | 'all';

function severityClass(severity: string): string {
  if (severity === 'critical') return 'tag tag--error';
  if (severity === 'warning') return 'tag tag--warn';
  return 'tag';
}

function AlertRow({ alert, lane }: { alert: FleetAlert; lane: LaneView }) {
  const rowLane = findingLane(alert.checkId);
  const deep = alertDeepLink(alert.instanceId, alert.checkId);
  return (
    <tr>
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
        <Link href={`/instances/${alert.instanceId}`} className="check-score__instance">
          {alert.alias}
        </Link>
        <div className="text-[10px] text-foreground-muted">{alert.engine}</div>
      </td>
      <td>
        <div className="text-[12px] font-medium leading-snug">{alert.title}</div>
        <div className="font-mono text-[10px] text-foreground-muted break-all">
          {alert.checkId}
          {alert.object ? ` · ${alert.object}` : ''}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className={`tag ${rowLane === 'live' ? 'tag--error' : 'tag--muted'}`}>
            {rowLane === 'live' ? 'live' : 'posture'}
          </span>
          <Link href={deep.href} className="tag tag--info">
            {deep.label}
          </Link>
          <Link href={`/instances/${alert.instanceId}/blame`} className="tag tag--muted">
            Blame
          </Link>
        </div>
      </td>
      <td className="alerts-table__detail">{alert.message}</td>
      <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
        <div>{formatAgo(alert.lastSeenAt)}</div>
        {alert.status !== 'resolved' ? (
          <div className="mt-1 flex flex-wrap justify-end gap-1">
            {[1, 4, 24].map((hours) => (
              <form key={hours} action={silenceOpenAlert}>
                <input type="hidden" name="instanceId" value={alert.instanceId} />
                <input type="hidden" name="checkId" value={alert.checkId} />
                <input type="hidden" name="lane" value={lane} />
                <input type="hidden" name="hours" value={hours} />
                <button
                  type="submit"
                  className="btn btn--sm"
                  title={`Silence this check for ${hours} hour${hours === 1 ? '' : 's'}`}
                >
                  {hours}h
                </button>
              </form>
            ))}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function laneLink(lane: LaneView, showResolved: boolean): string {
  const params = new URLSearchParams();
  if (showResolved) params.set('view', 'resolved');
  if (lane !== 'live') params.set('lane', lane);
  const q = params.toString();
  return q ? `/alerts?${q}` : '/alerts';
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; lane?: string; ok?: string; error?: string }>;
}) {
  const { view, lane: laneParam, ok, error } = await searchParams;
  const showResolved = view === 'resolved';
  const lane: LaneView =
    laneParam === 'posture' || laneParam === 'all' ? laneParam : 'live';

  let alerts: FleetAlert[];
  let counts: Awaited<ReturnType<typeof countOpenAlerts>>;
  let heatmap: Awaited<ReturnType<typeof getAlertDayHeatmap>>;
  try {
    [alerts, counts, heatmap] = await Promise.all([
      listFleetAlerts(showResolved ? ['resolved'] : ['pending', 'firing']),
      countOpenAlerts(),
      getAlertDayHeatmap(14),
    ]);
  } catch (err) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Alerts' }]} />
        <div className="page">
          <StoreError message={err instanceof Error ? err.message : String(err)} />
        </div>
      </>
    );
  }

  const liveAlerts = alerts.filter((a) => findingLane(a.checkId) === 'live');
  const postureAlerts = alerts.filter((a) => findingLane(a.checkId) === 'posture');
  const shown =
    lane === 'live' ? liveAlerts : lane === 'posture' ? postureAlerts : alerts;

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Alerts' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Alerts</h1>
            <p className="page-sub">
              Live = page for load/locks/cache. Posture = backups/HA/RPO/host/config — harden later.
              Silence 1h / 4h / 24h from the row; channels under Admin → Alerts.
            </p>
          </div>
          <div className="page-header__actions">
            <Link className="btn" href={showResolved ? '/alerts' : '/alerts?view=resolved'}>
              {showResolved ? 'Show open' : 'Show resolved'}
            </Link>
            <Link className="btn btn--primary" href="/admin/alerts">
              Configure
            </Link>
          </div>
        </header>

        {ok === 'silenced' ? (
          <div className="notice">Silence created. Collector will skip matching fires until it ends.</div>
        ) : null}
        {error ? <div className="notice notice--warn">Could not create silence — try again from the row.</div> : null}

        <AlertPlanesNotice active="databases" />

        <div className="stat-grid">
          <StatCard
            label="Live open"
            value={String(liveAlerts.length)}
            hint="load / locks / cache"
            tone={liveAlerts.some((a) => a.severity === 'critical') ? 'error' : 'ok'}
          />
          <StatCard
            label="Posture open"
            value={String(postureAlerts.length)}
            hint="backups / HA / RPO / host / config"
            tone={postureAlerts.length > 0 ? 'warn' : 'ok'}
          />
          <StatCard label="Firing (all)" value={String(counts.firing)} hint="delivered or queued" />
          <StatCard label="Pending" value={String(counts.pending)} hint="waiting for hysteresis" />
        </div>

        {!showResolved && postureAlerts.length > 0 && lane === 'live' ? (
          <div className="notice">
            {postureAlerts.length} posture alert{postureAlerts.length === 1 ? '' : 's'} hidden —{' '}
            <Link href={laneLink('posture', false)} className="link">
              show posture
            </Link>{' '}
            or{' '}
            <Link href={laneLink('all', false)} className="link">
              show all
            </Link>
            .
          </div>
        ) : null}

        <div className="discover__tabs mb-3">
          {(
            [
              ['live', `Live (${liveAlerts.length})`],
              ['posture', `Posture (${postureAlerts.length})`],
              ['all', `All (${alerts.length})`],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={laneLink(key, showResolved)}
              className={`discover__tab ${lane === key ? 'is-active' : ''}`}
            >
              {label}
            </Link>
          ))}
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Alert × day</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              fire events · last 14 days
            </span>
          </div>
          <div className="panel-body">
            <AlertDayHeat data={heatmap} />
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {showResolved
                ? 'Recently resolved'
                : lane === 'live'
                  ? 'Open · live'
                  : lane === 'posture'
                    ? 'Open · posture'
                    : 'Open alerts'}
            </span>
            <span className="text-[11px] text-foreground-muted">{shown.length} shown</span>
          </div>
          {shown.length === 0 ? (
            <p className="p-4 text-[13px] text-foreground-muted">
              {showResolved
                ? 'No resolved alerts yet.'
                : lane === 'live'
                  ? 'No live alerts. Posture (backups/RPO/host) may still be open — switch tab above.'
                  : 'No open alerts in this lane.'}
            </p>
          ) : (
            <div className="table-scroll" style={{ maxHeight: 'none' }}>
              <table className="data-table data-table--alerts">
                <colgroup>
                  <col className="alerts-col--sev" />
                  <col className="alerts-col--status" />
                  <col className="alerts-col--instance" />
                  <col className="alerts-col--check" />
                  <col className="alerts-col--detail" />
                  <col className="alerts-col--seen" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Instance</th>
                    <th>Check</th>
                    <th>Detail</th>
                    <th className="num">Seen / act</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((alert) => (
                    <AlertRow key={alert.alertId} alert={alert} lane={lane} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
