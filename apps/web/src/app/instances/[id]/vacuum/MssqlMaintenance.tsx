import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatNumber } from '@/lib/format';
import {
  getMssqlHeapPressure,
  getMssqlIndexFragmentation,
  getMssqlMaintenanceTotals,
} from '@/lib/mssql-maintenance';
import { getFindings, getInstance, getSeries } from '@/lib/queries';

const FORWARDED_CHECK = 'mssql_forwarded_records';

function forwardedTone(count: number): 'error' | 'warn' | 'ok' | 'neutral' {
  if (count > 1_000_000) return 'error';
  if (count > 100_000) return 'warn';
  if (count > 10_000) return 'ok';
  return 'neutral';
}

function fragmentationTone(pct: number): 'error' | 'warn' | 'ok' | 'neutral' {
  if (pct >= 50) return 'error';
  if (pct >= 30) return 'warn';
  if (pct >= 10) return 'ok';
  return 'neutral';
}

export async function MssqlMaintenance({ instanceId }: { instanceId: number }) {
  let instance;
  let heaps;
  let fragmentation;
  let totals;
  let series;
  let findings;
  try {
    [instance, heaps, fragmentation, totals, series, findings] = await Promise.all([
      getInstance(instanceId),
      getMssqlHeapPressure(instanceId),
      getMssqlIndexFragmentation(instanceId),
      getMssqlMaintenanceTotals(instanceId),
      getSeries(instanceId, ['page_splits'], 1440, 300),
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

  const forwardedFindings = findings.filter((f) => f.checkId === FORWARDED_CHECK);
  const checkedAt = findings[0]?.ts ?? totals.capturedAt;

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Maintenance · {instance.alias}</h1>
            <p className="page-sub">
              SQL Server has no <span className="font-mono">VACUUM</span> — heap forwarded records and index
              fragmentation are the closest analogues. Forwarded fetches accumulate since restart; fragmentation
              uses <span className="font-mono">dm_db_index_physical_stats</span> in <strong>SAMPLED</strong> mode
              (top offenders only).
            </p>
          </div>
          <Link href={`/instances/${instanceId}/analysis`} className="tag tag--muted">
            open series in Analysis
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine="mssql" blockedCount={instance.blockedSessions ?? 0} />

        {totals.heapRows === 0 && totals.fragmentationRows === 0 && (
          <div className="notice notice--warn">
            No maintenance snapshot yet. The collector samples heaps and fragmented indexes every ~15 minutes.
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="Forwarded fetches (tracked heaps)"
            value={formatNumber(totals.forwardedTotal)}
            tone={forwardedTone(totals.forwardedTotal)}
            hint="since last restart · operational stats"
          />
          <StatCard
            label="Heaps over 10k forwards"
            value={formatNumber(totals.heapsOver10k)}
            tone={totals.heapsOver10k > 0 ? 'warn' : 'ok'}
            hint="matches check threshold"
          />
          <StatCard
            label="Fragmented indexes"
            value={formatNumber(totals.fragmentationRows)}
            tone={totals.fragmentationRows > 0 ? 'warn' : 'ok'}
            hint="≥10% frag, ≥512 pages"
          />
          <StatCard
            label="Worst fragmentation"
            value={totals.worstFragmentationPct === null ? '—' : `${totals.worstFragmentationPct.toFixed(1)}%`}
            tone={
              totals.worstFragmentationPct === null
                ? 'neutral'
                : fragmentationTone(totals.worstFragmentationPct)
            }
            hint="sampled physical stats"
          />
        </div>

        {forwardedFindings.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Check findings · heap pressure</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {checkedAt ? `checks ${formatAgo(checkedAt)}` : 'latest check run'}
              </span>
            </div>
            <div className="panel-body space-y-2">
              {forwardedFindings.slice(0, 10).map((finding) => (
                <div key={`${finding.checkId}:${finding.object ?? ''}`} className="text-[12px]">
                  <span
                    className={`tag ${finding.severity === 'critical' ? 'tag--error' : finding.severity === 'warning' ? 'tag--warn' : 'tag--muted'}`}
                  >
                    {finding.title}
                  </span>
                  {finding.object ? (
                    <span className="ml-2 font-mono text-[11px] text-foreground-muted">{finding.object}</span>
                  ) : null}
                  <p className="mt-1 text-foreground-secondary">{finding.message}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <TimeseriesPanel
          title="Page splits"
          hint="window 24 h · Access Methods counter"
          data={series}
          unit="rate"
          height={150}
          series={[{ metric: 'page_splits', label: 'Page splits/sec', color: '#9a4a00' }]}
        />

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Heap forwarded records · {heaps.length}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {totals.capturedAt ? `snapshot ${formatAgo(totals.capturedAt)}` : 'no snapshot'}
            </span>
          </div>
          {heaps.length === 0 ? (
            <div className="empty">No heap pressure rows yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th className="text-right">Forwarded fetches</th>
                    <th className="text-right">Leaf writes</th>
                  </tr>
                </thead>
                <tbody>
                  {heaps.map((row) => (
                    <tr key={`${row.schema}.${row.table}`}>
                      <td className="font-mono text-[11.5px]">
                        <span className="text-foreground-muted">{row.schema}.</span>
                        {row.table}
                      </td>
                      <td className="num">
                        <span className={forwardedTone(row.forwardedFetchCount) === 'neutral' ? '' : 'text-[var(--warning)]'}>
                          {formatNumber(row.forwardedFetchCount)}
                        </span>
                      </td>
                      <td className="num">{formatNumber(row.writeCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Index fragmentation · {fragmentation.length}</span>
            <span className="font-mono text-[10px] text-foreground-muted">SAMPLED · top offenders</span>
          </div>
          {fragmentation.length === 0 ? (
            <div className="empty">No fragmented indexes above threshold in the last sample.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Index</th>
                    <th className="text-right">Fragmentation</th>
                    <th className="text-right">Pages</th>
                  </tr>
                </thead>
                <tbody>
                  {fragmentation.map((row) => (
                    <tr key={`${row.schema}.${row.table}.${row.indexName}`}>
                      <td className="font-mono text-[11.5px]">
                        <span className="text-foreground-muted">{row.schema}.{row.table}.</span>
                        {row.indexName}
                      </td>
                      <td className="num">
                        <span className={fragmentationTone(row.fragmentationPct) === 'neutral' ? '' : 'text-[var(--warning)]'}>
                          {row.fragmentationPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="num">{formatNumber(row.pageCount)}</td>
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
