'use client';

import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatPct } from '@/lib/format';

export type EstateDiskTab = 'overview' | 'instance' | 'schema' | 'table' | 'inventory';

const MIN_FORECAST_DAYS = 30;

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle',
};

function formatDays(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return 'now';
  if (days < 2) return `${(days * 24).toFixed(0)} h`;
  if (days < 14) return `${Math.round(days)} d`;
  return `${(days / 7).toFixed(1)} wk`;
}

interface DiskForecast {
  dailyRate: number | null;
  daysToExhaust: number | null;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  rSquared: number | null;
  summary: string;
}

export interface EstateDiskInstanceRow {
  instanceId: number;
  alias: string;
  engine: string;
  sizeBytes: number | null;
  historyDays: number;
  forecast: DiskForecast | null;
}

export interface EstateDiskSchemaRow {
  instanceId: number;
  alias: string;
  engine: string;
  schema: string;
  sizeBytes: number;
  tableCount: number;
}

export interface EstateDiskTableRow {
  instanceId: number;
  alias: string;
  engine: string;
  schema: string;
  table: string;
  sizeBytes: number;
  indexBytes: number | null;
}

export interface EstateDiskSeries {
  bucket: number;
  total: number | null;
  [key: string]: number | null;
}

interface DiskInventoryRow {
  instanceId: number;
  alias: string;
  engine: string;
  name: string;
  container: string;
  sizeBytes: number | null;
  freeBytes: number | null;
  maxBytes: number | null;
  location: string | null;
  detail: Record<string, unknown>;
}

const TABS: { id: EstateDiskTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'instance', label: 'Instance' },
  { id: 'schema', label: 'Schema' },
  { id: 'table', label: 'Table' },
  { id: 'inventory', label: 'Inventory' },
];

function formatRate(f: DiskForecast): string {
  if (f.dailyRate === null) return '—';
  const abs = Math.abs(f.dailyRate);
  const signed = f.dailyRate >= 0 ? '+' : '−';
  return `${signed}${formatBytes(abs)}/d`;
}

export interface EstateDiskViewsProps {
  byInstance: EstateDiskInstanceRow[];
  bySchema: EstateDiskSchemaRow[];
  byTable: EstateDiskTableRow[];
  fleetHistory: { bucket: number; total: number }[];
  instanceSeries: { keys: string[]; points: EstateDiskSeries[] };
  instanceSeriesSpec: { metric: string; label: string; color: string }[];
  fleetForecast: DiskForecast | null;
  forecastableCount: number;
  volumes: DiskInventoryRow[];
  databases: DiskInventoryRow[];
  files: DiskInventoryRow[];
  tablespaces: DiskInventoryRow[];
}

