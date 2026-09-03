import { notFound } from 'next/navigation';
import Link from 'next/link';
import { IndexSuggestionCards } from '@/components/IndexSuggestionCards';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { getIndexFindings, getIndexSuggestions } from '@/lib/advisor';
import { getIndexInventory, getIndexSummary } from '@/lib/indexes';
import type { IndexRow } from '@/lib/indexes';
import type { IndexStatus } from '@buho/core';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<IndexStatus, string> = {
  ok: 'Healthy',
  unused: 'Unused',
  redundant: 'Redundant',
  invalid: 'Invalid',
};

const STATUS_TAG: Record<IndexStatus, string> = {
  ok: 'tag--ok',
  unused: 'tag--warn',
  redundant: 'tag--warn',
  invalid: 'tag--error',
};

function IndexBadge({ status }: { status: IndexStatus }) {
  return <span className={`tag ${STATUS_TAG[status]}`}>{STATUS_LABEL[status]}</span>;
}

function IndexDefinition({ row }: { row: IndexRow }) {
  if (!row.definition) return null;
  return <div className="mt-1 font-mono text-[10px] text-foreground-muted">{row.definition}</div>;
}

function groupBySchema(rows: IndexRow[]) {
  const groups = new Map<string, { schema: string; indexes: number; bytes: number; flagged: number }>();
  for (const row of rows) {
    const existing = groups.get(row.schema) ?? { schema: row.schema, indexes: 0, bytes: 0, flagged: 0 };
    existing.indexes += 1;
    existing.bytes += row.sizeBytes;
    if (row.status !== 'ok') existing.flagged += 1;
    groups.set(row.schema, existing);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes || b.indexes - a.indexes);
}

function groupByTable(rows: IndexRow[]) {
  const groups = new Map<
    string,
    { schema: string; table: string; indexes: number; bytes: number; flagged: number; scans: number }
  >();
  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    const existing = groups.get(key) ?? {
      schema: row.schema,
      table: row.table,
      indexes: 0,
      bytes: 0,
      flagged: 0,
      scans: 0,
    };
    existing.indexes += 1;
    existing.bytes += row.sizeBytes;
    existing.scans += row.idxScan;
    if (row.status !== 'ok') existing.flagged += 1;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes || b.indexes - a.indexes);
}

function buildIndexesHref(
  instanceId: number,
  filter: 'all' | IndexStatus,
  schema: string | null,
  opts?: { q?: string; sort?: string; dir?: 'asc' | 'desc' },
): string {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('filter', filter);
  if (schema) params.set('schema', schema);
  if (opts?.q) params.set('q', opts.q);
  if (opts?.sort) params.set('sort', opts.sort);
  if (opts?.dir) params.set('dir', opts.dir);
  const query = params.toString();
  return query ? `/instances/${instanceId}/indexes?${query}` : `/instances/${instanceId}/indexes`;
}

