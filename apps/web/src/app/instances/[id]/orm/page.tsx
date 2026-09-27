import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { OrmGraph } from '@/components/OrmGraph';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber } from '@/lib/format';
import { formatUnit, type Unit } from '@/lib/units';
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
  { key: 'ambos', label: 'Both', hint: 'structure + traffic on FK edges' },
  { key: 'estructura', label: 'Structure', hint: 'schemas, tables, foreign keys' },
  { key: 'trafico', label: 'Traffic', hint: 'attributed traffic between related tables' },
];

export default async function OrmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ peso?: string; v?: string; capa?: string; schema?: string }>;
}) {
  const { id } = await params;
  const { peso, v, capa, schema: schemaParam } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  if (engine !== 'postgres' && engine !== 'mssql' && engine !== 'mariadb') notFound();

  const weight = (WEIGHTS.find((w) => w.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((w) => w.key === v) ?? WINDOWS[2]!;
  const layer = (LAYERS.find((l) => l.key === capa)?.key ?? 'ambos') as OrmLayer;
  const unit: Unit = weight === 'time' ? 'ms' : 'count';

  let instance;
  let model;
  let schemaChoices: string[] = [];
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();
    model = await getOrmModel(instanceId, window.minutes, weight, engine);
    schemaChoices = model.schemas.map((schema) => schema.name);
    const picked = schemaChoices.includes(schemaParam ?? '') ? schemaParam! : '';
    if (picked) {
      const schemas = model.schemas.filter((schema) => schema.name === picked);
      const nodes = model.nodes.filter((node) =>
        node.kind === 'schema' ? node.label === picked : node.schema === picked,
      );
      const ids = new Set(nodes.map((node) => node.id));
      const links = model.links.filter((link) => ids.has(link.source) && ids.has(link.target));
      model = {
        ...model,
        schemas,
        nodes,
        links,
        totalTables: schemas[0]?.tableCount ?? 0,
        foreignKeys: links.filter((link) => link.kind === 'fk').length,
      };
    }
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

  const enlace = (cambios: Record<string, string> = {}) => {
    const params = new URLSearchParams({ peso: weight, v: window.key, capa: layer, ...cambios });
    return `/instances/${instanceId}/orm?${params.toString()}`;
  };

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
              <strong>foreign-key relationships</strong>. Optionally overlay attributed traffic on those
              links. For the write/read Sankey, use{' '}
              <Link href={`/instances/${instanceId}/flow`} className="underline">
                Flow
              </Link>
              .
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        <div className="stat-grid">
          <StatCard label="Schemas" value={formatNumber(model.schemas.length)} hint="in catalog" />
          <StatCard label="Tables" value={formatNumber(model.totalTables)} hint="user tables" />
          <StatCard
            label="Foreign keys"
            value={formatNumber(model.foreignKeys)}
            hint={model.foreignKeys === 0 ? 'next vacuum scan' : 'structural links'}
          />
          <StatCard
            label="Tables with traffic"
            value={formatNumber(model.attributedTables)}
            hint={`window ${window.label}`}
            tone={model.attributedTables > 0 ? 'accent' : 'neutral'}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Catalog graph</span>
            <div className="flex flex-wrap items-center gap-1">
              {LAYERS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ capa: opcion.key })}
                  className={`tag ${opcion.key === layer ? 'tag--info' : 'tag--muted'}`}
                  title={opcion.hint}
                >
                  {opcion.label}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {layer !== 'estructura'
                ? WEIGHTS.map((opcion) => (
                    <Link
                      key={opcion.key}
                      href={enlace({ peso: opcion.key })}
                      className={`tag ${opcion.key === weight ? 'tag--info' : 'tag--muted'}`}
                    >
                      {opcion.label}
                    </Link>
                  ))
                : null}
              {layer !== 'estructura' ? <span className="mx-1 text-foreground-muted">·</span> : null}
              {layer !== 'estructura'
                ? WINDOWS.map((opcion) => (
                    <Link
                      key={opcion.key}
                      href={enlace({ v: opcion.key })}
                      className={`tag ${opcion.key === window.key ? 'tag--info' : 'tag--muted'}`}
                    >
                      {opcion.label}
                    </Link>
                  ))
                : null}
            </div>
          </div>
          <form action={`/instances/${instanceId}/orm`} className="border-b border-border">
            <div className="panel-body flex flex-wrap items-center gap-2">
              <input type="hidden" name="capa" value={layer} />
              <input type="hidden" name="peso" value={weight} />
              <input type="hidden" name="v" value={window.key} />
              <label className="text-[11px] uppercase tracking-wide text-foreground-muted" htmlFor="orm-schema">
                Schema
              </label>
              <select
                id="orm-schema"
                name="schema"
                defaultValue={schemaChoices.includes(schemaParam ?? '') ? schemaParam : ''}
                className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px]"
              >
                <option value="">All schemas</option>
                {schemaChoices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button type="submit" className="tag tag--info">
                Filter
              </button>
              {schemaParam ? (
                <Link href={enlace()} className="tag tag--muted">
                  clear
                </Link>
              ) : null}
            </div>
          </form>
          <div className="panel-body">
            {model.totalTables === 0 ? (
              <div className="empty">No tables in catalog yet. Wait for the collector vacuum scan.</div>
            ) : (
              <OrmGraph model={model} instanceId={instanceId} unit={unit} layer={layer} />
            )}
            {layer !== 'estructura' && model.attributedTables > 0 ? (
              <p className="mt-2 text-[11px] text-foreground-muted">
                Traffic overlay uses {formatUnit(model.nodes.reduce((s, n) => s + n.writeHeat, 0), unit)} write
                and {formatUnit(model.nodes.reduce((s, n) => s + n.readHeat, 0), unit)} read across FK-linked
                tables in the last {window.label}.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
