import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  listObservabilityAlerts,
  type ObsAlert,
  type ObsAlertSource,
} from '@/lib/obs-ops';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'App alerts · Observability · Búho' };

function severityClass(severity: string): string {
  if (severity === 'critical') return 'tag tag--error';
  if (severity === 'warning') return 'tag tag--warn';
  return 'tag';
}

function sourceLabel(source: ObsAlertSource): string {
  if (source === 'uptime') return 'Probes';
  if (source === 'apm') return 'APM';
  return 'SLO';
}

export default async function ObservabilityAlertsPage() {
  let alerts: ObsAlert[];
  try {
    alerts = await listObservabilityAlerts();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const warning = alerts.filter((a) => a.severity === 'warning').length;
  const uptime = alerts.filter((a) => a.source === 'uptime').length;
  const apm = alerts.filter((a) => a.source === 'apm').length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="App alerts"
        title="App alerts"
        sub={
          <>
            Probes + APM signals · not Security findings ·{' '}
            <Link href="/observability/security/alerts" className="underline">
              Security alerts
            </Link>
            {' · '}
            <Link href="/alerts" className="underline">
              Databases alerts
            </Link>
          </>
        }
        actions={
          <>
            <Link className="btn" href="/observability/slos">
              SLOs
            </Link>
            <Link className="btn btn--primary" href="/observability/cases">
              App cases
            </Link>
          </>
        }
      />

      <div className="notice">
        <strong>Where to silence?</strong> Three planes (not Kibana’s one Alerts app):{' '}
        <Link href="/alerts" className="underline">
          Databases → Alerts
        </Link>{' '}
        (engine checks / pack) · this page (probe / APM / SLO) ·{' '}
        <Link href="/observability/security/alerts" className="underline">
          Security → Alerts
        </Link>{' '}
        (findings). Silences for DB pack live under Admin → Alerts.
      </div>

      <div className="stat-grid">
        <StatCard label="Critical" value={String(critical)} hint="monitor down / 5xx / errors" />
        <StatCard label="Warning" value={String(warning)} hint="latency / 4xx / elevated errors" />
        <StatCard label="Probes" value={String(uptime)} hint="HTTP probe signals" />
        <StatCard label="APM" value={String(apm)} hint="service error & latency" />
      </div>

      {alerts.length === 0 ? (
        <ObsEmpty
          title="No app alerts"
          actions={[
            { href: '/observability/synthetics', label: 'Probes' },
            { href: '/observability/apm/setup', label: 'Add APM' },
          ]}
        >
          Probes are up and services are within error/latency thresholds.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Active app alerts</span>
            <span className="text-[11px] text-foreground-muted">{alerts.length} shown</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Source</th>
                  <th>Entity</th>
                  <th>Alert</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className={severityClass(a.severity)}>{a.severity}</span>
                    </td>
                    <td>
                      <span className="tag tag--muted">{sourceLabel(a.source)}</span>
                    </td>
                    <td>
                      <Link href={a.href} className="check-score__instance">
                        {a.entity}
                      </Link>
                    </td>
                    <td>
                      <div className="text-[12px] font-medium leading-snug">{a.title}</div>
                      <div className="alerts-table__detail mt-0.5">{a.message}</div>
                    </td>
                    <td className="num font-mono text-[10px] text-foreground-muted whitespace-nowrap">
                      {formatAgo(a.seenAt)}
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
