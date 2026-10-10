import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  listMetricExplorer,
  METRICS_EXPLORER_OPTIONS,
  type MetricExplorerPoint,
} from '@/lib/obs-infra';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Probe metrics · Observability · Búho' };

const WINDOWS = [
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
  { key: '6h', minutes: 360 },
  { key: '24h', minutes: 1440 },
] as const;

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <span className="text-[10px] text-foreground-muted">—</span>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 72;
  const h = 22;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="obs-spark">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts} />
    </svg>
  );
}

function hrefFor(row: MetricExplorerPoint): string {
  return `/observability/services/${encodeURIComponent(row.alias)}?tab=uptime`;
}

export default async function ObservabilityMetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; w?: string }>;
}) {
  const sp = await searchParams;
  const metric =
    METRICS_EXPLORER_OPTIONS.find((m) => m.id === sp.metric)?.id ??
    METRICS_EXPLORER_OPTIONS[0]!.id;
  const requested = WINDOWS.find((w) => w.key === sp.w) ?? WINDOWS[1];

  let rows: MetricExplorerPoint[];
  let window = requested;
  try {
    rows = await listMetricExplorer(metric, requested.minutes);
    // Auto-widen once if the default window is empty but a wider one has data.
    if (!sp.w && rows.length === 0) {
      for (const candidate of WINDOWS.slice(2)) {
        const wider = await listMetricExplorer(metric, candidate.minutes);
        if (wider.length > 0) {
          rows = wider;
          window = candidate;
          break;
        }
      }
    }
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const label = METRICS_EXPLORER_OPTIONS.find((m) => m.id === metric)?.label ?? metric;
  const qs = (next: { metric?: string; w?: string }) => {
    const p = new URLSearchParams({
      metric: next.metric ?? metric,
      w: next.w ?? window.key,
    });
    return `/observability/metrics?${p.toString()}`;
  };

  const freshestTs = rows.reduce<Date | null>((best, r) => {
    if (!r.ts) return best;
    if (!best || r.ts > best) return r.ts;
    return best;
  }, null);
  const aliases = rows.map((r) => r.alias).sort((a, b) => a.localeCompare(b));
  const shownAliases = aliases.slice(0, 8);
  const hiddenAliasCount = Math.max(0, aliases.length - shownAliases.length);

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Metrics"
        title="Probe metrics"
        sub={
          <>
            HTTP / TLS probe series (not Kibana Infra Metrics) · DB host & engine series →{' '}
            <Link href="/" className="underline">
              Databases → Analysis / Host
            </Link>
          </>
        }
        actions={
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <Link
                key={w.key}
                href={qs({ w: w.key })}
                className={`tag ${window.key === w.key ? 'tag--info' : 'tag--muted'}`}
              >
                {w.key}
              </Link>
            ))}
          </div>
        }
      />

      <div className="discover__tabs mb-3" style={{ flexWrap: 'wrap' }}>
        {METRICS_EXPLORER_OPTIONS.map((m) => (
          <Link
            key={m.id}
            href={qs({ metric: m.id })}
            className={`discover__tab ${metric === m.id ? 'is-active' : ''}`}
          >
            {m.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <ObsEmpty
          title={`No samples for ${label}`}
          actions={[
            { href: '/observability/synthetics', label: 'Add probe', primary: true },
            { href: '/observability/services', label: 'Services' },
          ]}
        >
          Nothing in the last {window.key}. Collector must be sampling{' '}
          <span className="font-mono">{metric}</span>, or widen the window.
        </ObsEmpty>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">{label}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {metric} · {window.key} · {rows.length} probes · freshest scrape{' '}
              {freshestTs ? formatAgo(freshestTs) : '—'}
            </span>
          </div>
          <div className="panel-body" style={{ paddingBottom: 0 }}>
            <p className="text-[12px] text-foreground-secondary mb-2">
              Contributing probes ({aliases.length}):{' '}
              {shownAliases.map((alias, i) => (
                <span key={alias}>
                  {i > 0 ? ', ' : null}
                  <Link
                    href={`/observability/services/${encodeURIComponent(alias)}?tab=uptime`}
                    className="underline"
                  >
                    {alias}
                  </Link>
                </span>
              ))}
              {hiddenAliasCount > 0 ? (
                <span className="text-foreground-muted"> +{hiddenAliasCount} more</span>
              ) : null}
            </p>
          </div>
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Engine</th>
                  <th>Host</th>
                  <th className="num">Latest</th>
                  <th>Trend</th>
                  <th className="num">Seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.instanceId}>
                    <td>
                      <Link href={hrefFor(r)} className="check-score__instance">
                        {r.alias}
                      </Link>
                    </td>
                    <td>
                      <span className="tag tag--muted">{r.engine}</span>
                    </td>
                    <td className="font-mono text-[11px]">{r.host}</td>
                    <td className="num font-mono text-[12px]">
                      {r.value == null ? '—' : r.value.toFixed(2)}
                    </td>
                    <td className="text-accent">
                      <Spark values={r.spark} />
                    </td>
                    <td className="num font-mono text-[10px] text-foreground-muted">
                      {formatAgo(r.ts)}
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
