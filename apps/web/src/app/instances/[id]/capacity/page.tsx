import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import {
  formatDays,
  getCapacityBudget,
  type CapacityForecast,
} from '@/lib/capacity';
import { formatBytes, formatPct } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function formatValue(f: CapacityForecast): string {
  if (f.current === null) return '—';
  return f.unit === 'bytes' ? formatBytes(f.current) : formatPct(f.current, 1);
}

function capacityChart(f: CapacityForecast): Array<{ bucket: number; [key: string]: number | null }> {
  const rows = new Map<number, { bucket: number; value: number | null; forecast: number | null }>();
  for (const point of f.history) {
    rows.set(point.bucket, { bucket: point.bucket, value: point.value, forecast: null });
  }
  for (const point of f.projection) {
    const existing = rows.get(point.bucket);
    if (existing) existing.forecast = point.value;
    else rows.set(point.bucket, { bucket: point.bucket, value: null, forecast: point.value });
  }
  return [...rows.values()]
    .sort((a, b) => a.bucket - b.bucket)
    .map((row) => ({ bucket: row.bucket, [f.resource]: row.value, forecast: row.forecast }));
}

function formatRate(f: CapacityForecast): string {
  if (f.dailyRate === null) return '—';
  const abs = Math.abs(f.dailyRate);
  const signed = f.dailyRate >= 0 ? '+' : '−';
  return f.unit === 'bytes'
    ? `${signed}${formatBytes(abs)}/d`
    : `${signed}${formatPct(abs, 2)}/d`;
}

export default async function CapacityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  let instance;
  let forecasts: CapacityForecast[];
  try {
    instance = await getInstance(instanceId);
    forecasts = await getCapacityBudget(instanceId, 28);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  // XID is Postgres-only; hide on other engines so we don't invent a signal.
  const visible =
    engine === 'postgres' ? forecasts : forecasts.filter((f) => f.resource !== 'xid');

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Capacity' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Capacity · {instance.alias}</h1>
            <p className="page-sub">
              Early warning for when disk, XID age, CPU, or RAM would hit a limit if today&apos;s
              trend continues.
            </p>
          </div>
          <Link href={`/instances/${instanceId}/analysis`} className="tag tag--muted">
            open series in Analysis
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        {visible.every((f) => f.history.length === 0) ? (
          <section className="panel">
            <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
              No capacity history yet. Disk size comes from engine collectors
              (<code>database_size_bytes</code>); CPU/RAM need <code>hostMetrics</code> on the
              target (Host tab). The first daily rollup appears after the collector has been
              writing samples for an hour.
            </div>
          </section>
        ) : null}

        <div className="grid grid-cols-2 gap-[0.875rem] xl:grid-cols-4">
          {visible.map((f) => (
            <StatCard
              key={f.resource}
              label={f.label}
              value={formatDays(f.daysToExhaust)}
              hint={`${formatValue(f)} · ${formatRate(f)}`}
              tone={f.tone}
            />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          {visible
            .filter((f) => f.resource !== 'disco')
            .map((f) => (
              <section
                key={f.resource}
                className="panel"
                style={{
                  borderLeft: `3px solid ${
                    f.tone === 'error'
                      ? 'var(--error)'
                      : f.tone === 'warn'
                        ? 'var(--warning)'
                        : f.tone === 'ok'
                          ? 'var(--success)'
                          : 'var(--border)'
                  }`,
                }}
              >
                <div className="panel-header">
                  <span className="panel-title">{f.label}</span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    R²={f.rSquared === null ? '—' : f.rSquared.toFixed(2)} · threshold{' '}
                    {f.unit === 'bytes' ? formatBytes(f.threshold) : formatPct(f.threshold, 0)}
                  </span>
                </div>
                <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
                  {f.summary}
                </div>
                {f.history.length > 0 ? (
                  <TimeseriesPanel
                    title=""
                    data={capacityChart(f)}
                    unit={f.unit === 'bytes' ? 'bytes' : 'pct'}
                    height={150}
                    threshold={{
                      value: f.threshold,
                      label: f.unit === 'bytes' ? formatBytes(f.threshold) : formatPct(f.threshold, 0),
                    }}
                    series={[
                      {
                        metric: f.resource,
                        label: f.label,
                        color: '#1f5f8b',
                        filled: true,
                      },
                      {
                        metric: 'forecast',
                        label: 'Projected',
                        color: '#9a4a00',
                        dashed: true,
                      },
                    ]}
                  />
                ) : null}
              </section>
            ))}
        </div>

        {visible
          .filter((f) => f.resource === 'disco')
          .map((f) => (
            <div key={f.resource} className="chart-panel--full mt-[0.875rem]">
              <section
                className="panel"
                style={{
                  borderLeft: `3px solid ${
                    f.tone === 'error'
                      ? 'var(--error)'
                      : f.tone === 'warn'
                        ? 'var(--warning)'
                        : f.tone === 'ok'
                          ? 'var(--success)'
                          : 'var(--border)'
                  }`,
                }}
              >
                <div className="panel-header">
                  <span className="panel-title">{f.label}</span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    R²={f.rSquared === null ? '—' : f.rSquared.toFixed(2)} · threshold{' '}
                    {f.unit === 'bytes' ? formatBytes(f.threshold) : formatPct(f.threshold, 0)}
                  </span>
                </div>
                <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
                  {f.summary}
                </div>
                {f.history.length > 0 ? (
                  <TimeseriesPanel
                    title=""
                    data={capacityChart(f)}
                    unit={f.unit === 'bytes' ? 'bytes' : 'pct'}
                    height={180}
                    threshold={{
                      value: f.threshold,
                      label: f.unit === 'bytes' ? formatBytes(f.threshold) : formatPct(f.threshold, 0),
                    }}
                    series={[
                      {
                        metric: f.resource,
                        label: f.label,
                        color: '#1f5f8b',
                        filled: true,
                      },
                      {
                        metric: 'forecast',
                        label: 'Projected',
                        color: '#9a4a00',
                        dashed: true,
                      },
                    ]}
                  />
                ) : null}
              </section>
            </div>
          ))}
      </div>
    </>
  );
}
