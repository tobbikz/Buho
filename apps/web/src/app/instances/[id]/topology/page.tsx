import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StoreError } from '@/components/StoreError';
import { TopologyBubbles } from '@/components/TopologyBubbles';
import { Topbar } from '@/components/Topbar';
import { formatBytes, formatNumber } from '@/lib/format';
import { getCatalog } from '@/lib/catalog';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
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
  searchParams: Promise<{ d?: string; snap?: string; vista?: string; q?: string }>;
}) {
  const { id } = await params;
  const { d, snap, vista, q } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';
  const direction = d === 'lectura' ? 'lectura' : 'escritura';
  const view = vista === 'tabla' ? 'tabla' : vista === 'trafico' || vista === 'burbujas' ? 'burbujas' : 'catalog';

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
    const shown = needle
      ? catalog.filter(
          (row) =>
            row.schema.toLowerCase().includes(needle) || row.table.toLowerCase().includes(needle),
        )
      : catalog;
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
              <h1 className="page-title">Topology · {instance.alias}</h1>
              <p className="page-sub">
                Every user schema and table. Partitions are rolled into the parent. Traffic lives on{' '}
                <Link href={`/instances/${instanceId}/flow`} className="underline">
                  Flow
                </Link>
                .
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="tag tag--info">structure</span>
              <Link href={`/instances/${instanceId}/topology?vista=trafico`} className="tag tag--muted">
                traffic
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
            <div className="panel-body flex items-center gap-2">
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
                <Link href={`/instances/${instanceId}/topology`} className="tag tag--muted">
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
            <div className="flex flex-col gap-2">
              {[...groups.entries()].map(([schema, tables]) => (
                <details key={schema} className="panel" open={Boolean(needle) || groups.size <= 8}>
                  <summary className="panel-header cursor-pointer">
                    <span className="panel-title">{schema}</span>
                    <span className="font-mono text-[10px] text-foreground-muted">
                      {tables.length} table{tables.length === 1 ? '' : 's'}
                    </span>
                  </summary>
                  <table className="data-table">
                    <tbody>
                      {tables.map((row) => (
                        <tr key={row.table}>
                          <td className="font-mono text-[11.5px]">{row.table}</td>
                          <td className="num">{formatBytes(row.sizeBytes)}</td>
                          <td className="text-right font-mono text-[11px] text-foreground-muted">
                            {row.partitions > 0 ? `${row.partitions} partitions` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
            </div>
          )}
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
