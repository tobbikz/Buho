import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnomalyPanel } from '@/components/AnomalyPanel';
import { FindingsPanel } from '@/components/FindingsPanel';
import { InstanceEvents } from '@/components/InstanceEvents';
import { SubscriptionTable } from '@/components/SubscriptionTable';
import { IncidentPanel } from '@/components/IncidentPanel';
import { InstanceTabs } from '@/components/InstanceTabs';
import { ForeignSummary } from '@/components/ForeignSummary';
import { MongoSummary } from '@/components/MongoSummary';
import { RedisSummary } from '@/components/RedisSummary';
import { OracleSummary } from '@/components/OracleSummary';
import { CassandraSummary } from '@/components/CassandraSummary';
import { ElasticsearchSummary } from '@/components/ElasticsearchSummary';
import { LabeledBars, type BarRow } from '@/components/LabeledBars';
import { StatCard, toneForMinimum, toneForPct, toneForScore } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { TimeoutScatter } from '@/components/TimeoutScatter';
import { Topbar } from '@/components/Topbar';
import {
  formatAgo,
  formatBytes,
  formatClock,
  formatCompactNumber,
  formatDuration,
  formatNumber,
  formatPct,
  formatVersion,
} from '@/lib/format';
import { getAnomalies, getBaselineCoverage } from '@/lib/baselines';
import { ENGINE_LABEL, getInstanceEngine } from '@/lib/estate';
import { explainIncident } from '@/lib/incident';
import { getTimeoutEvents } from '@/lib/logs';
import { postureHint } from '@/lib/health-posture';
import {
  getEvents,
  getFindings,
  getInstance,
  getLabeled,
  getLabeledPair,
  getHostSummary,
  getSeries,
  getSeriesByLabel,
  seriesSource,
} from '@/lib/queries';
import { peakOf, peakOfDerived } from '@/lib/series-peak';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '15m', minutes: 15, bucketSeconds: 30 },
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
  // 7 días sólo es viable leyendo rollups; sobre raw samples serían
  // ~60.000 filas por métrica.
  { key: '7d', minutes: 10_080, bucketSeconds: 3_600 },
] as const;

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
  muted: '#7a828c',
};

// Paleta para series de cardinalidad desconocida (clases de espera).
const WAIT_COLORS = ['#0a6e42', '#005eb8', '#9a4a00', '#b01818', '#7a828c'];

const STAT_STATEMENTS_LABEL: Record<string, string> = {
  active: 'pg_stat_statements active',
  preloaded_not_created: 'pg_stat_statements preloaded, not created',
  not_preloaded: 'pg_stat_statements not preloaded',
};