function IndexTable({ rows }: { rows: IndexRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">No indexes in this category.</div>;
  }

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Index</th>
            <th>Table</th>
            <th>Columns</th>
            <th className="text-right">Size</th>
            <th className="text-right">Scans</th>
            <th>Flags</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.schema}.${row.table}.${row.name}`}>
              <td className="font-mono text-[11px]">{row.name}</td>
              <td className="font-mono text-[11px]">
                {row.schema}.{row.table}
              </td>
              <td className="font-mono text-[11px]">{row.columns.join(', ') || '·'}</td>
              <td className="num">{formatBytes(row.sizeBytes)}</td>
              <td className="num">{formatNumber(row.idxScan)}</td>
              <td className="text-[11px] text-foreground-muted">
                {[
                  row.isPrimary ? 'PK' : null,
                  row.isUnique && !row.isPrimary ? 'UNIQUE' : null,
                  row.isPartial ? 'partial' : null,
                  row.hasExpression ? 'expression' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '·'}
              </td>
              <td>
                <IndexBadge status={row.status} />
                {row.coveredBy && (
                  <div className="mt-1 font-mono text-[10px] text-foreground-muted">
                    covered by {row.coveredBy}
                  </div>
                )}
                <IndexDefinition row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function IndexesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    filter?: string;
    schema?: string;
    q?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const { id } = await params;
  const { filter: filterParam, schema: schemaParam, q: qParam, sort: sortParam, dir: dirParam } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  let instance;
  let suggestions: Awaited<ReturnType<typeof getIndexSuggestions>>;
  let findings: Awaited<ReturnType<typeof getIndexFindings>>;
  let summary: Awaited<ReturnType<typeof getIndexSummary>>;
  let allIndexes: IndexRow[];
  let problemIndexes: IndexRow[];

  try {
    [instance, suggestions, findings, summary, allIndexes, problemIndexes] = await Promise.all([
      getInstance(instanceId),
      getIndexSuggestions(instanceId),
      getIndexFindings(instanceId),
      getIndexSummary(instanceId),
      getIndexInventory(instanceId, 'all'),
      getIndexInventory(instanceId, 'all').then((rows) =>
        rows.filter((row) => row.status !== 'ok'),
      ),
    ]);
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

  const crumbs = [
    { label: 'Fleet', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Indexes' },
  ];

  const wastedRows = suggestions.suggestions.reduce((sum, item) => sum + item.wastedRows, 0);
  const observedMs = suggestions.suggestions.reduce((sum, item) => sum + item.observedMs, 0);
  const unusedIndexes = allIndexes.filter((row) => row.status === 'unused');
  const redundantIndexes = allIndexes.filter((row) => row.status === 'redundant');
  const invalidIndexes = allIndexes.filter((row) => row.status === 'invalid');
  const schemaGroups = groupBySchema(allIndexes);
  const tableGroups = groupByTable(allIndexes).slice(0, 12);
  const activeFilter: 'all' | IndexStatus =
    filterParam === 'unused' || filterParam === 'redundant' || filterParam === 'invalid' || filterParam === 'ok'
      ? filterParam
      : 'all';
  const activeSchema = schemaParam && schemaGroups.some((row) => row.schema === schemaParam) ? schemaParam : null;
  const q = typeof qParam === 'string' ? qParam.trim() : '';

  const sort =
    sortParam === 'size' || sortParam === 'scans' || sortParam === 'name' || sortParam === 'table'
      ? sortParam
      : 'size';
  const dir: 'asc' | 'desc' = dirParam === 'asc' ? 'asc' : 'desc';

  const inventoryRows = allIndexes.filter((row) => {
    if (activeFilter !== 'all' && row.status !== activeFilter) return false;
    if (activeSchema && row.schema !== activeSchema) return false;
    return true;
  });

  const searchedRows = !q
    ? inventoryRows
    : inventoryRows.filter((row) => {
        const haystack = [
          row.name,
          row.schema,
          row.table,
          row.columns.join(', '),
          row.definition ?? '',
          row.status,
          row.coveredBy ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q.toLowerCase());
      });

  const sortedRows = [...searchedRows].sort((a, b) => {
    const mul = dir === 'asc' ? 1 : -1;
    switch (sort) {
      case 'scans':
        return mul * (a.idxScan - b.idxScan);
      case 'name':
        return mul * a.name.localeCompare(b.name);
      case 'table':
        return mul * `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`);
      case 'size':
      default:
        return mul * (a.sizeBytes - b.sizeBytes);
    }
  });

  function ToggleSortLink({
    label,
    keyName,
  }: {
    label: string;
    keyName: 'size' | 'scans' | 'name' | 'table';
  }) {
    const isActive = sort === keyName;
    const nextDir: 'asc' | 'desc' = isActive ? (dir === 'asc' ? 'desc' : 'asc') : 'desc';
    return (
      <Link
        href={buildIndexesHref(instanceId, activeFilter, activeSchema, { q, sort: keyName, dir: nextDir })}
        className={isActive ? 'tag tag--info' : 'btn-secondary'}
      >
        {label} {isActive ? (dir === 'asc' ? '↑' : '↓') : ''}
      </Link>
    );
  }

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Indexes · {instance.alias}</h1>
            <p className="page-sub">
              Inventory is what exists on the server (size, scans, overlap). Suggestions come only
              from <Link href={`/instances/${instanceId}/queries`} className="text-accent">Queries</Link>{' '}
              with <strong>Executed with ANALYZE</strong> — hypotheses, not DDL Búho will run.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Indexes"
            value={formatNumber(summary.total)}
            hint={
              summary.capturedAt
                ? `total size ${formatBytes(summary.totalBytes)} · ${formatAgo(summary.capturedAt)}`
                : engine === 'postgres'
                  ? 'inventory not collected yet'
                  : 'inventory is PostgreSQL-only'
            }
          />
          <StatCard
            label="Unused"
            value={formatNumber(summary.unused)}
            tone={summary.unused > 0 ? 'warn' : 'ok'}
            hint="large secondary indexes with zero scans"
          />
          <StatCard
            label="Redundant"
            value={formatNumber(summary.redundant)}
            tone={summary.redundant > 0 ? 'warn' : 'ok'}
            hint="left prefix of another index on the same table"
          />
          <StatCard
            label="Invalid"
            value={formatNumber(summary.invalid)}
            tone={summary.invalid > 0 ? 'error' : 'ok'}
            hint="failed CREATE INDEX CONCURRENTLY — rebuild or drop"
          />
          <StatCard
            label="Suggestions"
            value={formatNumber(suggestions.suggestions.length)}
            tone={suggestions.suggestions.length > 0 ? 'warn' : 'ok'}
            hint={`from ${formatNumber(suggestions.plansWithActuals)} ANALYZE plan(s)`}
          />
        </div>

        {engine !== 'postgres' ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Index inventory</span>
            </div>
            <div className="panel-body text-[12px]">
              Full index listing (size, usage, redundancy) is implemented for PostgreSQL. Plan-based
              suggestions below still apply if you have requested ANALYZE plans for this instance.
            </div>
          </section>
        ) : summary.total === 0 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Index inventory</span>
            </div>
            <div className="panel-body text-[12px]">
              No index snapshot yet. The collector refreshes inventory on the same cycle as vacuum
              (~5 minutes). If this stays empty, restart the collector after migrating the store.
            </div>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Existing indexes</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  keep, drop, or rebuild
                </span>
              </div>
              <div className="panel-body text-[12px]">
                This inventory comes from PostgreSQL itself: size, scan counters, flags, full
                definitions, and structural overlap with other indexes on the same table.
              </div>
            </section>

            {redundantIndexes.length > 0 && (
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">Redundant indexes</span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {formatNumber(redundantIndexes.length)} flagged
                  </span>
                </div>
                <div className="panel-body">
                  <IndexTable rows={redundantIndexes} />
                  <p className="mt-3 text-[11px] text-foreground-muted">
                    Each row includes the current definition and, when Búho can prove it, the larger
                    index that already covers the same left prefix.
                  </p>
                </div>
              </section>
            )}

            {unusedIndexes.length > 0 && (
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">Unused indexes</span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {formatNumber(unusedIndexes.length)} above the 10 MB threshold
                  </span>
                </div>
                <div className="panel-body">
                  <IndexTable rows={unusedIndexes} />
                  <p className="mt-3 text-[11px] text-foreground-muted">
                    Unused means zero scans on a large non-PK index since the last stats reset.
                    Check infrequent reports, month-end jobs, and replica-only reads before dropping.
                  </p>
                </div>
              </section>
            )}

            {invalidIndexes.length > 0 && (
              <section className="panel">
                <div className="panel-header">
                  <span className="panel-title">Invalid indexes</span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {formatNumber(invalidIndexes.length)} need attention
                  </span>
                </div>
                <div className="panel-body">
                  <IndexTable rows={invalidIndexes} />
                  <p className="mt-3 text-[11px] text-foreground-muted">
                    PostgreSQL marks an index invalid when a concurrent build fails or is
                    interrupted. These objects can consume space without being safe to rely on.
                  </p>
                </div>
              </section>
            )}

            {problemIndexes.length === 0 && (
              <div className="empty">
                No redundant, unused, or invalid indexes were found in the latest inventory.
              </div>
            )}

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Index footprint by schema</span>
              </div>
              <div className="panel-body">
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Schema</th>
                        <th className="text-right">Indexes</th>
                        <th className="text-right">Flagged</th>
                        <th className="text-right">Total size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schemaGroups.map((row) => (
                        <tr key={row.schema}>
                          <td className="font-mono text-[11px]">{row.schema}</td>
                          <td className="num">{formatNumber(row.indexes)}</td>
                          <td className="num">{formatNumber(row.flagged)}</td>
                          <td className="num">{formatBytes(row.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Largest index footprints by table</span>
                <span className="font-mono text-[10px] text-foreground-muted">top 12</span>
              </div>
              <div className="panel-body">
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Table</th>
                        <th className="text-right">Indexes</th>
                        <th className="text-right">Flagged</th>
                        <th className="text-right">Total size</th>
                        <th className="text-right">Total scans</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableGroups.map((row) => (
                        <tr key={`${row.schema}.${row.table}`}>
                          <td className="font-mono text-[11px]">
                            {row.schema}.{row.table}
                          </td>
                          <td className="num">{formatNumber(row.indexes)}</td>
                          <td className="num">{formatNumber(row.flagged)}</td>
                          <td className="num">{formatBytes(row.bytes)}</td>
                          <td className="num">{formatNumber(row.scans)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">All indexes</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  {summary.capturedAt ? `as of ${formatAgo(summary.capturedAt)} · size desc` : ''}
                </span>
              </div>
              <div className="panel-body">
                <div className="mb-4 flex flex-wrap gap-2">
                  {(['all', 'redundant', 'unused', 'invalid', 'ok'] as const).map((filter) => (
                    <Link
                      key={filter}
                      href={buildIndexesHref(instanceId, filter, activeSchema, { q, sort, dir })}
                      className={activeFilter === filter ? 'tag tag--info' : 'btn-secondary'}
                    >
                      {filter === 'all' ? 'All statuses' : STATUS_LABEL[filter]}
                    </Link>
                  ))}
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  <Link
                    href={buildIndexesHref(instanceId, activeFilter, null, { q, sort, dir })}
                    className={activeSchema === null ? 'tag tag--info' : 'btn-secondary'}
                  >
                    All schemas
                  </Link>
                  {schemaGroups.map((group) => (
                    <Link
                      key={group.schema}
                      href={buildIndexesHref(instanceId, activeFilter, group.schema, { q, sort, dir })}
                      className={activeSchema === group.schema ? 'tag tag--info' : 'btn-secondary'}
                    >
                      {group.schema} ({formatNumber(group.indexes)})
                    </Link>
                  ))}
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-foreground-muted font-mono">Sort</span>
                  <ToggleSortLink label="Size" keyName="size" />
                  <ToggleSortLink label="Scans" keyName="scans" />
                  <ToggleSortLink label="Index" keyName="name" />
                  <ToggleSortLink label="Table" keyName="table" />
                </div>

                <form
                  method="get"
                  className="mb-4 flex flex-wrap items-center gap-2"
                  action={`/instances/${instanceId}/indexes`}
                >
                  <input type="hidden" name="filter" value={activeFilter} />
                  {activeSchema && <input type="hidden" name="schema" value={activeSchema} />}
                  <input type="hidden" name="sort" value={sort} />
                  <input type="hidden" name="dir" value={dir} />
                  <input
                    type="text"
                    name="q"
                    defaultValue={q}
                    placeholder="Search index / table / definition…"
                    className="input"
                    style={{ flex: '1 1 240px' }}
                  />
                  <button type="submit" className="btn-secondary">
                    Search
                  </button>
                  {q ? (
                    <Link
                      href={buildIndexesHref(instanceId, activeFilter, activeSchema, { q: '', sort, dir })}
                      className="btn-secondary"
                    >
                      Clear
                    </Link>
                  ) : null}
                </form>

                <p className="mb-4 text-[11px] text-foreground-muted">
                  Showing {formatNumber(inventoryRows.length)} of {formatNumber(allIndexes.length)} index row(s)
                  {activeFilter !== 'all' ? ` · status ${STATUS_LABEL[activeFilter]}` : ''}
                  {activeSchema ? ` · schema ${activeSchema}` : ''}.
                </p>
                <p className="mb-4 text-[11px] text-foreground-muted">
                  Filtered to {formatNumber(sortedRows.length)} row(s) by search.
                </p>
                <IndexTable rows={sortedRows} />
              </div>
            </section>
          </>
        )}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Missing indexes (suggestions only)</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {suggestions.plansWithActuals > 0
                ? `${formatNumber(suggestions.plansWithActuals)} plan(s) with real rows`
                : 'no plans yet'}
            </span>
          </div>
          <div className="panel-body">
            <div className="stat-grid mb-4">
              <StatCard
                label="Rows discarded"
                value={formatNumber(wastedRows)}
                hint="read then thrown away in evidence nodes"
              />
              <StatCard
                label="Time in those nodes"
                value={formatDuration(observedMs)}
                hint="observed — not promised savings"
              />
              <StatCard
                label="Plans analyzed"
                value={formatNumber(suggestions.plansConsidered)}
                hint={
                  suggestions.newestPlanAt
                    ? `newest ${formatAgo(suggestions.newestPlanAt)}`
                    : 'none yet'
                }
              />
              <StatCard
                label="Suggestions"
                value={formatNumber(suggestions.suggestions.length)}
                tone={suggestions.suggestions.length > 0 ? 'warn' : 'ok'}
                hint="never auto-applied"
              />
            </div>

            <p className="mb-4 text-[12px] text-foreground-muted">
              <strong>Búho never creates or drops indexes.</strong> Each card is a hypothesis: what
              looked wasteful in an `ANALYZE` plan, a candidate DDL for you to review, and caveats
              before you run anything. Inventory above is about what already exists; this section is
              about possible additions.
            </p>

            {suggestions.plansWithActuals === 0 ? (
              <div className="text-[12px]">
                <p>
                  This section does not guess from pg_stat alone. It needs plans executed with
                  ANALYZE so each filter reports how many rows it discarded. Estimated plans can be
                  wrong by orders of magnitude.
                </p>
                <p className="mt-2">
                  To populate it: open{' '}
                  <Link href={`/instances/${instanceId}/queries`} className="text-accent">
                    Queries
                  </Link>
                  , pick expensive read-only statements, and request{' '}
                  <strong>Executed with ANALYZE</strong>. They always run inside a rolled-back
                  transaction.
                </p>
              </div>
            ) : suggestions.suggestions.length === 0 ? (
              <div className="empty">
                None of the {formatNumber(suggestions.plansWithActuals)} analyzed plans shows a
                pattern a new index would fix. That does not prove indexes are perfect — only that
                the queries you analyzed are not missing one.
              </div>
            ) : (
              <IndexSuggestionCards
                instanceId={instanceId}
                items={suggestions.suggestions.map((item) => ({
                  relation: item.relation,
                  kind: item.kind,
                  reason: item.reason,
                  caveat: item.caveat,
                  ddl: item.ddl,
                  columns: item.columns,
                  evidence: item.evidence.map((evidence) => ({
                    queryid: evidence.queryid,
                    nodeType: evidence.nodeType,
                    predicate: evidence.predicate,
                    rowsRemoved: evidence.rowsRemoved,
                    rowsReturned: evidence.rowsReturned,
                    loops: evidence.loops,
                    selfMs: evidence.selfMs,
                  })),
                }))}
              />
            )}
          </div>
        </section>

        {(findings.length > 0 || unusedIndexes.length > 0 || redundantIndexes.length > 0) && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Check findings</span>
              <span className="font-mono text-[10px] text-foreground-muted">last 24h</span>
            </div>
            <div className="panel-body">
              {findings.length > 0 ? (
                <ul className="list-disc pl-5 text-[12px]">
                  {findings.map((finding) => (
                    <li key={`${finding.checkId}-${finding.object}`}>
                      <span className="font-mono text-[11px]">{finding.object}</span> ·{' '}
                      {finding.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-foreground-muted">
                  Automated checks have not reported index issues in the last day. The inventory
                  above is refreshed every vacuum cycle and may flag objects before checks run.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
