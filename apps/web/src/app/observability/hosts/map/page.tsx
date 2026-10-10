import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { listHostsForMap, listInfraDiscovery } from '@/lib/host-inventory';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Hosts map · Observability · Búho' };

function statusColor(row: {
  sensorsUp: number | null;
  sensorsTotal: number | null;
  hostMetricsAt: Date | null;
}): string {
  if (row.sensorsTotal != null && row.sensorsTotal > 0) {
    if ((row.sensorsUp ?? 0) >= row.sensorsTotal) return '#16a34a';
    if ((row.sensorsUp ?? 0) === 0) return '#dc2626';
    return '#ca8a04';
  }
  if (row.hostMetricsAt) return '#2563eb';
  return '#94a3b8';
}

/**
 * PRTG-style device map + discovery suggestions.
 * ADR buho-infra-prtg-p2-2026-10-10
 */
export default async function ObservabilityHostsMapPage() {
  let nodes;
  let discovery;
  try {
    [nodes, discovery] = await Promise.all([listHostsForMap(), listInfraDiscovery()]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Observability"
        title="Hosts map"
        sub="Device layout by role · discovery suggestions · PRTG-class"
        actions={
          <>
            <Link className="btn" href="/observability/hosts">
              ← Hosts list
            </Link>
            <Link className="btn btn--primary" href="/">
              Databases
            </Link>
          </>
        }
      />

      {nodes.length === 0 ? (
        <ObsEmpty
          title="No hosts to map"
          actions={[{ href: '/observability/hosts', label: 'Hosts', primary: true }]}
        >
          Add infra devices or databases — the map places unique hosts by role.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Fleet map</span>
            <span className="text-[11px] text-foreground-muted">
              green = sensors up · gold = partial · red = down · blue = host metrics only
            </span>
          </div>
          <div className="p-4">
            <svg viewBox="0 0 100 100" className="w-full max-w-3xl mx-auto" role="img">
              <title>Hosts map</title>
              <circle cx="50" cy="50" r="18" fill="none" stroke="currentColor" opacity={0.12} />
              <circle cx="50" cy="50" r="32" fill="none" stroke="currentColor" opacity={0.1} />
              <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" opacity={0.08} />
              {nodes.map((n) => (
                <g key={n.host}>
                  <a href={`/observability/hosts/${encodeURIComponent(n.host)}`}>
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={2.2}
                      fill={statusColor(n)}
                      stroke="currentColor"
                      strokeWidth={0.15}
                      opacity={0.95}
                    />
                    <text
                      x={n.x}
                      y={n.y + 4.2}
                      textAnchor="middle"
                      fontSize="2.2"
                      fill="currentColor"
                      opacity={0.75}
                    >
                      {n.host.length > 18 ? `${n.host.slice(0, 16)}…` : n.host}
                    </text>
                  </a>
                </g>
              ))}
            </svg>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Discovery suggestions</span>
          <span className="text-[11px] text-foreground-muted">
            from <span className="font-mono">infraDiscovery</span> /{' '}
            <span className="font-mono">lab:infra:discover</span>
          </span>
        </div>
        {discovery.length === 0 ? (
          <p className="p-4 text-sm text-foreground-muted">
            No discovery rows yet. Run{' '}
            <span className="font-mono">npm run lab:infra:discover</span> or enable{' '}
            <span className="font-mono">infraDiscovery</span> in config.json.
          </p>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Host</th>
                  <th>ICMP</th>
                  <th>Ports</th>
                  <th>Status</th>
                  <th className="num">Scanned</th>
                </tr>
              </thead>
              <tbody>
                {discovery.map((d) => (
                  <tr key={d.discoveryId}>
                    <td className="font-mono text-[12px]">
                      <Link
                        href={`/observability/hosts/${encodeURIComponent(d.host)}`}
                        className="underline decoration-dotted"
                      >
                        {d.host}
                      </Link>
                    </td>
                    <td>
                      {d.icmpOk
                        ? `up${d.icmpMs != null ? ` · ${Math.round(d.icmpMs)}ms` : ''}`
                        : '—'}
                    </td>
                    <td className="font-mono text-[11px]">
                      {d.openPorts.length ? d.openPorts.join(', ') : '—'}
                    </td>
                    <td>
                      {d.monitored ? (
                        <span className="text-emerald-600">monitored</span>
                      ) : (
                        <span className="text-foreground-muted">suggested</span>
                      )}
                    </td>
                    <td className="num font-mono text-[10px]">{formatAgo(d.scannedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
