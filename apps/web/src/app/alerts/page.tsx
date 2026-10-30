import Link from 'next/link';
import { AlertDayHeat } from '@/components/AlertDayHeat';
import { AlertsTable } from '@/components/AlertsTable';
import { FleetScopeFilters } from '@/components/FleetScopeFilters';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import {
  countOpenAlerts,
  getAlertDayHeatmap,
  listFleetAlerts,
  type FleetAlert,
} from '@/lib/alerts';
import { listScopeChoices, scopeEngines } from '@/lib/fleet-scope';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Alerts · Búho' };

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; engine?: string; conn?: string }>;
}) {
  const { view, engine: engineParam, conn: connParam } = await searchParams;
  const showResolved = view === 'resolved';
  const engine = engineParam ?? '';
  const conn = connParam ?? '';

  let alerts: FleetAlert[];
  let counts: Awaited<ReturnType<typeof countOpenAlerts>>;
  let heatmap: Awaited<ReturnType<typeof getAlertDayHeatmap>>;
  let choices: Awaited<ReturnType<typeof listScopeChoices>> = [];
  try {
    [alerts, counts, heatmap, choices] = await Promise.all([
      listFleetAlerts(showResolved ? ['resolved'] : ['pending', 'firing'], {
        engine: engine || undefined,
        alias: conn || undefined,
      }),
      countOpenAlerts(),
      getAlertDayHeatmap(14),
      listScopeChoices(),
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
            <Link
              className="btn"
              href={(() => {
                const params = new URLSearchParams();
                if (!showResolved) params.set('view', 'resolved');
                if (engine) params.set('engine', engine);
                if (conn) params.set('conn', conn);
                const query = params.toString();
                return query ? `/alerts?${query}` : '/alerts';
              })()}
            >
              {showResolved ? 'Show open' : 'Show resolved'}
            </Link>
            <Link className="btn btn--primary" href="/admin/alerts">
              Configure
            </Link>
          </div>
        </header>

        <FleetScopeFilters
          engines={scopeEngines(choices)}
          instances={choices}
          engine={engine}
          conn={conn}
          preserve={showResolved ? { view: 'resolved' } : undefined}
        />

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
            <AlertsTable alerts={alerts} />
          )}
        </section>
      </div>
    </>
  );
}
