import { Suspense } from 'react';
import { NotesPanel } from '@/components/NotesPanel';
import { EstateDiskViews } from '@/components/EstateDiskViews';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatPct } from '@/lib/format';
import { formatDays, type CapacityForecast } from '@/lib/capacity';
import {
  getEstateDiskByInstance,
  getEstateDiskBySchema,
  getEstateDiskByTable,
  getEstateDiskByEngineSeries,
  getEstateDiskFleetForecast,
  getEstateDiskFleetHistory,
  getEstateDiskInstanceSeries,
  MIN_FORECAST_DAYS,
} from '@/lib/disk-estate';
import { getDiskUsage, getNotes, type DiskRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';

const INSTANCE_COLORS = ['#1f5f8b', '#0a6e42', '#b45309', '#7c3aed', '#be123c'];
const ENGINE_COLORS: Record<string, string> = {
  postgres: '#1f5f8b',
  mariadb: '#0a6e42',
  mssql: '#b45309',
  mongodb: '#7c3aed',
  redis: '#dc382c',
  oracle: '#f80000',
  cassandra: '#1287b1',
  elasticsearch: '#fec33d',
};
const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle',
  cassandra: 'Cassandra',
  elasticsearch: 'Elasticsearch',
};

function forecastTone(f: CapacityForecast): 'ok' | 'warn' | 'error' | 'neutral' {
  return f.tone;
}

function formatRate(f: CapacityForecast): string {
  if (f.dailyRate === null) return '—';
  const abs = Math.abs(f.dailyRate);
  const signed = f.dailyRate >= 0 ? '+' : '−';
  return `${signed}${formatBytes(abs)}/d`;
}

export default async function DiskPage() {
  let rows: DiskRow[];
  let notes;
  let byInstance;
  let bySchema;
  let byTable;
  let fleetHistory;
  let instanceSeries;
  let fleetForecast;
  let engineSeries;
  try {
    [rows, notes, byInstance, bySchema, byTable, fleetHistory, instanceSeries, fleetForecast, engineSeries] =
      await Promise.all([
        getDiskUsage(),
        getNotes('disk'),
        getEstateDiskByInstance(),
        getEstateDiskBySchema(),
        getEstateDiskByTable(),
        getEstateDiskFleetHistory(),
        getEstateDiskInstanceSeries(),
        getEstateDiskFleetForecast(),
        getEstateDiskByEngineSeries(30),
      ]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const volumes = rows.filter((row) => row.kind === 'volume');
  const databases = rows.filter((row) => row.kind === 'database');
  const files = rows.filter((row) => row.kind === 'file');
  const tablespaces = rows.filter((row) => row.kind === 'tablespace');

  const totalData = databases.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  const metricTotal = byInstance.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  const tightest = volumes
    .filter((row) => row.sizeBytes && row.freeBytes !== null)
    .map((row) => ({ row, pct: ((row.freeBytes ?? 0) / (row.sizeBytes ?? 1)) * 100 }))
    .sort((a, b) => a.pct - b.pct)[0];
  const capped = files.filter((row) => row.maxBytes && row.sizeBytes && row.sizeBytes / row.maxBytes > 0.7);
  const forecastableCount = byInstance.filter((row) => row.forecast !== null).length;

  const fleetChartData = fleetHistory.map((point) => ({
    bucket: point.bucket,
    total: point.value,
  }));

  const instanceSeriesSpec = [
    { metric: 'total', label: 'Fleet total', color: '#4a525c' },
    ...instanceSeries.keys.map((alias, index) => ({
      metric: alias,
      label: alias,
      color: INSTANCE_COLORS[index % INSTANCE_COLORS.length]!,
    })),
  ];

  const serialForecast = fleetForecast
    ? {
        dailyRate: fleetForecast.dailyRate,
        daysToExhaust: fleetForecast.daysToExhaust,
        tone: fleetForecast.tone,
        rSquared: fleetForecast.rSquared,
        summary: fleetForecast.summary,
      }
    : null;

  const serialInstances = byInstance.map((row) => ({
    instanceId: row.instanceId,
    alias: row.alias,
    engine: row.engine,
    sizeBytes: row.sizeBytes,
    historyDays: row.historyDays,
    forecast: row.forecast
      ? {
          dailyRate: row.forecast.dailyRate,
          daysToExhaust: row.forecast.daysToExhaust,
          tone: row.forecast.tone,
          rSquared: row.forecast.rSquared,
          summary: row.forecast.summary,
        }
      : null,
  }));

  const toInventory = (row: DiskRow) => ({
    instanceId: row.instanceId,
    alias: row.alias,
    engine: row.engine,
    name: row.name,
    container: row.container,
    sizeBytes: row.sizeBytes,
    freeBytes: row.freeBytes,
    maxBytes: row.maxBytes,
    location: row.location,
    detail: row.detail,
  });

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Data in the estate"
          value={formatBytes(metricTotal > 0 ? metricTotal : totalData)}
          hint={`${byInstance.length || databases.length} instances with size data`}
        />
        <StatCard
          label="Tightest volume"
          value={tightest ? formatPct(tightest.pct, 1) : '—'}
          hint={tightest ? `free on ${tightest.row.alias}` : 'no volume data'}
          tone={tightest && tightest.pct < 10 ? 'error' : tightest && tightest.pct < 20 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Files near ceiling"
          value={String(capped.length)}
          hint="over 70% of declared max size"
          tone={capped.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Growth projections"
          value={fleetForecast ? formatDays(fleetForecast.daysToExhaust) : '—'}
          hint={
            fleetForecast
              ? `fleet · ${formatRate(fleetForecast)}`
              : `need ${MIN_FORECAST_DAYS}+ days of history`
          }
          tone={fleetForecast ? forecastTone(fleetForecast) : 'neutral'}
        />
      </div>

      <NotesPanel notes={notes} />

      {engineSeries.keys.length > 0 ? (
        <div className="chart-panel--full">
          <TimeseriesPanel
            title="Data size by engine · 30d"
            hint="daily sum of database_size_bytes · deduped by host/port/database"
            data={engineSeries.points}
            unit="bytes"
            height={220}
            series={engineSeries.keys.map((engine) => ({
              metric: engine,
              label: ENGINE_LABEL[engine] ?? engine,
              color: ENGINE_COLORS[engine] ?? '#4a525c',
            }))}
          />
        </div>
      ) : null}

      <Suspense fallback={<div className="empty">Loading disk views…</div>}>
        <EstateDiskViews
          byInstance={serialInstances}
          bySchema={bySchema}
          byTable={byTable}
          fleetHistory={fleetChartData}
          instanceSeries={instanceSeries}
          instanceSeriesSpec={instanceSeriesSpec}
          fleetForecast={serialForecast}
          forecastableCount={forecastableCount}
          volumes={volumes.map(toInventory)}
          databases={databases.map(toInventory)}
          files={files.map(toInventory)}
          tablespaces={tablespaces.map(toInventory)}
        />
      </Suspense>
    </div>
  );
}
