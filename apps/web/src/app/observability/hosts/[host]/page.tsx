import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { getHostDetail } from '@/lib/host-inventory';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ host: string }> };

function pct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)}%`;
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-foreground-muted">—</span>;
  const w = 120;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts} opacity={0.85} />
    </svg>
  );
}

export async function generateMetadata({ params }: Props) {
  const { host: raw } = await params;
  const host = decodeURIComponent(raw);
  return { title: `${host} · Hosts · Observability · Búho` };
}

/**
 * PRTG-style device drill-down: sensors + host KPIs.
 * ADR buho-infra-prtg-sensors-2026-10-10
 */
export default async function ObservabilityHostDetailPage({ params }: Props) {
  const { host: raw } = await params;
  const host = decodeURIComponent(raw);

  let detail;
  try {
    detail = await getHostDetail(host);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  if (!detail.inventory) notFound();
  const { inventory: inv, sensors, sparks, traps } = detail;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Observability"
        title={host}
        sub="Device · sensors (PRTG-class) · not Elastic Agent"
        actions={
          <>
            <Link className="btn" href="/observability/hosts">
              ← Hosts
            </Link>
            <Link className="btn btn--primary" href="/observability/synthetics">
              Probes
            </Link>
          </>
        }
      />

      <div className="stat-grid">
        <StatCard label="CPU" value={pct(inv.cpuPct)} hint="host_cpu_pct" />
        <StatCard label="Memory" value={pct(inv.memUsedPct)} hint="host_mem_used_pct" />
        <StatCard label="Disk" value={pct(inv.diskUsedPct)} hint="host_disk_used_pct" />
        <StatCard
          label="Sensors"
          value={
            inv.sensorsTotal != null
              ? `${inv.sensorsUp ?? 0}/${inv.sensorsTotal}`
              : '—'
          }
          hint="infra sensor_ok · 15m"
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Trends · 6h</span>
        </div>
        <div className="table-scroll" style={{ maxHeight: 'none' }}>
          <table className="data-table">
            <tbody>
              <tr>
                <td>CPU</td>
                <td>
                  <Spark values={sparks.cpu} />
                </td>
              </tr>
              <tr>
                <td>Memory</td>
                <td>
                  <Spark values={sparks.mem} />
                </td>
              </tr>
              <tr>
                <td>Disk</td>
                <td>
                  <Spark values={sparks.disk} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Sensors</span>
          <span className="text-[11px] text-foreground-muted">{sensors.length} sensors</span>
        </div>
        {sensors.length === 0 ? (
          <p className="p-4 text-sm text-foreground-muted">
            No <span className="font-mono">engine=infra</span> sensor samples yet. Add an infra
            device in <span className="font-mono">config.json</span> with{' '}
            <span className="font-mono">infra.sensors[]</span> (see lab/infra) or link a database
            Host tab for white-box CPU/mem/disk.
          </p>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th>Type</th>
                  <th>Device</th>
                  <th>Status</th>
                  <th className="num">ms</th>
                  <th>Metrics</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {sensors.map((s) => (
                  <tr key={`${s.instanceId}-${s.sensorId}`}>
                    <td className="font-mono text-[12px]">{s.sensorId}</td>
                    <td>{s.sensorType}</td>
                    <td className="font-mono text-[12px]">{s.alias}</td>
                    <td>
                      {s.ok == null ? (
                        <span className="text-foreground-muted">—</span>
                      ) : s.ok ? (
                        <span className="text-emerald-600">Up</span>
                      ) : (
                        <span className="text-red-600">Down</span>
                      )}
                    </td>
                    <td className="num">
                      {s.durationMs != null ? Math.round(s.durationMs) : '—'}
                    </td>
                    <td className="text-[11px] text-foreground-muted">
                      {s.metrics
                        .slice(0, 4)
                        .map((m) => `${m.metric.replace(/^sensor_/, '')}=${Math.round(m.value)}`)
                        .join(' · ') || '—'}
                    </td>
                    <td className="num">{formatAgo(s.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">SNMP traps</span>
          <span className="text-[11px] text-foreground-muted">{traps.length} recent</span>
        </div>
        {traps.length === 0 ? (
          <p className="p-4 text-sm text-foreground-muted">
            No traps from this address. Enable{' '}
            <span className="font-mono">infraTraps</span> on the collector (UDP, default 1162) and
            point devices here.
          </p>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>OID</th>
                  <th>Community</th>
                  <th className="num">Port</th>
                </tr>
              </thead>
              <tbody>
                {traps.map((t) => (
                  <tr key={t.trapId}>
                    <td className="font-mono text-[11px]">{formatAgo(t.receivedAt)}</td>
                    <td className="font-mono text-[11px]">{t.oid ?? '—'}</td>
                    <td>{t.community ?? '—'}</td>
                    <td className="num">{t.sourcePort}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Linked instances</span>
        </div>
        <ul className="p-4 text-sm space-y-1">
          {inv.aliases.map((a) => (
            <li key={`${a.instanceId}-${a.alias}`}>
              <span className="font-mono">{a.alias}</span> · {a.engine}
              {a.engine !== 'endpoint' && a.engine !== 'infra' ? (
                <>
                  {' '}
                  ·{' '}
                  <Link
                    className="underline decoration-dotted"
                    href={`/instances/${a.instanceId}/host`}
                  >
                    Host tab
                  </Link>
                </>
              ) : null}
              {a.engine === 'endpoint' ? (
                <>
                  {' '}
                  ·{' '}
                  <Link
                    className="underline decoration-dotted"
                    href={`/observability/monitors/${a.instanceId}`}
                  >
                    Probe
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