export function EstateDiskViews({
  byInstance,
  bySchema,
  byTable,
  fleetHistory,
  instanceSeries,
  instanceSeriesSpec,
  fleetForecast,
  forecastableCount,
  volumes,
  databases,
  files,
  tablespaces,
}: EstateDiskViewsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: EstateDiskTab = TABS.some((entry) => entry.id === raw) ? (raw as EstateDiskTab) : 'overview';

  function setTab(next: EstateDiskTab) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <nav className="tabs estate-disk-tabs" aria-label="Disk views">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab ${tab === entry.id ? 'is-active' : ''}`}
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <>
          <div
            className={
              instanceSeries.keys.length > 0 ? 'chart-grid chart-grid--2' : undefined
            }
          >
            <TimeseriesPanel
              title="Estate data size over time"
              hint="deduped by server and database · daily rollup"
              data={fleetHistory}
              unit="bytes"
              height={200}
              series={[{ metric: 'total', label: 'Total data', color: '#1f5f8b' }]}
            />

            {instanceSeries.keys.length > 0 ? (
              <TimeseriesPanel
                title="Largest instances"
                hint={`top ${instanceSeries.keys.length} by current size`}
                data={instanceSeries.points}
                unit="bytes"
                height={200}
                series={instanceSeriesSpec}
              />
            ) : null}
          </div>

          {fleetForecast ? (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Fleet growth estimate</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  {fleetHistory.length} days of history · linear fit R²=
                  {fleetForecast.rSquared === null ? '—' : fleetForecast.rSquared.toFixed(2)}
                </span>
              </div>
              <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
                {fleetForecast.summary}
              </div>
            </section>
          ) : (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Growth estimates</span>
              </div>
              <div className="panel-body text-[12px] text-foreground-muted">
                Projections need at least {MIN_FORECAST_DAYS} distinct days of{' '}
                <span className="font-mono">database_size_bytes</span> rollups. The collector runs the slow tier
                periodically — check back once history accumulates.
              </div>
            </section>
          )}
        </>
      ) : null}

      {tab === 'overview' || tab === 'instance' ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">By instance</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              from metrics · connected databases summed
            </span>
          </div>
          {byInstance.length === 0 ? (
            <div className="empty">No database size metrics yet.</div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: '32rem' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Engine</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Growth</th>
                    <th>Projection</th>
                  </tr>
                </thead>
                <tbody>
                  {byInstance.map((row) => (
                    <tr key={row.instanceId}>
                      <td>
                        <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {ENGINE_LABEL[row.engine] ?? row.engine}
                      </td>
                      <td className="num">{formatBytes(row.sizeBytes)}</td>
                      <td className="num text-[11px] text-foreground-secondary">
                        {row.forecast ? formatRate(row.forecast) : `${row.historyDays}d hist.`}
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {row.forecast ? (
                          <span
                            className={`tag ${
                              row.forecast.tone === 'error'
                                ? 'tag--error'
                                : row.forecast.tone === 'warn'
                                  ? 'tag--warn'
                                  : 'tag--muted'
                            }`}
                          >
                            {formatDays(row.forecast.daysToExhaust)} to ×2
                          </span>
                        ) : (
                          <span className="text-foreground-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {forecastableCount > 0 ? (
            <p className="border-t border-border px-3 py-2 text-[11px] text-foreground-muted">
              Projections use a linear fit on daily totals and assume growth to twice the current size. Only shown
              with {MIN_FORECAST_DAYS}+ days of history ({forecastableCount} of {byInstance.length} instances).
            </p>
          ) : null}
        </section>
      ) : null}

      {tab === 'schema' ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">By schema</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              sum of top tables per connected database
            </span>
          </div>
          {bySchema.length === 0 ? (
            <div className="empty">No table size metrics yet — the slow collector tier fills this in.</div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: '32rem' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Schema</th>
                    <th className="text-right">Tables</th>
                    <th className="text-right">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {bySchema.map((row, index) => (
                    <tr key={`${row.instanceId}-${row.schema}-${index}`}>
                      <td>
                        <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                      </td>
                      <td className="font-mono text-[11px]">{row.schema}</td>
                      <td className="num">{row.tableCount}</td>
                      <td className="num">{formatBytes(row.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'table' ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">By table</span>
            <span className="font-mono text-[10px] text-foreground-muted">largest across the estate</span>
          </div>
          {byTable.length === 0 ? (
            <div className="empty">No table size metrics yet.</div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: '36rem' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Schema</th>
                    <th>Table</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Indexes</th>
                  </tr>
                </thead>
                <tbody>
                  {byTable.map((row, index) => (
                    <tr key={`${row.instanceId}-${row.schema}-${row.table}-${index}`}>
                      <td>
                        <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                      </td>
                      <td className="font-mono text-[11px]">{row.schema}</td>
                      <td className="font-mono text-[11px]">{row.table}</td>
                      <td className="num">{formatBytes(row.sizeBytes)}</td>
                      <td className="num">{formatBytes(row.indexBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'inventory' ? (
        <div className="flex flex-col gap-[0.875rem]">
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Databases by size</span>
              <span className="font-mono text-[10px] text-foreground-muted">inventory snapshot</span>
            </div>
            {databases.length === 0 ? (
              <div className="empty">No size data yet.</div>
            ) : (
              <div className="table-scroll" style={{ maxHeight: '22rem' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Engine</th>
                      <th>Database</th>
                      <th className="text-right">Size</th>
                      <th className="text-right">Log / indexes</th>
                      <th className="text-right">Reclaimable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {databases.map((row, index) => (
                      <tr key={`${row.instanceId}-${row.name}-${index}`}>
                        <td>
                          <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                            {row.alias}
                          </Link>
                        </td>
                        <td className="text-[11px] text-foreground-secondary">
                          {ENGINE_LABEL[row.engine] ?? row.engine}
                        </td>
                        <td className="font-mono text-[11px]">{row.name}</td>
                        <td className="num">{formatBytes(row.sizeBytes)}</td>
                        <td className="num">
                          {formatBytes(
                            (row.detail['log_bytes'] as number | undefined) ??
                              (row.detail['index_bytes'] as number | undefined) ??
                              null,
                          )}
                        </td>
                        <td className="num">{row.freeBytes ? formatBytes(row.freeBytes) : '·'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {tablespaces.length > 0 ? (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Tablespaces</span>
              </div>
              <div className="table-scroll" style={{ maxHeight: '18rem' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Name</th>
                      <th className="text-right">Size</th>
                      <th>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tablespaces.map((row, index) => (
                      <tr key={`${row.instanceId}-${row.name}-${index}`}>
                        <td>{row.alias}</td>
                        <td className="font-mono text-[11px]">{row.name}</td>
                        <td className="num">{formatBytes(row.sizeBytes)}</td>
                        <td className="font-mono text-[10px] text-foreground-muted">{row.location ?? '·'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {volumes.length > 0 ? (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Volumes</span>
                <span className="font-mono text-[10px] text-foreground-muted">filesystem · hourly inventory</span>
              </div>
              <div className="table-scroll" style={{ maxHeight: 'none' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Volume</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Free</th>
                      <th className="text-right">Usage</th>
                      <th>Filesystem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {volumes.map((row, index) => {
                      const usedPct =
                        row.sizeBytes && row.freeBytes !== null
                          ? ((row.sizeBytes - (row.freeBytes ?? 0)) / row.sizeBytes) * 100
                          : null;
                      return (
                        <tr key={`${row.instanceId}-${row.name}-${index}`}>
                          <td>
                            <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                              {row.alias}
                            </Link>
                          </td>
                          <td className="font-mono text-[11px]">{row.name}</td>
                          <td className="num">{formatBytes(row.sizeBytes)}</td>
                          <td className="num">{formatBytes(row.freeBytes)}</td>
                          <td className="num">
                            <div className="flex items-center justify-end gap-1">
                              <div className="bar" style={{ minWidth: 40, width: 40 }}>
                                <div
                                  className={`bar__fill ${
                                    (usedPct ?? 0) >= 90
                                      ? 'bar__fill--error'
                                      : (usedPct ?? 0) >= 80
                                        ? 'bar__fill--warn'
                                        : ''
                                  }`}
                                  style={{ width: `${Math.min(100, usedPct ?? 0)}%` }}
                                />
                              </div>
                              {formatPct(usedPct, 1)}
                            </div>
                          </td>
                          <td className="text-[11px] text-foreground-secondary">
                            {(row.detail['file_system'] as string) ?? '·'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {files.length > 0 ? (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Data and log files</span>
                <span className="font-mono text-[10px] text-foreground-muted">SQL Server · declared ceiling</span>
              </div>
              <div className="table-scroll" style={{ maxHeight: '24rem' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Database</th>
                      <th>File</th>
                      <th>Type</th>
                      <th className="text-right">Size</th>
                      <th className="text-right">Ceiling</th>
                      <th>Growth</th>
                      <th>Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((row, index) => (
                      <tr key={`${row.instanceId}-${row.container}-${row.name}-${index}`}>
                        <td>{row.alias}</td>
                        <td className="font-mono text-[11px]">{row.container}</td>
                        <td className="font-mono text-[11px]">{row.name}</td>
                        <td className="text-[11px]">{(row.detail['type'] as string) ?? '·'}</td>
                        <td className="num">{formatBytes(row.sizeBytes)}</td>
                        <td className="num">
                          {row.maxBytes ? (
                            <span
                              className={row.sizeBytes && row.sizeBytes / row.maxBytes > 0.7 ? 'tag tag--warn' : ''}
                            >
                              {formatBytes(row.maxBytes)}
                            </span>
                          ) : (
                            'unlimited'
                          )}
                        </td>
                        <td className="text-[11px]">
                          {row.detail['growth']
                            ? `${row.detail['growth']}${row.detail['percent_growth'] ? ' %' : ' pages'}`
                            : '·'}
                        </td>
                        <td className="max-w-0 truncate font-mono text-[10px] text-foreground-muted">
                          {row.location ?? '·'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
