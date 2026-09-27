import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StoreError } from '@/components/StoreError';
import { OrmGraph } from '@/components/OrmGraph';
import { StatCard } from '@/components/StatCard';
import { TopologyBubbles } from '@/components/TopologyBubbles';
import { Topbar } from '@/components/Topbar';
import { formatBytes, formatNumber } from '@/lib/format';
import { catalogModel, getCatalog, getCatalogColumns } from '@/lib/catalog';
import { getInstanceEngine } from '@/lib/estate';
import { getOrmModel } from '@/lib/orm';
import type { OrmLayer } from '@/lib/orm-types';
import { formatUnit, type Unit } from '@/lib/units';
import { getInstance } from '@/lib/queries';
import type { FlowWeight } from '@buho/core';
import {
  diffTopologyWeeks,
  getTopologyWeek,
  listTopologyWeeks,
  snapshotTopologyWeek,
  weekStartOf,
  type TopologyEdge,
} from '@/lib/topology';

export const dynamic = 'force-dynamic';

function tableLabel(edge: TopologyEdge): string {
  const short = edge.relation.includes('.')
    ? edge.relation.split('.').slice(1).join('.')
    : edge.relation;
  return `${edge.schemaName}.${short}`;
}

export default async function TopologyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    d?: string;
    snap?: string;
    vista?: string;
    q?: string;
    schema?: string;
    peso?: string;
    v?: string;
    capa?: string;
  }>;
}) {
  const { id } = await params;
  const { d, snap, vista, q, schema: schemaParam, peso, v, capa } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  const direction = d === 'lectura' ? 'lectura' : 'escritura';
  const view =
    vista === 'detalle'
      ? 'detalle'
      : vista === 'estructura'
        ? 'catalog'
        : vista === 'tabla'
          ? 'tabla'
          : vista === 'burbujas'
            ? 'burbujas'
            : 'trafico';

  if (view === 'detalle') {
    let instance;
    let catalog: Awaited<ReturnType<typeof getCatalog>>;
    try {
      instance = await getInstance(instanceId);
      if (!instance) notFound();
      catalog = await getCatalog(instanceId);
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
    const schemaNames = [...new Set(catalog.map((row) => row.schema))].sort();
    const schemaName = schemaNames.includes(schemaParam ?? '') ? (schemaParam ?? '') : (schemaNames[0] ?? '');
    const tables = catalog.filter((row) => row.schema === schemaName);
    const tableName = tables.some((row) => row.table === q) ? (q ?? '') : (tables[0]?.table ?? '');
    const columns = schemaName && tableName ? await getCatalogColumns(instanceId, schemaName, tableName) : [];
    return (
      <>
        <Topbar
          crumbs={[
            { label: 'Fleet', href: '/' },
            { label: instance.alias, href: `/instances/${instanceId}` },
            { label: 'Catalog' },
          ]}
        />
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">Columns · {instance.alias}</h1>
              <p className="page-sub">
                Schema, table, column, and type. This page is the catalog inventory. Traffic stays on the graph.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Link href={`/instances/${instanceId}/topology`} className="tag tag--muted">
                Traffic
              </Link>
              <Link href={`/instances/${instanceId}/topology?vista=estructura`} className="tag tag--muted">
                Structure
              </Link>
              <span className="tag tag--info">Columns</span>
            </div>
          </header>
          <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />
          {catalog.length === 0 ? (
            <div className="empty">The catalog is filled on the collector vacuum cycle, about every two minutes.</div>
          ) : (
            <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-[16rem_1fr]">
              <form action={`/instances/${instanceId}/topology`} className="panel">
                <div className="panel-body flex flex-col gap-2">
                  <input type="hidden" name="vista" value="detalle" />
                  <label className="text-[11px] uppercase tracking-wide text-foreground-muted" htmlFor="detail-schema">
                    Schema
                  </label>
                  <select
                    id="detail-schema"
                    name="schema"
                    defaultValue={schemaName}
                    className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px]"
                  >
                    {schemaNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <label className="text-[11px] uppercase tracking-wide text-foreground-muted" htmlFor="detail-table">
                    Table
                  </label>
                  <select
                    id="detail-table"
                    name="q"
                    defaultValue={tableName}
                    className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px]"
                  >
                    {tables.map((row) => (
                      <option key={row.table} value={row.table}>
                        {row.table}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="btn-secondary">
                    Show columns
                  </button>
                </div>
              </form>
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">
                    {schemaName}.{tableName}
                  </span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {columns.length === 0 ? 'waiting for the next catalog sample' : `${columns.length} columns`}
                  </span>
                </div>
                {columns.length === 0 ? (
                  <div className="empty">
                    Column types arrive with the next collector cycle. Table size is already in the catalog.
                  </div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="text-right">#</th>
                        <th>Column</th>
                        <th>Type</th>
                        <th>Null</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column) => (
                        <tr key={column.column}>
                          <td className="num">{column.position}</td>
                          <td className="font-mono text-[11.5px]">{column.column}</td>
                          <td className="font-mono text-[11.5px]">{column.dataType}</td>
                          <td className="text-[11px]">{column.notNull ? 'not null' : 'null'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          )}
        </div>
      </>
    );
  }

  if (view === 'trafico') {
    const weights: { key: FlowWeight; label: string }[] = [
      { key: 'rows', label: 'Rows' },
      { key: 'time', label: 'Time' },
      { key: 'calls', label: 'Calls' },
    ];
    const windows = [
      { key: '1h', label: '1 h', minutes: 60 },
      { key: '6h', label: '6 h', minutes: 360 },
      { key: '24h', label: '24 h', minutes: 1440 },
      { key: '7d', label: '7 d', minutes: 10080 },
    ];
    const layers: { key: OrmLayer; label: string }[] = [
      { key: 'ambos', label: 'Both' },
      { key: 'estructura', label: 'Keys only' },
      { key: 'trafico', label: 'Heat only' },
    ];
    const weight = (weights.find((entry) => entry.key === peso)?.key ?? 'rows') as FlowWeight;
    const window = windows.find((entry) => entry.key === v) ?? windows[2]!;
    const layer = (layers.find((entry) => entry.key === capa)?.key ?? 'ambos') as OrmLayer;
    const unit: Unit = weight === 'time' ? 'ms' : 'count';
    const link = (changes: Record<string, string> = {}) => {
      const query = new URLSearchParams({
        vista: 'trafico',
        peso: weight,
        v: window.key,
        capa: layer,
        ...changes,
      });
      return `/instances/${instanceId}/topology?${query.toString()}`;
    };

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
    if (!instance) notFound();

    return (
      <>
        <Topbar
          crumbs={[
            { label: 'Fleet', href: '/' },
            { label: instance.alias, href: `/instances/${instanceId}` },
            { label: 'Catalog' },
          ]}
        />
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">Catalog · {instance.alias}</h1>
              <p className="page-sub">
                Foreign keys with attributed traffic. Structure lists every schema and table without heat.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Link href={`/instances/${instanceId}/topology?vista=estructura`} className="tag tag--muted">
                Structure
              </Link>
              <span className="tag tag--info">Traffic</span>
              <Link href={`/instances/${instanceId}/topology?vista=detalle`} className="tag tag--muted">
                Columns
              </Link>
            </div>
          </header>
          <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />
          <div className="stat-grid">
            <StatCard label="Schemas" value={formatNumber(model.schemas.length)} hint="in this view" />
            <StatCard label="Tables" value={formatNumber(model.totalTables)} hint="user tables" />
            <StatCard label="Foreign keys" value={formatNumber(model.foreignKeys)} hint="structural links" />
            <StatCard
              label="Tables with traffic"
              value={formatNumber(model.attributedTables)}
              hint={`window ${window.label}`}
              tone={model.attributedTables > 0 ? 'accent' : 'neutral'}
            />
          </div>
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Traffic</span>
              <div className="flex flex-wrap items-center gap-1">
                {layers.map((option) => (
                  <Link
                    key={option.key}
                    href={link({ capa: option.key })}
                    className={`tag ${option.key === layer ? 'tag--info' : 'tag--muted'}`}
                  >
                    {option.label}
                  </Link>
                ))}
                <span className="mx-1 text-foreground-muted">·</span>
                {weights.map((option) => (
                  <Link
                    key={option.key}
                    href={link({ peso: option.key })}
                    className={`tag ${option.key === weight ? 'tag--info' : 'tag--muted'}`}
                  >
                    {option.label}
                  </Link>
                ))}
                <span className="mx-1 text-foreground-muted">·</span>
                {windows.map((option) => (
                  <Link
                    key={option.key}
                    href={link({ v: option.key })}
                    className={`tag ${option.key === window.key ? 'tag--info' : 'tag--muted'}`}
                  >
                    {option.label}
                  </Link>
                ))}
              </div>
            </div>
            <form action={`/instances/${instanceId}/topology`} className="border-b border-border">
              <div className="panel-body flex flex-wrap items-center gap-2">
                <input type="hidden" name="vista" value="trafico" />
                <input type="hidden" name="capa" value={layer} />
                <input type="hidden" name="peso" value={weight} />
                <input type="hidden" name="v" value={window.key} />
                <label className="text-[11px] uppercase tracking-wide text-foreground-muted" htmlFor="catalog-schema">
                  Schema
                </label>
                <select
                  id="catalog-schema"
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
                  <Link href={link()} className="tag tag--muted">
                    clear
                  </Link>
                ) : null}
              </div>
            </form>
            <div className="panel-body">
              {model.totalTables === 0 ? (
                <div className="empty">No tables in the catalog yet. Wait for the collector vacuum scan.</div>
              ) : (
                <OrmGraph model={model} instanceId={instanceId} unit={unit} layer={layer} />
              )}
              {model.attributedTables > 0 ? (
                <p className="mt-2 text-[11px] text-foreground-muted">
                  {formatUnit(
                    model.nodes.reduce((sum, node) => sum + node.writeHeat, 0),
                    unit,
                  )}{' '}
                  write and{' '}
                  {formatUnit(
                    model.nodes.reduce((sum, node) => sum + node.readHeat, 0),
                    unit,
                  )}{' '}
                  read on foreign-key links in the last {window.label}.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </>
    );
  }

  if (view === 'catalog') {
    let instance;
    let catalog: Awaited<ReturnType<typeof getCatalog>>;
    try {
      instance = await getInstance(instanceId);
      if (!instance) notFound();
      catalog = await getCatalog(instanceId);
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
    const needle = (q ?? '').trim().toLowerCase();
    const schemaNames = [...new Set(catalog.map((row) => row.schema))].sort();
    const schemaName = schemaNames.includes(schemaParam ?? '') ? (schemaParam ?? '') : '';
    const shown = catalog.filter((row) => {
      if (schemaName && row.schema !== schemaName) return false;
      if (!needle) return true;
      return (
        row.schema.toLowerCase().includes(needle) || row.table.toLowerCase().includes(needle)
      );
    });
    const groups = new Map<string, typeof catalog>();
    for (const row of shown) {
      const list = groups.get(row.schema) ?? [];
      list.push(row);
      groups.set(row.schema, list);
    }
    return (
      <>
        <Topbar
          crumbs={[
            { label: 'Fleet', href: '/' },
            { label: instance.alias, href: `/instances/${instanceId}` },
            { label: 'Topology' },
          ]}
        />
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">Catalog · {instance.alias}</h1>
              <p className="page-sub">
                Every user schema and table, without traffic. Partitions are rolled into the parent.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Link href={`/instances/${instanceId}/topology`} className="tag tag--muted">
                Traffic
              </Link>
              <span className="tag tag--info">Structure</span>
              <Link href={`/instances/${instanceId}/topology?vista=detalle`} className="tag tag--muted">
                Columns
              </Link>
            </div>
          </header>
          <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />
          <div className="stat-grid">
            <div className="stat">
              <div className="stat__label">Schemas</div>
              <div className="stat__value">{formatNumber(groups.size)}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Tables</div>
              <div className="stat__value">{formatNumber(shown.length)}</div>
              <div className="stat__hint">
                {needle ? `${formatNumber(catalog.length)} in the catalog` : 'partitions included in the parent'}
              </div>
            </div>
          </div>
          <form action={`/instances/${instanceId}/topology`} className="panel">
            <div className="panel-body flex flex-wrap items-center gap-2">
              <input type="hidden" name="vista" value="estructura" />
              <select
                name="schema"
                defaultValue={schemaName}
                className="rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px]"
              >
                <option value="">All schemas</option>
                {schemaNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                type="search"
                name="q"
                defaultValue={needle}
                placeholder="Filter schema or table"
                className="w-full max-w-md rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[12px]"
              />
              <button type="submit" className="tag tag--info">
                Filter
              </button>
              {needle ? (
                <Link href={`/instances/${instanceId}/topology?vista=estructura`} className="tag tag--muted">
                  clear
                </Link>
              ) : null}
            </div>
          </form>
          {catalog.length === 0 ? (
            <div className="empty">
              The catalog is filled on the collector vacuum cycle, about every two minutes.
            </div>
          ) : shown.length === 0 ? (
            <div className="empty">No schema or table matches that filter.</div>
          ) : (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Structure</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  schemas and tables, no traffic
                </span>
              </div>
              <div className="panel-body">
                <OrmGraph
                  model={catalogModel(shown)}
                  instanceId={instanceId}
                  unit="count"
                  layer="estructura"
                />
              </div>
            </section>
          )}
          <p className="text-[12px] text-foreground-secondary">
            <Link href={`/instances/${instanceId}/topology?vista=detalle`} className="btn-secondary">
              Open column detail
            </Link>
          </p>
        </div>
      </>
    );
  }

  let instance;
  let weeks: Date[];
  let current;
  let previous;
  let diff;
  try {
    instance = await getInstance(instanceId);
    if (!instance) notFound();

    weeks = await listTopologyWeeks(instanceId);
    // Auto-snapshot when empty so MSSQL/Maria don't land on a blank page after
    // Flow already has attributed traffic. Manual refresh still via `?snap=1`.
    if (snap === '1' || weeks.length === 0) {
      await snapshotTopologyWeek(instanceId, engine, 'aplicacion');
      weeks = await listTopologyWeeks(instanceId);
    }

    const thisWeek = weekStartOf();
    const newer = weeks[0] ?? thisWeek;
    const older = weeks[1] ?? null;
    current = await getTopologyWeek(instanceId, newer, direction);
    previous = older ? await getTopologyWeek(instanceId, older, direction) : null;
    diff = older ? await diffTopologyWeeks(instanceId, newer, older, direction) : null;
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

  const base = `/instances/${instanceId}/topology`;
  const href = (opts: { d?: string; vista?: string; snap?: string }) => {
    const params = new URLSearchParams();
    params.set('d', opts.d ?? direction);
    params.set('vista', opts.vista ?? view);
    if (opts.snap) params.set('snap', opts.snap);
    return `${base}?${params.toString()}`;
  };

  const bubbleEdges = current.edges.map((edge) => ({
    actor: edge.actor,
    relation: edge.relation,
    label: tableLabel(edge),
    weight: edge.weight,
    samples: edge.samples,
    kind: (direction === 'escritura' ? 'write' : 'read') as 'write' | 'read',
  }));

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Topology' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Topology · {instance.alias}</h1>
            <p className="page-sub">
              Weekly snapshot of which apps touch which tables. Live movement is on{' '}
              <Link href={`/instances/${instanceId}/flow`} className="underline">
                Flow
              </Link>
              ; here you compare weeks.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Link
              href={href({ d: 'escritura' })}
              className={`tag ${direction === 'escritura' ? 'tag--info' : 'tag--muted'}`}
            >
              writes
            </Link>
            <Link
              href={href({ d: 'lectura' })}
              className={`tag ${direction === 'lectura' ? 'tag--info' : 'tag--muted'}`}
            >
              reads
            </Link>
            <Link href={`${base}`} className="tag tag--muted">
              structure
            </Link>
            <Link
              href={href({ vista: 'burbujas' })}
              className={`tag ${view === 'burbujas' ? 'tag--info' : 'tag--muted'}`}
            >
              bubbles
            </Link>
            <Link
              href={href({ vista: 'tabla' })}
              className={`tag ${view === 'tabla' ? 'tag--info' : 'tag--muted'}`}
            >
              table
            </Link>
            <Link href={href({ snap: '1' })} className="tag tag--muted">
              refresh week
            </Link>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        {weeks.length === 0 || current.edges.length === 0 ? (
          <section className="panel">
            <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
              <p>
                {weeks.length === 0
                  ? 'No weekly topology snapshot yet.'
                  : 'Snapshot exists but has no app ↔ table edges yet.'}{' '}
                Topology is built from attributed queries in{' '}
                <Link href={`/instances/${instanceId}/flow`} className="underline">
                  Flow
                </Link>{' '}
                /{' '}
                <Link href={`/instances/${instanceId}/queries`} className="underline">
                  Queries
                </Link>
                .
                {engine === 'mssql' ? (
                  <>
                    {' '}
                    For SQL Server, digests need table names in the SQL text (Query Store / statement
                    capture). HA peers live on{' '}
                    <Link href={`/instances/${instanceId}/replication`} className="underline">
                      Replication
                    </Link>
                    ; schema FKs on{' '}
                    <Link href={`/instances/${instanceId}/orm`} className="underline">
                      ORM
                    </Link>
                    .
                  </>
                ) : null}
                {engine === 'mariadb' ? (
                  <>
                    {' '}
                    On MariaDB without <code>performance_schema</code>, wait until PROCESSLIST
                    sampling fills Queries, then refresh.
                  </>
                ) : null}
              </p>
              <p className="mt-2 flex flex-wrap gap-2">
                <Link href={href({ snap: '1' })} className="tag tag--info">
                  refresh week
                </Link>
                <Link href={`/instances/${instanceId}/flow`} className="tag tag--muted">
                  open Flow
                </Link>
                {engine === 'mssql' ? (
                  <Link href={`/instances/${instanceId}/replication`} className="tag tag--muted">
                    Always On / HA →
                  </Link>
                ) : null}
              </p>
            </div>
          </section>
        ) : null}

        <div className="grid grid-cols-3 gap-[0.875rem]">
          <div className="stat">
            <div className="stat__label">Week</div>
            <div className="stat__value text-[1rem]">
              {current.weekStart.toLocaleDateString('en')}
            </div>
            <div className="stat__hint">{weeks.length} week(s) stored</div>
          </div>
          <div className="stat">
            <div className="stat__label">Applications</div>
            <div className="stat__value">{formatNumber(current.actors, 0)}</div>
          </div>
          <div className="stat">
            <div className="stat__label">Tables</div>
            <div className="stat__value">{formatNumber(current.tables, 0)}</div>
          </div>
        </div>

        {diff && (
          <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
            <div className="panel-header">
              <span className="panel-title">Change vs previous week</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {previous?.weekStart.toLocaleDateString('en') ?? '—'}
              </span>
            </div>
            <div className="panel-body grid grid-cols-1 gap-3 text-[12px] xl:grid-cols-3">
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-foreground-muted">
                  New ({diff.added.length})
                </div>
                {diff.added.length === 0 ? (
                  <p className="text-foreground-muted">None.</p>
                ) : (
                  <ul className="space-y-1 font-mono">
                    {diff.added.slice(0, 8).map((e) => (
                      <li key={`${e.actor}-${e.relation}`}>
                        {e.actor} → {tableLabel(e)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-foreground-muted">
                  Gone ({diff.removed.length})
                </div>
                {diff.removed.length === 0 ? (
                  <p className="text-foreground-muted">None.</p>
                ) : (
                  <ul className="space-y-1 font-mono">
                    {diff.removed.slice(0, 8).map((e) => (
                      <li key={`${e.actor}-${e.relation}`}>
                        {e.actor} → {tableLabel(e)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-foreground-muted">
                  Grew ≥2× ({diff.grown.length})
                </div>
                {diff.grown.length === 0 ? (
                  <p className="text-foreground-muted">None.</p>
                ) : (
                  <ul className="space-y-1 font-mono">
                    {diff.grown.slice(0, 8).map((g) => (
                      <li key={`${g.edge.actor}-${g.edge.relation}`}>
                        {g.edge.actor} → {tableLabel(g.edge)}{' '}
                        <span className="text-foreground-muted">×{g.ratio.toFixed(1)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {view === 'burbujas' ? 'App ↔ table bubbles' : 'Edges this week'} (
              {direction === 'escritura' ? 'writes' : 'reads'})
            </span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {view === 'burbujas' ? 'bubble size = time weight' : `${current.edges.length} edge(s)`}
            </span>
          </div>
          {current.edges.length === 0 ? (
            <div className="empty" style={{ height: 120 }}>
              No edges yet. Need traffic in statement_stats and a refresh.
            </div>
          ) : view === 'burbujas' ? (
            <div className="panel-body">
              <p className="mb-3 text-[12px] text-foreground-muted">
                Left cluster = apps (or &quot;not observed&quot; when application name was not sampled).
                Right = tables. Bigger bubble = more attributed time this week. Click a bubble for
                its links; use <strong>table</strong> for the full numeric list.
              </p>
              <TopologyBubbles edges={bubbleEdges} height={520} />
            </div>
          ) : (
            <div className="panel-body overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>App</th>
                    <th>Table</th>
                    <th className="text-right">Weight (ms)</th>
                    <th className="text-right">Samples</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {current.edges.slice(0, 60).map((e) => (
                    <tr key={`${e.actor}|${e.relation}`}>
                      <td>{e.actor}</td>
                      <td>{tableLabel(e)}</td>
                      <td className="num">{formatNumber(e.weight, 0)}</td>
                      <td className="num">{formatNumber(e.samples, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
