import { notFound } from 'next/navigation';
import Link from 'next/link';
import { IndexInventoryTable } from '@/components/IndexInventoryTable';
import { IndexSuggestionCards } from '@/components/IndexSuggestionCards';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { getIndexFindings, getIndexSuggestions } from '@/lib/advisor';
import {
  getBloatedIndexes,
  getIndexInventory,
  getIndexPage,
  getIndexSchemaGroups,
  getIndexSummary,
  getIndexTableGroups,
} from '@/lib/indexes';
import type { IndexRow, IndexSchemaGroup, IndexTableGroup } from '@/lib/indexes';
import type { IndexStatus } from '@buho/core';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<IndexStatus, string> = {
  ok: 'Healthy',
  unused: 'Unused',
  redundant: 'Redundant',
  invalid: 'Invalid',
};

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
  filter: 'all' | IndexStatus | 'bloated',
  schema: string | null,
  opts?: {
    q?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    page?: number;
    fp?: string | null;
    ft?: string;
    fpage?: number;
  },
): string {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('filter', filter);
  if (schema) params.set('schema', schema);
  if (opts?.q) params.set('q', opts.q);
  if (opts?.sort) params.set('sort', opts.sort);
  if (opts?.dir) params.set('dir', opts.dir);
  if (opts?.page && opts.page > 1) params.set('page', String(opts.page));
  if (opts?.fp) params.set('fp', opts.fp);
  if (opts?.ft) params.set('ft', opts.ft);
  if (opts?.fpage && opts.fpage > 1) params.set('fpage', String(opts.fpage));
  const query = params.toString();
  return query ? `/instances/${instanceId}/indexes?${query}` : `/instances/${instanceId}/indexes`;
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
    page?: string;
    fp?: string;
    ft?: string;
    fpage?: string;
  }>;
}) {
  const { id } = await params;
  const {
    filter: filterParam,
    schema: schemaParam,
    q: qParam,
    sort: sortParam,
    dir: dirParam,
    page: pageParam,
    fp: fpParam,
    ft: ftParam,
    fpage: fpageParam,
  } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  let instance;
  let suggestions: Awaited<ReturnType<typeof getIndexSuggestions>>;
  let findings: Awaited<ReturnType<typeof getIndexFindings>>;
  let summary: Awaited<ReturnType<typeof getIndexSummary>>;
  let schemaGroups: IndexSchemaGroup[];
  let tableGroups: { rows: IndexTableGroup[]; total: number };
  let inventory: { rows: IndexRow[]; total: number };
  let unusedIndexes: IndexRow[];
  let redundantIndexes: IndexRow[];
  let invalidIndexes: IndexRow[];

  const fragmented = filterParam === 'bloated';
  const activeFilter: 'all' | IndexStatus =
    filterParam === 'unused' || filterParam === 'redundant' || filterParam === 'invalid' || filterParam === 'ok'
      ? filterParam
      : 'all';
  const q = typeof qParam === 'string' ? qParam.trim() : '';
  const sort =
    sortParam === 'size' || sortParam === 'scans' || sortParam === 'name' || sortParam === 'table'
      ? sortParam
      : 'size';
  const dir: 'asc' | 'desc' = dirParam === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(pageParam) || 1);

  try {
    [instance, suggestions, findings, summary, schemaGroups, unusedIndexes, redundantIndexes, invalidIndexes] =
      await Promise.all([
        getInstance(instanceId),
        getIndexSuggestions(instanceId),
        getIndexFindings(instanceId),
        getIndexSummary(instanceId),
        getIndexSchemaGroups(instanceId),
        getIndexInventory(instanceId, 'unused', 25),
        getIndexInventory(instanceId, 'redundant', 25),
        getIndexInventory(instanceId, 'invalid', 25),
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
  const unusedFindings = findings.filter((finding) => finding.checkId.includes('unused'));
  const redundantFindings = findings.filter((finding) => !finding.checkId.includes('unused'));
  const unusedCount = summary.unused || unusedFindings.length;
  const redundantCount = summary.redundant || redundantFindings.length;
  const countsFromChecks = summary.total === 0 && findings.length > 0;
  const activeSchema = schemaParam && schemaGroups.some((row) => row.schema === schemaParam) ? schemaParam : null;
  const footprintSchema = fpParam && schemaGroups.some((row) => row.schema === fpParam) ? fpParam : null;
  const footprintQuery = typeof ftParam === 'string' ? ftParam.trim() : '';
  const footprintPage = Math.max(1, Number(fpageParam) || 1);
  const listFilter: 'all' | IndexStatus | 'bloated' = fragmented ? 'bloated' : activeFilter;
  try {
    inventory = fragmented
      ? { rows: await getBloatedIndexes(instanceId, INDEX_PAGE_SIZE), total: 0 }
      : await getIndexPage(instanceId, activeFilter, activeSchema, q, sort, dir, page, INDEX_PAGE_SIZE);
    if (fragmented) inventory = { ...inventory, total: inventory.rows.length };
    tableGroups = await getIndexTableGroups(instanceId, {
      schema: footprintSchema,
      q: footprintQuery || undefined,
      page: footprintPage,
      size: FOOTPRINT_PAGE_SIZE,
    });
  } catch (error) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  const pageCount = Math.max(1, Math.ceil(inventory.total / INDEX_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const footprintPages = Math.max(1, Math.ceil(tableGroups.total / FOOTPRINT_PAGE_SIZE));
  const footprintCurrent = Math.min(footprintPage, footprintPages);
  const footprintSchemas = footprintSchema
    ? schemaGroups.filter((row) => row.schema === footprintSchema)
    : schemaGroups;

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
        href={buildIndexesHref(instanceId, listFilter, activeSchema, {
          q,
          sort: keyName,
          dir: nextDir,
          fp: footprintSchema,
          ft: footprintQuery,
        })}
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
              {engine === 'mariadb'
                ? 'Inventory from information_schema.statistics (+ performance_schema index I/O when enabled). Unused needs P_S; suggestions still come from ANALYZE plans.'
                : engine === 'mssql'
                  ? 'Inventory from sys.indexes, dm_db_index_usage_stats, and partitions. Unused when seeks+scans+lookups=0 (excluding PK / unique clustered).'
                : engine === 'oracle'
                  ? 'Inventory from ALL_INDEXES / ALL_IND_COLUMNS (+ V$OBJECT_USAGE when monitoring is enabled). Plan-based suggestions still apply when ANALYZE plans exist.'
                  : (
                  <>
                    Inventory is what exists on the server (size, scans, overlap). Suggestions come only
                    from <Link href={`/instances/${instanceId}/queries`} className="text-accent">Queries</Link>{' '}
                    with <strong>Executed with ANALYZE</strong> — hypotheses, not DDL Búho will run.
                  </>
                )}
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Indexes"
            value={summary.total > 0 ? formatNumber(summary.total) : countsFromChecks ? formatNumber(findings.length) : formatNumber(0)}
            tone={summary.total === 0 && countsFromChecks ? 'warn' : 'ok'}
            hint={
              summary.capturedAt
                ? `total size ${formatBytes(summary.totalBytes)} · ${formatAgo(summary.capturedAt)}`
                : engine === 'postgres' || engine === 'mariadb' || engine === 'oracle' || engine === 'mssql'
                  ? 'inventory not collected yet'
                  : 'inventory is PostgreSQL / MariaDB / Oracle / SQL Server'
            }
          />
          <StatCard
            label="Unused"
            value={formatNumber(unusedCount)}
            tone={unusedCount > 0 ? 'warn' : 'ok'}
            hint={
              engine === 'mariadb'
                ? 'secondary indexes with zero P_S reads (needs performance_schema)'
                : engine === 'mssql'
                  ? 'non-PK indexes with zero usage in dm_db_index_usage_stats'
                : engine === 'oracle'
                  ? 'monitored indexes with USED=NO in v$object_usage'
                  : 'large secondary indexes with zero scans'
            }
          />
          <StatCard
            label="Redundant"
            value={formatNumber(redundantCount)}
            tone={redundantCount > 0 ? 'warn' : 'ok'}
            hint={
              summary.redundant === 0 && redundantFindings.length > 0
                ? 'from the last 24h check — inventory snapshot is still empty'
                : 'left prefix of another index on the same table'
            }
          />
          <StatCard
            label="Invalid"
            value={formatNumber(summary.invalid)}
            tone={summary.invalid > 0 ? 'error' : 'ok'}
            hint={
              engine === 'postgres'
                ? 'failed CREATE INDEX CONCURRENTLY — rebuild or drop'
                : engine === 'oracle'
                  ? 'UNUSABLE / invalid index status — rebuild or drop'
                  : engine === 'mssql'
                    ? 'disabled or otherwise unusable index — rebuild or drop'
                    : 'unusable / broken index — rebuild or drop'
            }
          />
          <StatCard
            label="Suggestions"
            value={formatNumber(suggestions.suggestions.length)}
            tone={suggestions.suggestions.length > 0 ? 'warn' : 'ok'}
            hint={`from ${formatNumber(suggestions.plansWithActuals)} plan(s) with actuals`}
          />
        </div>

        {engine !== 'postgres' && engine !== 'mariadb' && engine !== 'mssql' && engine !== 'oracle' ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Index inventory</span>
            </div>
            <div className="panel-body text-[12px]">
              Full index listing (size, usage, redundancy) is implemented for PostgreSQL, MariaDB, SQL
              Server, and Oracle. Plan-based suggestions below still apply if you have requested ANALYZE
              plans for this instance.
            </div>
          </section>
        ) : summary.total === 0 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Index inventory</span>
            </div>
            <div className="panel-body text-[12px]">
              {engine === 'mariadb' || engine === 'mssql' || engine === 'oracle'
                ? `No index snapshot yet. The collector refreshes ${
                    engine === 'mssql' ? 'SQL Server' : engine === 'oracle' ? 'Oracle' : 'MariaDB'
                  } indexes every ~15 minutes.`
                : 'No index snapshot yet. The collector refreshes inventory on the same cycle as vacuum (~5 minutes). If this stays empty, restart the collector after migrating the store.'}
            </div>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">{fragmented ? 'Larger than the table' : 'All indexes'}</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  {summary.capturedAt ? `as of ${formatAgo(summary.capturedAt)} · size desc` : ''}
                </span>
              </div>
              <div className="panel-body text-[12px]">
                {engine === 'mariadb'
                  ? 'This inventory comes from information_schema / InnoDB stats: size, usage signals, uniqueness, and overlapping keys on the same table.'
                  : engine === 'mssql'
                    ? 'This inventory comes from SQL Server catalog DMVs: size, seeks/scans, uniqueness, and overlapping keys on the same table.'
                    : engine === 'oracle'
                      ? 'This inventory comes from DBA_/ALL_INDEXES (and related views): size, uniqueness, status, and overlapping keys on the same table.'
                      : 'This inventory comes from PostgreSQL itself: size, scan counters, flags, full definitions, and structural overlap with other indexes on the same table.'}
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
                  <IndexInventoryTable rows={redundantIndexes} instanceId={instanceId} pageSize={25} />
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
                    {engine === 'postgres'
                      ? `${formatNumber(unusedIndexes.length)} above the 10 MB unused threshold`
                      : `${formatNumber(unusedIndexes.length)} with no recorded usage`}
                  </span>
                </div>
                <div className="panel-body">
                  <IndexInventoryTable rows={unusedIndexes} instanceId={instanceId} pageSize={25} />
                  <p className="mt-3 text-[11px] text-foreground-muted">
                    {engine === 'postgres'
                      ? 'Unused means zero scans on a large non-PK index since the last stats reset.'
                      : engine === 'mssql'
                        ? 'Unused means zero seeks/scans/lookups on a non-PK index in dm_db_index_usage_stats.'
                        : engine === 'oracle'
                          ? 'Unused means monitored indexes reported USED=NO in v$object_usage.'
                          : engine === 'mariadb'
                            ? 'Unused means secondary indexes with zero performance_schema reads (when P_S is enabled).'
                            : 'Unused means no recorded usage on a large non-PK index.'}{' '}
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
                  <IndexInventoryTable rows={invalidIndexes} instanceId={instanceId} pageSize={25} />
                  <p className="mt-3 text-[11px] text-foreground-muted">
                    {engine === 'postgres'
                      ? 'PostgreSQL marks an index invalid when a concurrent build fails or is interrupted.'
                      : engine === 'oracle'
                        ? 'Oracle marks an index UNUSABLE after failed rebuilds or certain DDL.'
                        : engine === 'mssql'
                          ? 'SQL Server can leave an index disabled or otherwise unusable after failed rebuilds.'
                          : 'These indexes are flagged unusable by the engine inventory.'}{' '}
                    These objects can consume space without being safe to rely on.
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
                <span className="panel-title">Footprint by schema and table</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  {formatNumber(tableGroups.total)} tables
                </span>
              </div>
              <div className="panel-body">
                <FootprintFilters
                  action={`/instances/${instanceId}/indexes`}
                  status={listFilter}
                  schema={activeSchema}
                  q={q}
                  sort={sort}
                  dir={dir}
                  page={currentPage}
                  schemas={schemaGroups}
                  footprintSchema={footprintSchema}
                  footprintQuery={footprintQuery}
                />
                <div className="table-scroll" style={{ maxHeight: '16rem' }}>
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
                      {footprintSchemas.map((row) => (
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
                <div className="table-scroll mt-4">
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
                      {tableGroups.rows.map((row) => (
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
                <div className="mt-3 flex gap-2">
                  {footprintCurrent > 1 ? (
                    <Link
                      href={buildIndexesHref(instanceId, listFilter, activeSchema, {
                        q,
                        sort,
                        dir,
                        page: currentPage,
                        fp: footprintSchema,
                        ft: footprintQuery,
                        fpage: footprintCurrent - 1,
                      })}
                      className="btn-secondary"
                    >
                      Previous
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
                <IndexInventoryTable rows={sortedRows} instanceId={instanceId} pageSize={50} />
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
                  {engine === 'postgres'
                    ? 'This section does not guess from pg_stat alone. It needs plans executed with ANALYZE so each filter reports how many rows it discarded.'
                    : 'This section does not guess from catalog stats alone. It needs plans executed with real row counts (ANALYZE / actuals) so each filter reports how many rows it discarded.'}{' '}
                  Estimated plans can be wrong by orders of magnitude.
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
            {findings.length > 0 ? (
              <div className="panel-body">
                <IndexFindingsList findings={findings} />
              </div>
            ) : (
              <div className="panel-body">
                <p className="text-[12px] text-foreground-muted">
                  Automated checks have not reported index issues in the last day. The inventory
                  above is refreshed on the collector index cycle
                  {engine === 'postgres' ? ' (~with vacuum)' : ' (~15 minutes)'} and may flag
                  objects before checks run.
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
