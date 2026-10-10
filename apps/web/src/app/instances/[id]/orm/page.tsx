import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { OrmExplorer } from '@/components/OrmExplorer';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber } from '@/lib/format';
import { type Unit } from '@/lib/units';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { getOrmModel } from '@/lib/orm';
import type { OrmLayer } from '@/lib/orm-types';
import type { FlowWeight } from '@buho/core';

export const dynamic = 'force-dynamic';

const WEIGHTS: { key: FlowWeight; label: string }[] = [
  { key: 'rows', label: 'Rows' },
  { key: 'time', label: 'Time' },
  { key: 'calls', label: 'Calls' },
];

const WINDOWS: { key: string; label: string; minutes: number }[] = [
  { key: '1h', label: '1 h', minutes: 60 },
  { key: '6h', label: '6 h', minutes: 360 },
  { key: '24h', label: '24 h', minutes: 1440 },
  { key: '7d', label: '7 d', minutes: 10080 },
];

const LAYERS: { key: OrmLayer; label: string; hint: string }[] = [
  { key: 'estructura', label: 'Structure', hint: 'schemas, tables, foreign keys' },
  { key: 'trafico', label: 'Traffic', hint: 'attributed traffic between related tables' },
  { key: 'ambos', label: 'Both', hint: 'structure + traffic on FK edges' },
];

async function OrmBody({
  instanceId,
  engine,
  weight,
  window,
  layer,
  unit,
}: {
  instanceId: number;
  engine: string;
  weight: FlowWeight;
  window: { key: string; label: string; minutes: number };
  layer: OrmLayer;
  unit: Unit;
}) {
  const includeTraffic = layer !== 'estructura';
  const model = await getOrmModel(instanceId, window.minutes, weight, engine, { includeTraffic });

  return (
    <>
      <div className="stat-grid">
        <StatCard label="Schemas" value={formatNumber(model.schemas.length)} hint="in catalog" />
        <StatCard label="Tables" value={formatNumber(model.totalTables)} hint="user tables" />
        <StatCard
          label="Foreign keys"
          value={formatNumber(model.foreignKeys)}
          hint={
            model.foreignKeys === 0
              ? engine === 'postgres'
                ? 'next vacuum scan'
                : 'none in catalog yet'
              : 'structural links'
          }
        />
        <StatCard
          label="Tables with traffic"
          value={formatNumber(model.attributedTables)}
          hint={includeTraffic ? `window ${window.label}` : 'enable Traffic or Both'}
          tone={model.attributedTables > 0 ? 'accent' : 'neutral'}
        />
      </div>

      <section className="panel">
        <OrmExplorer
          model={model}
          instanceId={instanceId}
          unit={unit}
          initialLayer={layer}
          weight={weight}
          windowKey={window.key}
        />
      </section>
    </>
  );
}

export default async function OrmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ peso?: string; v?: string; capa?: string; schema?: string }>;
}) {
  const { id } = await params;
  const { peso, v, capa } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  if (engine !== 'postgres' && engine !== 'mssql' && engine !== 'mariadb' && engine !== 'oracle')
    notFound();

  const weight = (WEIGHTS.find((w) => w.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((w) => w.key === v) ?? WINDOWS[2]!;
  const layer = (LAYERS.find((l) => l.key === capa)?.key ?? 'estructura') as OrmLayer;
  const unit: Unit = weight === 'time' ? 'ms' : 'count';

  let instance;
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();
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

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'ORM' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">ORM map · {instance.alias}</h1>
            <p className="page-sub">
              Database catalog as a graph: <strong>schemas</strong>, <strong>tables</strong>, and{' '}
              <strong>foreign-key relationships</strong>. Structure loads first; switch to Traffic or Both
              for attributed heat. For the write/read Sankey, use{' '}
              <Link href={`/instances/${instanceId}/flow`} className="underline">
                Flow
              </Link>
              .
            </p>
          </div>
          <div className="flex items-center gap-1">
            <span className="tag tag--info">Catalog</span>
            <Link href={`/instances/${instanceId}/topology`} className="tag tag--muted">
              Topology
            </Link>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        <Suspense
          fallback={
            <section className="panel">
              <div className="empty" style={{ height: 280 }}>
                Loading catalog graph…
              </div>
            </section>
          }
        >
          <OrmBody
            instanceId={instanceId}
            engine={engine}
            weight={weight}
            window={window}
            layer={layer}
            unit={unit}
          />
        </Suspense>
      </div>
    </>
  );
}
