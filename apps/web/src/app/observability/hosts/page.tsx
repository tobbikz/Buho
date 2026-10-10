import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { listHostInventory } from '@/lib/host-inventory';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Hosts · Observability · Búho' };

function pct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)}%`;
}

/**
 * Derived host fleet (ADR buho-host-inventory-derived-2026-10-10).
 * Not Kibana Infra Agents · Halcón archived into Buho vision.
 */
export default async function ObservabilityHostsPage() {
  let rows;
  try {
    rows = await listHostInventory();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const withMetrics = rows.filter((r) => r.hostMetricsAt != null).length;
  const dbHosts = rows.filter((r) => r.roles.includes('database')).length;
  const probeHosts = rows.filter((r) => r.roles.includes('probe')).length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Observability"
        title="Hosts"
        sub="Derived fleet from Databases + Probes · not Elastic Agent inventory"
        actions={
          <>
            <Link className="btn" href="/observability/services">
              Services
            </Link>
            <Link className="btn btn--primary" href="/">
              Databases fleet
            </Link>
          </>
        }
      />

      <div className="notice">
        <strong>Not Kibana Infrastructure → Hosts.</strong> Rows are unique{' '}
        <span className="font-mono">host</span> values from monitored DB instances and endpoint
        probes. White-box CPU/mem/disk appear when <span className="font-mono">hostMetrics</span>{' '}
        is enabled on a target (Databases → Host). Halcón as a separate product is archived — this
        lane is Buho-only.
      </div>

      <div className="stat-grid">
        <StatCard label="Hosts" value={String(rows.length)} hint="unique hostnames/IPs" />
        <StatCard label="With host metrics" value={String(withMetrics)} hint="last 24h scrape" />
        <StatCard label="Database hosts" value={String(dbHosts)} hint="SQL engines" />
        <StatCard label="Probe hosts" value={String(probeHosts)} hint="endpoint targets" />
      </div>

      {rows.length === 0 ? (
        <ObsEmpty
          title="No hosts derived yet"
          actions={[
            { href: '/', label: 'Add a database', primary: true },
            { href: '/observability/synthetics', label: 'Add probe' },
          ]}
        >
          Register a database or probe — hosts are inferred from instance{' '}
          <span className="font-mono">host</span> fields.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Host inventory</span>
            <span className="text-[11px] text-foreground-muted">{rows.length} hosts</span>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Host</th>
                  <th>Role</th>
                  <th>Linked</th>
                  <th className="num">CPU</th>
                  <th className="num">Mem</th>
                  <th className="num">Disk</th>
                  <th className="num">Metrics</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const primaryDb = r.aliases.find((a) => a.engine !== 'endpoint');
                  const primaryProbe = r.aliases.find((a) => a.engine === 'endpoint');
                  return (
                    <tr key={r.host}>
                      <td className="font-mono text-[12px]">
                        {primaryDb ? (
                          <Link
                            href={`/instances/${primaryDb.instanceId}/host`}
                            className="underline decoration-dotted"
                          >
                            {r.host}
                          </Link>
                        ) : (
                          r.host
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {r.roles.map((role) => (
                            <span key={role} className="tag tag--muted">
                              {role}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="text-[11px]">
                        {r.aliases.slice(0, 4).map((a, i) => (
                          <span key={a.instanceId}>
                            {i > 0 ? ' · ' : null}
                            <Link
                              href={
                                a.engine === 'endpoint'
                                  ? `/observability/monitors/${a.instanceId}`
                                  : `/instances/${a.instanceId}`
                              }
                              className="underline"
                            >
                              {a.alias}
                            </Link>
                          </span>
                        ))}
                        {r.aliases.length > 4 ? (
                          <span className="text-foreground-muted"> +{r.aliases.length - 4}</span>
                        ) : null}
                        {!primaryDb && primaryProbe ? (
                          <div className="text-[10px] text-foreground-muted mt-0.5">
                            probe-only · no DB Host tab
                          </div>
                        ) : null}
                      </td>
                      <td className="num font-mono text-[12px]">{pct(r.cpuPct)}</td>
                      <td className="num font-mono text-[12px]">{pct(r.memUsedPct)}</td>
                      <td className="num font-mono text-[12px]">{pct(r.diskUsedPct)}</td>
                      <td className="num font-mono text-[10px] text-foreground-muted">
                        {formatAgo(r.hostMetricsAt)}
                      </td>
                      <td className="num font-mono text-[10px] text-foreground-muted">
                        {formatAgo(r.lastSeenAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
