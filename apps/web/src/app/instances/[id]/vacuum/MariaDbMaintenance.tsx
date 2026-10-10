import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatNumber } from '@/lib/format';
import {
  getMariaDbMaintenanceTables,
  getMariaDbMaintenanceTotals,
  MARIADB_MAINTENANCE_CHECK_IDS,
  type MariaDbMaintenanceOrder,
} from '@/lib/mariadb-maintenance';
import { getFindings, getInstance, getSeries } from '@/lib/queries';

const ORDERS: { key: MariaDbMaintenanceOrder; label: string }[] = [
  { key: 'size', label: 'Largest' },
  { key: 'free', label: 'Most reclaimable space' },
  { key: 'bloat', label: 'Highest bloat %' },
];

function historyTone(len: number | null): 'error' | 'warn' | 'ok' | 'neutral' {
  if (len === null) return 'neutral';
  if (len > 1_000_000) return 'error';
  if (len > 100_000) return 'warn';
  return 'ok';
}

export async function MariaDbMaintenance({
  instanceId,
  order,
}: {
  instanceId: number;
  order: MariaDbMaintenanceOrder;
}) {
  let instance;
  let tables;
  let totals;
  let series;
  let findings;
  try {
    [instance, tables, totals, series, findings] = await Promise.all([
      getInstance(instanceId),
      getMariaDbMaintenanceTables(instanceId, order, 40),
      getMariaDbMaintenanceTotals(instanceId),
      getSeries(instanceId, ['innodb_history_list_length', 'buffer_pool_dirty_pct'], 1440, 300),
      getFindings(instanceId),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: String(instanceId) }]} />
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
    { label: 'Maintenance' },
  ];

  const maintenanceFindings = findings.filter((f) => MARIADB_MAINTENANCE_CHECK_IDS.has(f.checkId));
  const staleStats = maintenanceFindings.filter((f) => f.checkId === 'mariadb_stale_statistics');
  const checkedAt = findings[0]?.ts ?? null;

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">InnoDB maintenance · {instance.alias}</h1>
            <p className="page-sub">
              MariaDB has no <span className="font-mono">VACUUM</span> — purge and page reclaim happen inside InnoDB.
              This page is the operational analogue: <strong>history list length</strong> (purge lag),{' '}
              <strong>reclaimable table space</strong> from <span className="font-mono">information_schema</span>, and{' '}
              <strong>stale optimizer statistics</strong> from the same checks as Analysis.
            </p>
          </div>
          <Link href={`/instances/${instanceId}/analysis`} className="tag tag--muted">
            open series in Analysis
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine="mariadb" blockedCount={instance.blockedSessions ?? 0} />

        {totals.tables === 0 && (
          <div className="notice notice--warn">
            No table size snapshot yet. The <span className="font-mono">mariadb_table_sizes</span> collector runs on
            the slow tier — expect the first rows within a few minutes after the agent connects.
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="History list length"
            value={totals.historyListLength === null ? '—' : formatNumber(totals.historyListLength)}
            tone={historyTone(totals.historyListLength)}
            hint="InnoDB purge backlog (undo)"
          />
          <StatCard
            label="Tables tracked"
            value={formatNumber(totals.tables)}
            hint="top sizes from collector"
          />
          <StatCard
            label="Reclaimable (data_free)"
            value={formatBytes(totals.totalFreeBytes)}
            tone={totals.totalFreeBytes > 1024 ** 3 ? 'warn' : 'neutral'}
            hint="sum across inventoried tables"
          />
          <StatCard
            label="Stale stats (checks)"
            value={formatNumber(staleStats.length)}
            tone={staleStats.length > 0 ? 'warn' : 'ok'}
            hint="mysql.innodb_table_stats &gt; 30 d"
          />
        </div>

        {maintenanceFindings.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Maintenance findings</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {checkedAt ? `checks ${formatAgo(checkedAt)}` : 'latest check run'}
              </span>
            </div>
            <div className="panel-body space-y-2">
              {maintenanceFindings.slice(0, 12).map((finding) => (
                <div key={`${finding.checkId}:${finding.object ?? ''}:${finding.message}`} className="text-[12px]">
                  <span className={`tag ${finding.severity === 'critical' ? 'tag--error' : finding.severity === 'warning' ? 'tag--warn' : 'tag--muted'}`}>
                    {finding.title}
                  </span>
                  {finding.object ? (
                    <span className="ml-2 font-mono text-[11px] text-foreground-muted">{finding.object}</span>
                  ) : null}
                  <p className="mt-1 text-foreground-secondary">{finding.message}</p>
                  {finding.remediation ? (
                    <p className="mt-0.5 text-[11px] text-foreground-muted">{finding.remediation}</p>
                  ) : null}
                </div>
              ))}
              {maintenanceFindings.length > 12 ? (
                <p className="text-[11px] text-foreground-muted">
                  {formatNumber(maintenanceFindings.length - 12)} more on{' '}
                  <Link href={`/instances/${instanceId}/analysis`} className="underline">
                    Analysis
                  </Link>
                  .
                </p>
              ) : null}
            </div>
          </section>
        )}

        <TimeseriesPanel
          title="InnoDB history list length"
          hint="window 24 h · high values mean purge lag (long transactions or heavy undo)"
          data={series}
          unit="count"
          height={150}
          series={[
            { metric: 'innodb_history_list_length', label: 'History list', color: '#b01818', filled: true },
          ]}
        />

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Sort by</span>
          {ORDERS.map((entry) => (
            <a
              key={entry.key}
              href={`/instances/${instanceId}/vacuum?orden=${entry.key}`}
              className={`tag ${entry.key === order ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.label}
            </a>
          ))}
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Tables · {tables.length}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {totals.capturedAt ? `snapshot ${formatAgo(totals.capturedAt)}` : 'no snapshot'}
            </span>
          </div>

          {tables.length === 0 ? (
            <div className="empty">No table size data yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Index</th>
                    <th className="text-right">Free (data_free)</th>
                    <th className="text-right">Bloat %</th>
                    <th className="text-right">Rows (est.)</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map((row) => (
                    <tr key={`${row.schema}.${row.table}`}>
                      <td className="font-mono text-[11.5px]">
                        <span className="text-foreground-muted">{row.schema}.</span>
                        {row.table}
                      </td>
                      <td className="num">{formatBytes(row.sizeBytes)}</td>
                      <td className="num">{row.indexBytes === null ? '—' : formatBytes(row.indexBytes)}</td>
                      <td className="num">
                        {row.freeBytes === null || row.freeBytes === 0 ? (
                          '—'
                        ) : (
                          <span className={row.freeBytes > 1024 ** 3 ? 'text-[var(--warning)]' : ''}>
                            {formatBytes(row.freeBytes)}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {row.bloatPct === null ? (
                          '—'
                        ) : (
                          <span
                            className={
                              row.bloatPct >= 30
                                ? 'text-[var(--error)]'
                                : row.bloatPct >= 15
                                  ? 'text-[var(--warning)]'
                                  : ''
                            }
                          >
                            {row.bloatPct.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="num text-foreground-muted">
                        {row.liveRows === null ? '—' : formatNumber(row.liveRows)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-[11px] text-foreground-muted">
          <span className="font-mono">data_free</span> is reclaimable space inside the table file when{' '}
          <span className="font-mono">innodb_file_per_table=ON</span> — use{' '}
          <span className="font-mono">OPTIMIZE TABLE</span> or <span className="font-mono">ALTER TABLE … FORCE</span>{' '}
          after confirming purge is healthy. Run <span className="font-mono">ANALYZE TABLE</span> when stale-stats
          findings appear; keep <span className="font-mono">innodb_stats_auto_recalc</span> enabled unless you have a
          deliberate manual schedule.
        </p>
      </div>
    </>
  );
}
