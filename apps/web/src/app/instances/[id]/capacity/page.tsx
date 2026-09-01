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
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  // XID sólo aplica a PostgreSQL; en otros motores se oculta para no mentir.
  const visible =
    engine === 'postgres' ? forecasts : forecasts.filter((f) => f.resource !== 'xid');

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Flota', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Capacidad' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Capacidad · {instance.alias}</h1>
            <p className="page-sub">
              Proyección lineal sobre el rollup diario de las últimas 4 semanas: disco, XID, CPU y
              RAM. No es un modelo de colas — si la carga no es estable, la fecha se mueve.
            </p>
          </div>
          <Link href={`/instances/${instanceId}/analysis`} className="tag tag--muted">
            ver series en Análisis
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

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

        <div className="flex flex-col gap-[0.875rem]">
          {visible.map((f) => (
            <section key={f.resource} className="panel" style={{ borderLeft: `3px solid ${
              f.tone === 'error' ? 'var(--error)' : f.tone === 'warn' ? 'var(--warning)' : f.tone === 'ok' ? 'var(--success)' : 'var(--border)'
            }` }}>
              <div className="panel-header">
                <span className="panel-title">{f.label}</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  R²={f.rSquared === null ? '—' : f.rSquared.toFixed(2)} · umbral{' '}
                  {f.unit === 'bytes' ? formatBytes(f.threshold) : formatPct(f.threshold, 0)}
                </span>
              </div>
              <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
                {f.summary}
              </div>
              {f.history.length > 0 ? (
                <TimeseriesPanel
                  title=""
                  data={f.history.map((p) => ({
                    bucket: p.bucket,
                    [f.resource]: p.value,
                  }))}
                  unit={f.unit === 'bytes' ? 'bytes' : 'pct'}
                  height={140}
                  series={[
                    {
                      metric: f.resource,
                      label: f.label,
                      color: '#1f5f8b',
                    },
                  ]}
                />
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