export default async function InstancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { id } = await params;
  const { w } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1];
  // Decir de dónde sale el dato: un promedio de rollup no es lo mismo que una
  // muestra cruda, y quien mira un pico tiene derecho a saberlo.
  const windowHint = `window ${window.key} · ${seriesSource(window.minutes).label}`;

  // El store se consulta en dos pasos para que notFound() never caiga en el
  // catch: es una excepción de control de Next, no un error de base de datos.
  let instance;
  try {
    instance = await getInstance(instanceId);
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

  // MariaDB y SQL Server tienen su propio resumen: las mismas preguntas, con
  // los indicadores que cada motor sí puede contestar. El inventario, que antes
  // era toda su pantalla, ahora es una pestaña más.
  const engine = await getInstanceEngine(instanceId);
  if (
    engine === 'mariadb' ||
    engine === 'mssql' ||
    engine === 'mongodb' ||
    engine === 'redis' ||
    engine === 'oracle' ||
    engine === 'cassandra' ||
    engine === 'elasticsearch'
  ) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: instance.alias }]} />
        <div className="page">
          <header className="page-header">
            <div>
              <h1 className="page-title">{instance.alias}</h1>
              <p className="page-sub font-mono">
                {instance.host}:{instance.port}
                {instance.database ? `/${instance.database}` : ''}
              </p>
              <div className="mt-[0.375rem] flex flex-wrap items-center gap-1">
                <span className="tag tag--muted">{instance.environment}</span>
                <span className="tag tag--info">{ENGINE_LABEL[engine] ?? engine}</span>
                <span className="font-mono text-[10px] text-foreground-muted">
                  seen {formatAgo(instance.lastSeenAt)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {WINDOWS.map((candidate) => (
                <Link
                  key={candidate.key}
                  href={`/instances/${instanceId}?w=${candidate.key}`}
                  className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {candidate.key}
                </Link>
              ))}
            </div>
          </header>
          <InstanceTabs
            instanceId={instanceId}
            engine={engine}
            blockedCount={instance.blockedSessions ?? 0}
          />
          {engine === 'mongodb' ? (
            <MongoSummary
              instanceId={instanceId}
              windowMinutes={window.minutes}
              bucketSeconds={window.bucketSeconds}
              windowHint={windowHint}
            />
          ) : engine === 'redis' ? (
            <RedisSummary
              instanceId={instanceId}
              windowMinutes={window.minutes}
              bucketSeconds={window.bucketSeconds}
              windowHint={windowHint}
            />
          ) : engine === 'oracle' ? (
            <OracleSummary
              instanceId={instanceId}
              windowMinutes={window.minutes}
              bucketSeconds={window.bucketSeconds}
              windowHint={windowHint}
            />
          ) : engine === 'cassandra' ? (
            <CassandraSummary
              instanceId={instanceId}
              windowMinutes={window.minutes}
              bucketSeconds={window.bucketSeconds}
              windowHint={windowHint}
            />
          ) : engine === 'elasticsearch' ? (
            <ElasticsearchSummary
              instanceId={instanceId}
              windowMinutes={window.minutes}
              bucketSeconds={window.bucketSeconds}
              windowHint={windowHint}
            />
          ) : (
            <ForeignSummary
              instanceId={instanceId}
              engine={engine}
              windowMinutes={window.minutes}
              bucketSeconds={window.bucketSeconds}
              windowHint={windowHint}
            />
          )}
        </div>
      </>
    );
  }

  let data;
  try {
    const [
      connections,
      throughput,
      wal,
      blocking,
      dml,
      waitClasses,
      cache,
      io,
      checkpoints,
      tempFiles,
      timeouts,
      findings,
      waitEvents,
      tables,
      deadTuples,
      slots,
      subscriptions,
      events,
      host,
      hostCpu,
      anomalies,
      baselineCoverage,
      incident,
    ] = await Promise.all([
        getSeries(
          instanceId,
          [
            'connections_total',
            'connections_active',
            'connections_idle_in_transaction',
            'connections_used_pct',
          ],
          window.minutes,
          window.bucketSeconds,
        ),
        getSeries(
          instanceId,
          ['db_xact_commit_per_sec', 'db_xact_rollback_per_sec'],
          window.minutes,
          window.bucketSeconds,
        ),
        getSeries(instanceId, ['wal_bytes_per_sec'], window.minutes, window.bucketSeconds),
        getSeries(instanceId, ['blocked_sessions', 'max_blocked_seconds'], window.minutes, window.bucketSeconds),
        getSeries(
          instanceId,
          ['db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec'],
          window.minutes,
          window.bucketSeconds,
        ),
        getSeriesByLabel(
          instanceId,
          'wait_event_sessions',
          'wait_event_type',
          window.minutes,
          window.bucketSeconds,
          5,
        ),
        // min entre bases: el porcentaje no se suma, y el worst case es el que
        // importa (mismo criterio que el indicador de arriba).
        getSeries(instanceId, ['db_cache_hit_pct'], window.minutes, window.bucketSeconds, 'min'),
        getSeries(
          instanceId,
          ['io_reads_per_sec', 'io_writes_per_sec', 'db_temp_bytes_per_sec'],
          window.minutes,
          window.bucketSeconds,
        ),
        getSeries(
          instanceId,
          [
            'checkpoint_num_timed_per_sec',
            'checkpoint_num_requested_per_sec',
            'checkpoint_buffers_written_per_sec',
          ],
          window.minutes,
          window.bucketSeconds,
        ),
        getSeries(
          instanceId,
          ['db_temp_files_per_sec', 'db_temp_bytes_per_sec'],
          window.minutes,
          window.bucketSeconds,
        ),
        getTimeoutEvents(instanceId, window.minutes),
        getFindings(instanceId),
        getLabeled(instanceId, 'wait_event_sessions', 10, 5),
        getLabeledPair(instanceId, 'table_total_bytes', 'table_index_bytes', 10, 30),
        getLabeledPair(instanceId, 'table_dead_tuples', 'table_dead_pct', 8, 30),
        getLabeled(instanceId, 'replication_slot_active', 10, 30),
        getLabeledPair(
          instanceId,
          'replication_subscription_worker',
          'replication_subscription_lag_seconds',
          20,
          30,
        ),
        getEvents(instanceId, 10),
        // Recursos reales del host. Devuelve null si la instancia no los
        // declara, y en ese caso el Resumen sigue mostrando sólo las
        // aproximaciones que salen de la base.
        getHostSummary(instanceId),
        getSeries(
          instanceId,
          ['host_cpu_pct', 'host_cpu_iowait_pct', 'host_mem_used_pct'],
          window.minutes,
          window.bucketSeconds,
          'avg',
        ),
        getAnomalies(instanceId, 8),
        getBaselineCoverage(instanceId),
        explainIncident(instanceId, window.minutes),
      ]);

    data = {
      connections,
      throughput,
      wal,
      blocking,
      dml,
      waitClasses,
      cache,
      io,
      checkpoints,
      tempFiles,
      timeouts,
      findings,
      waitEvents,
      tables,
      deadTuples,
      slots,
      subscriptions,
      events,
      host,
      hostCpu,
      anomalies,
      baselineCoverage,
      incident,
    };
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

  const { findings } = data;
  const healthPosture = postureHint(findings);
  const worstDeadPct = data.deadTuples.reduce((peak, row) => Math.max(peak, row.valueB ?? 0), 0);

  // Throughput como número, no sólo como chart: el último bucket con dato de
  // las tres tasas de tuplas. Se recorre desde el final porque el bucket en
  // curso puede estar todavía vacío.
  const dmlPerSec = (() => {
    for (let index = data.dml.length - 1; index >= 0; index -= 1) {
      const point = data.dml[index];
      if (!point) continue;
      const total =
        (point['db_tup_inserted_per_sec'] ?? 0) +
        (point['db_tup_updated_per_sec'] ?? 0) +
        (point['db_tup_deleted_per_sec'] ?? 0);
      if (
        point['db_tup_inserted_per_sec'] !== null ||
        point['db_tup_updated_per_sec'] !== null ||
        point['db_tup_deleted_per_sec'] !== null
      ) {
        return total;
      }
    }
    return null;
  })();

  const peakConnPct = peakOf(data.connections, 'connections_used_pct');
  const peakCommit = peakOf(data.throughput, 'db_xact_commit_per_sec');
  const peakDml = peakOfDerived(data.dml, (point) => {
    if (
      point['db_tup_inserted_per_sec'] === null &&
      point['db_tup_updated_per_sec'] === null &&
      point['db_tup_deleted_per_sec'] === null
    ) {
      return null;
    }
    return (
      (point['db_tup_inserted_per_sec'] ?? 0) +
      (point['db_tup_updated_per_sec'] ?? 0) +
      (point['db_tup_deleted_per_sec'] ?? 0)
    );
  });
  const peakTempBytes = peakOf(data.tempFiles, 'db_temp_bytes_per_sec');
  const peakTempFiles = peakOf(data.tempFiles, 'db_temp_files_per_sec');

  const waitRows: BarRow[] = data.waitEvents.map((row) => ({
    label: row.labels['wait_event'] ?? '—',
    sub: row.labels['wait_event_type'],
    value: row.value,
    display: formatNumber(row.value),
    tone: row.labels['wait_event_type'] === 'Lock' ? 'error' : 'accent',
  }));

  const tableRows: BarRow[] = data.tables.map((row) => ({
    label: `${row.labels['schema']}.${row.labels['table']}`,
    sub: [
      row.labels['partitions'] ? `${row.labels['partitions']} partitions` : null,
      row.valueB !== null ? `indexes ${formatBytes(row.valueB)}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || undefined,
    value: row.value,
    display: formatBytes(row.value),
  }));

  const deadRows: BarRow[] = data.deadTuples.map((row) => ({
    label: `${row.labels['schema']}.${row.labels['table']}`,
    sub: row.valueB !== null ? `${formatPct(row.valueB, 1)} dead` : undefined,
    value: row.value,
    display: formatNumber(row.value),
    tone: (row.valueB ?? 0) >= 20 ? 'error' : (row.valueB ?? 0) >= 10 ? 'warn' : 'accent',
  }));

  const inactiveSlots = data.slots.filter((slot) => slot.value === 0);

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: instance.alias }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">{instance.alias}</h1>
            <p className="page-sub font-mono">
              {instance.host}:{instance.port}/{instance.database}
            </p>
            <div className="mt-[0.375rem] flex flex-wrap items-center gap-1">
              <span className="tag tag--muted">{instance.environment}</span>
              <span className="tag tag--muted">PG {formatVersion(instance.versionNum)}</span>
              <span className={`tag ${instance.inRecovery ? 'tag--info' : 'tag--muted'}`}>
                {instance.inRecovery ? 'standby' : 'primary'}
              </span>
              <span className={`tag ${instance.hasPgMonitor ? 'tag--ok' : 'tag--warn'}`}>
                {instance.hasPgMonitor ? 'pg_monitor' : 'no pg_monitor'}
              </span>
              <span className={`tag ${instance.statStatements === 'active' ? 'tag--ok' : 'tag--warn'}`}>
                {instance.statStatements === 'active' ? 'stat_statements' : 'stat_statements off'}
              </span>
              <span className={`tag ${instance.trackIoTiming ? 'tag--ok' : 'tag--muted'}`}>
                {instance.trackIoTiming ? 'track_io_timing' : 'io_timing off'}
              </span>
              <span className="font-mono text-[10px] text-foreground-muted">
                seen {formatAgo(instance.lastSeenAt)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((candidate) => (
              <Link
                key={candidate.key}
                href={`/instances/${instance.instanceId}?w=${candidate.key}`}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </Link>
            ))}
          </div>
        </header>

        <InstanceTabs instanceId={instance.instanceId} blockedCount={instance.blockedSessions ?? 0} />

        {instance.statStatements !== 'active' && (
          <div className="panel" style={{ borderLeft: '3px solid var(--warning)' }}>
            <div className="panel-body text-[12px]">
              <strong>{STAT_STATEMENTS_LABEL[instance.statStatements ?? 'not_preloaded']}.</strong> Without this
              extension there is no per-query analysis.{' '}
              {instance.statStatements === 'preloaded_not_created'
                ? 'The library is already loaded: CREATE EXTENSION pg_stat_statements is enough, no restart.'
                : 'Adding pg_stat_statements to shared_preload_libraries requires a server restart.'}
            </div>
          </div>
        )}

        {data.host ? (
          <div className="chart-panel--full">
            <TimeseriesPanel
              title="Host CPU and memory"
              hint={`${formatNumber(data.host.cores ?? 0)} cores · ${formatBytes(data.host.memAvailableBytes ?? 0)} available · detail on Host tab`}
              data={data.hostCpu}
              unit="pct"
              height={220}
              series={[
                { metric: 'host_cpu_pct', label: 'CPU', color: COLOR.accent },
                { metric: 'host_cpu_iowait_pct', label: 'I/O wait', color: COLOR.warning },
                { metric: 'host_mem_used_pct', label: 'Memory', color: COLOR.success },
              ]}
            />
          </div>
        ) : (
          <section className="panel">
            <div className="panel-body text-[12px] text-foreground-secondary">
              Host CPU and memory require <code>hostMetrics</code> in the collector config — see the Host tab.
            </div>
          </section>
        )}

        <div className="stat-grid stat-grid--5">
          <StatCard
            label="Health score"
            value={instance.score === null ? '—' : formatNumber(instance.score)}
            unit={instance.score === null ? undefined : '/100'}
            tone={toneForScore(instance.score)}
            hint={
              healthPosture
                ? 'mostly backups/HA posture, not a live outage'
                : instance.scoreTs
                  ? `${instance.critical} crit · ${instance.warning} warn · ${formatAgo(instance.scoreTs)}`
                  : 'no check runs'
            }
          />
          <StatCard
            label="Connections"
            value={formatPct(instance.connectionsUsedPct, 0)}
            hint={
              instance.connectionsTotal === null
                ? undefined
                : `${formatCompactNumber(instance.connectionsTotal)} of ${formatCompactNumber(instance.connectionsMax)}`
            }
            tone={toneForPct(instance.connectionsUsedPct, 70, 90)}
          />
          <StatCard
            label="DML throughput"
            value={dmlPerSec === null ? '—' : formatCompactNumber(dmlPerSec, 0)}
            unit={dmlPerSec === null ? undefined : '/s'}
            hint="insert + update + delete tuples"
            tone="accent"
          />
          <div className="stat stat--accent stat--split">
            <div className="stat-split">
              <div className="stat-split__side">
                <div className="stat__label">Commits/s</div>
                <div className="stat__value">{formatCompactNumber(instance.commitsPerSec, 1)}</div>
              </div>
              <div className="stat-split__side">
                <div className="stat__label">Rollbacks/s</div>
                <div
                  className={`stat__value${(instance.rollbacksPerSec ?? 0) > 0 ? ' stat__value--warn' : ''}`}
                >
                  {formatCompactNumber(instance.rollbacksPerSec, 1)}
                </div>
              </div>
            </div>
            <div className="stat__hint">from transaction counters</div>
          </div>
          <StatCard
            label="Cache hit"
            value={formatPct(instance.cacheHitPct, 2)}
            tone={toneForMinimum(instance.cacheHitPct, 99, 95)}
            hint="worst database"
          />
        </div>

        <div className="stat-grid stat-grid--5">
          <StatCard
            label="Wait time"
            value={
              instance.maxBlockedSeconds === null
                ? '—'
                : instance.maxBlockedSeconds > 0
                  ? formatDuration(instance.maxBlockedSeconds)
                  : '0s'
            }
            hint="max lock wait now"
            tone={
              instance.maxBlockedSeconds === null
                ? 'neutral'
                : (instance.maxBlockedSeconds ?? 0) > 60
                  ? 'error'
                  : (instance.maxBlockedSeconds ?? 0) > 0
                    ? 'warn'
                    : 'ok'
            }
          />
          <StatCard
            label="Blocked sessions"
            value={formatNumber(instance.blockedSessions)}
            tone={(instance.blockedSessions ?? 0) > 0 ? 'error' : 'ok'}
          />
          <StatCard
            label="XID age"
            value={formatPct(instance.xidAgePct, 1)}
            hint="of autovacuum_freeze_max_age"
            tone={toneForPct(instance.xidAgePct, 50, 80)}
          />
          <StatCard
            label="Dead tuples"
            value={worstDeadPct > 0 ? formatPct(worstDeadPct, 1) : '—'}
            hint="worst table"
            tone={toneForPct(worstDeadPct, 10, 20)}
          />
          <StatCard label="Uptime" value={formatDuration(instance.uptimeSeconds)} tone="neutral" />
        </div>

        <div className="stat-grid stat-grid--5">
          <StatCard
            label={`Peak conn util (${window.key})`}
            value={peakConnPct === null ? '—' : formatPct(peakConnPct, 0)}
            tone={toneForPct(peakConnPct, 70, 90)}
            hint="max connections_used_pct in window"
          />
          <StatCard
            label={`Peak DML/s (${window.key})`}
            value={peakDml === null ? '—' : formatCompactNumber(peakDml, 0)}
            unit={peakDml === null ? undefined : '/s'}
            tone="accent"
            hint="max insert+update+delete rate"
          />
          <StatCard
            label={`Peak commits/s (${window.key})`}
            value={peakCommit === null ? '—' : formatCompactNumber(peakCommit, 1)}
            unit={peakCommit === null ? undefined : '/s'}
            tone="accent"
            hint="max commit rate in window"
          />
          <StatCard
            label={`Peak temp bytes/s (${window.key})`}
            value={peakTempBytes === null ? '—' : formatBytes(peakTempBytes)}
            unit={peakTempBytes === null ? undefined : '/s'}
            tone={peakTempBytes !== null && peakTempBytes > 0 ? 'warn' : 'ok'}
            hint="spill to disk — short work_mem symptom"
          />
          <StatCard
            label={`Peak temp files/s (${window.key})`}
            value={peakTempFiles === null ? '—' : formatCompactNumber(peakTempFiles, 2)}
            unit={peakTempFiles === null ? undefined : '/s'}
            tone={peakTempFiles !== null && peakTempFiles > 0 ? 'warn' : 'ok'}
            hint="temp file creation rate"
          />
        </div>

        <IncidentPanel
          headline={data.incident.headline}
          body={data.incident.body}
          tone={data.incident.tone}
          at={data.incident.at}
          href={`/instances/${instanceId}/sessions`}
        />

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <TimeseriesPanel
            title="Connections"
            hint={windowHint}
            data={data.connections}
            unit="count"
            series={[
              { metric: 'connections_total', label: 'Total', color: COLOR.accent },
              { metric: 'connections_active', label: 'Active', color: COLOR.success },
              { metric: 'connections_idle_in_transaction', label: 'Idle in tx', color: COLOR.warning },
            ]}
          />
          <TimeseriesPanel
            title="Transactions per second"
            hint={windowHint}
            data={data.throughput}
            unit="rate"
            series={[
              { metric: 'db_xact_commit_per_sec', label: 'Commits', color: COLOR.accent },
              { metric: 'db_xact_rollback_per_sec', label: 'Rollbacks', color: COLOR.error },
            ]}
          />
        </div>

        <div className="chart-panel--full">
          <TimeseriesPanel
            title="DML throughput (tuples per second)"
            hint={windowHint}
            data={data.dml}
            unit="rate"
            height={220}
            series={[
              { metric: 'db_tup_inserted_per_sec', label: 'Insert', color: COLOR.success },
              { metric: 'db_tup_updated_per_sec', label: 'Update', color: COLOR.accent },
              { metric: 'db_tup_deleted_per_sec', label: 'Delete', color: COLOR.error },
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <TimeseriesPanel
            title="WAL generated per second"
            hint={windowHint}
            data={data.wal}
            unit="bytes"
            series={[{ metric: 'wal_bytes_per_sec', label: 'WAL/s', color: COLOR.accent }]}
          />
          <TimeseriesPanel
            title="Blocked sessions"
            hint={windowHint}
            data={data.blocking}
            unit="count"
            series={[{ metric: 'blocked_sessions', label: 'Blocked', color: COLOR.error }]}
          />
        </div>

        <div className="chart-panel--full">
          <TimeseriesPanel
            title="I/O per second"
            hint={windowHint}
            data={data.io}
            unit="rate"
            height={260}
            series={[
              { metric: 'io_reads_per_sec', label: 'Reads', color: COLOR.warning },
              { metric: 'io_writes_per_sec', label: 'Writes', color: COLOR.accent },
            ]}
          />
        </div>

        <div className="chart-panel--full">
          <TimeoutScatter points={data.timeouts} height={240} />
        </div>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <TimeseriesPanel
            title="Active sessions by wait class"
            hint="CPU = running, not waiting"
            data={data.waitClasses.points}
            unit="count"
            series={data.waitClasses.keys.map((key, index) => ({
              metric: key,
              label: key,
              color: WAIT_COLORS[index % WAIT_COLORS.length] as string,
            }))}
          />
          <TimeseriesPanel
            title="Cache hit"
            hint="effective memory: shared_buffers + OS cache"
            data={data.cache}
            unit="pct"
            series={[{ metric: 'db_cache_hit_pct', label: 'Cache hit', color: COLOR.accent }]}
          />
          <TimeseriesPanel
            title="Checkpoints"
            hint={`${windowHint} · timed vs requested`}
            data={data.checkpoints}
            unit="rate"
            series={[
              { metric: 'checkpoint_num_timed_per_sec', label: 'Timed', color: COLOR.accent },
              { metric: 'checkpoint_num_requested_per_sec', label: 'Requested', color: COLOR.warning },
              {
                metric: 'checkpoint_buffers_written_per_sec',
                label: 'Buffers written',
                color: COLOR.muted,
              },
            ]}
          />
          <TimeseriesPanel
            title="Spill to temporary files"
            hint="symptom of short work_mem — bytes and file creation rate"
            data={data.tempFiles}
            unit="bytes"
            series={[
              { metric: 'db_temp_bytes_per_sec', label: 'Temp bytes/s', color: COLOR.error },
              { metric: 'db_temp_files_per_sec', label: 'Temp files/s', color: COLOR.warning },
            ]}
          />
        </div>

        {healthPosture ? <div className="notice">{healthPosture}</div> : null}

        <FindingsPanel
          findings={findings.map((finding) => ({
            checkId: finding.checkId,
            title: finding.title,
            severity: finding.severity,
            object: finding.object,
            message: finding.message,
            remediation: finding.remediation,
          }))}
          checkedAt={findings[0] ? formatClock(findings[0].ts) : null}
        />

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          <LabeledBars
            title="Wait events"
            rows={waitRows}
            footer="active sessions"
            emptyMessage="No active sessions waiting."
          />
          <LabeledBars
            title="Largest tables"
            rows={tableRows}
            footer="total size"
            emptyMessage="No size samples yet."
          />
          <LabeledBars
            title="Dead tuples"
            rows={deadRows}
            footer="top by count"
            emptyMessage="No tables with dead tuples."
          />
        </div>

        <AnomalyPanel
          instanceId={instanceId}
          anomalies={data.anomalies}
          coverage={data.baselineCoverage}
        />

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Replication</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {data.subscriptions.length} subscription{data.subscriptions.length === 1 ? '' : 's'}
                {' · '}
                {data.slots.length} slot{data.slots.length === 1 ? '' : 's'}
              </span>
            </div>
            {data.subscriptions.length === 0 && data.slots.length === 0 ? (
              <div className="empty">
                No publisher slots and no logical subscriptions yet. A subscriber does not own slots —
                those live on the publisher. Subscriptions appear after the collector reads
                pg_stat_subscription.
              </div>
            ) : (
              <>
                {data.subscriptions.length > 0 ? (
                  <>
                    {data.slots.length === 0 ? (
                      <div className="panel-body border-b border-border text-[11.5px] text-foreground-secondary">
                        This server is a logical subscriber. Replication slots live on the publisher, so
                        zero slots here does not mean there is no replica.
                      </div>
                    ) : null}
                    <SubscriptionTable
                      instanceId={instanceId}
                      rows={[...data.subscriptions]
                        .sort(
                          (a, b) =>
                            a.value - b.value ||
                            (a.labels['subscription'] ?? '').localeCompare(b.labels['subscription'] ?? ''),
                        )
                        .map((row) => ({
                          name: row.labels['subscription'] ?? '',
                          workerUp: row.value === 1,
                          lagSeconds: row.valueB,
                        }))}
                      alerts={data.findings
                        .filter((finding) => finding.checkId === 'logical_subscription_down')
                        .map((finding) => ({
                          object: finding.object ?? '',
                          message: finding.message,
                        }))}
                    />
                    {data.subscriptions.some((row) => row.value !== 1) ? (
                      <div className="panel-body border-t border-border text-[11.5px] text-foreground-secondary">
                        Apply worker pid is empty: the subscription is not applying. Check the publisher
                        slot and the subscriber log, then restart the worker.
                      </div>
                    ) : null}
                  </>
                ) : null}
                {data.slots.length > 0 ? (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Slot</th>
                        <th>Type</th>
                        <th>WAL</th>
                        <th className="text-right">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.slots.map((slot) => (
                        <tr key={slot.labels['slot']}>
                          <td className="font-mono text-[11.5px]">{slot.labels['slot']}</td>
                          <td className="font-mono text-[11px] text-foreground-secondary">{slot.labels['slot_type']}</td>
                          <td className="font-mono text-[11px] text-foreground-secondary">{slot.labels['wal_status']}</td>
                          <td className="text-right">
                            <span className={`tag ${slot.value === 1 ? 'tag--ok' : 'tag--error'}`}>
                              {slot.value === 1 ? 'active' : 'inactive'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            )}
            {inactiveSlots.length > 0 && (
              <div className="panel-body border-t border-border text-[11.5px] text-foreground-secondary">
                An inactive slot retains WAL indefinitely and can fill the primary disk.
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Collector events</span>
              <span className="font-mono text-[10px] text-foreground-muted">this instance</span>
            </div>
            {data.events.length === 0 ? (
              <div className="empty">No events recorded.</div>
            ) : (
              <InstanceEvents
                events={data.events.map((event) => ({
                  eventId: event.eventId,
                  ts: event.ts.toISOString(),
                  firstTs: event.firstTs ? new Date(event.firstTs).toISOString() : null,
                  level: event.level,
                  component: event.component,
                  message: event.message,
                  occurrences: event.occurrences ?? 1,
                  detail: event.detail ?? null,
                }))}
              />
            )}
          </section>
        </div>
      </div>
    </>
  );
}
