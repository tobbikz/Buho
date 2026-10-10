import Link from 'next/link';
import { AlertDayHeat } from '@/components/AlertDayHeat';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo } from '@/lib/format';
import {
  countOpenAlerts,
  getAlertDayHeatmap,
  listFleetAlerts,
  type FleetAlert,
} from '@/lib/alerts';

export const metadata = { title: 'Alerts · Búho' };

export const dynamic = 'force-dynamic';

function severityClass(severity: string): string {
  if (severity === 'critical') return 'tag tag--error';
  if (severity === 'warning') return 'tag tag--warn';
  return 'tag';
}

function AlertRow({ alert }: { alert: FleetAlert }) {
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
      </td>
      <td className="alerts-table__detail">{alert.message}</td>
      <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
        {formatAgo(alert.lastSeenAt)}
      </td>
    </tr>
  );
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showResolved = view === 'resolved';

  let alerts: FleetAlert[];
  let counts: Awaited<ReturnType<typeof countOpenAlerts>>;
  let heatmap: Awaited<ReturnType<typeof getAlertDayHeatmap>>;
  try {
    [alerts, counts, heatmap] = await Promise.all([
      listFleetAlerts(showResolved ? ['resolved'] : ['pending', 'firing']),
      countOpenAlerts(),
      getAlertDayHeatmap(14),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Alerts' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Alerts' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Alerts</h1>
            <p className="page-sub">
              Findings from checks become alerts with hysteresis, silences, and webhook delivery.
              Configure channels under Admin → Alerts.
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

        <div className="stat-grid">
          <StatCard label="Firing" value={String(counts.firing)} hint="delivered or queued" />
          <StatCard label="Pending" value={String(counts.pending)} hint="waiting for hysteresis" />
          <StatCard label="Critical open" value={String(counts.critical)} hint="pending + firing" />
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
            <span className="panel-title">{showResolved ? 'Recently resolved' : 'Open alerts'}</span>
            <span className="text-[11px] text-foreground-muted">{alerts.length} shown</span>
          </div>
          {alerts.length === 0 ? (
            <p className="p-4 text-[13px] text-foreground-muted">
              {showResolved
                ? 'No resolved alerts yet.'
                : 'No open alerts. Critical findings fire on the first check cycle; warnings need two.'}
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
                    <th className="num">Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => (
                    <AlertRow key={alert.alertId} alert={alert} />
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
