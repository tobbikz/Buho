import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnomalyPanel } from '@/components/AnomalyPanel';
import { FindingsPanel } from '@/components/FindingsPanel';
import { IncidentPanel } from '@/components/IncidentPanel';
import { InstanceTabs } from '@/components/InstanceTabs';
import { ForeignSummary } from '@/components/ForeignSummary';
import { MongoSummary } from '@/components/MongoSummary';
import { LabeledBars, type BarRow } from '@/components/LabeledBars';
import { StatCard, toneForMinimum, toneForPct, toneForScore } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import {
  formatAgo,
  formatBytes,
  formatClock,
  formatDuration,
  formatNumber,
  formatPct,
  formatVersion,
} from '@/lib/format';
import { getAnomalies, getBaselineCoverage } from '@/lib/baselines';
import { ENGINE_LABEL, getInstanceEngine } from '@/lib/estate';
import { explainIncident } from '@/lib/incident';
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

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '15m', minutes: 15, bucketSeconds: 30 },
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
  // 7 días sólo es viable leyendo rollups; sobre muestras crudas serían
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
  active: 'pg_stat_statements activo',
  preloaded_not_created: 'pg_stat_statements precargado, sin crear',
  not_preloaded: 'pg_stat_statements no precargado',
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
  const windowHint = `ventana ${window.key} · ${seriesSource(window.minutes).label}`;

  // El store se consulta en dos pasos para que notFound() nunca caiga en el
  // catch: es una excepción de control de Next, no un error de base de datos.
  let instance;
  try {
    instance = await getInstance(instanceId);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
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
  if (engine === 'mariadb' || engine === 'mssql' || engine === 'mongodb') {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: instance.alias }]} />
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
                  visto {formatAgo(instance.lastSeenAt)}
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
      findings,
      waitEvents,
      tables,
      deadTuples,
      slots,
      events,
      host,
      hostCpu,
      anomalies,
      baselineCoverage,
      incident,
    ] = await Promise.all([
        getSeries(
          instanceId,
          ['connections_total', 'connections_active', 'connections_idle_in_transaction'],
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
        getSeries(instanceId, ['blocked_sessions'], window.minutes, window.bucketSeconds),
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
        // min entre bases: el porcentaje no se suma, y el peor caso es el que
        // importa (mismo criterio que el indicador de arriba).
        getSeries(instanceId, ['db_cache_hit_pct'], window.minutes, window.bucketSeconds, 'min'),
        getSeries(
          instanceId,
          ['io_reads_per_sec', 'io_writes_per_sec', 'db_temp_bytes_per_sec'],
          window.minutes,
          window.bucketSeconds,
        ),
        getFindings(instanceId),
        getLabeled(instanceId, 'wait_event_sessions', 10, 5),
        getLabeledPair(instanceId, 'table_total_bytes', 'table_index_bytes', 10, 30),
        getLabeledPair(instanceId, 'table_dead_tuples', 'table_dead_pct', 8, 30),
        getLabeled(instanceId, 'replication_slot_active', 10, 30),
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
      findings,
      waitEvents,
      tables,
      deadTuples,
      slots,
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
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const { findings } = data;
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

  const waitRows: BarRow[] = data.waitEvents.map((row) => ({
    label: row.labels['wait_event'] ?? '—',
    sub: row.labels['wait_event_type'],
    value: row.value,
    display: formatNumber(row.value),
    tone: row.labels['wait_event_type'] === 'Lock' ? 'error' : 'accent',
  }));

  const tableRows: BarRow[] = data.tables.map((row) => ({
    label: `${row.labels['schema']}.${row.labels['table']}`,
    sub: row.valueB !== null ? `índices ${formatBytes(row.valueB)}` : undefined,
    value: row.value,
    display: formatBytes(row.value),
  }));

  const deadRows: BarRow[] = data.deadTuples.map((row) => ({
    label: `${row.labels['schema']}.${row.labels['table']}`,
    sub: row.valueB !== null ? `${formatPct(row.valueB, 1)} muertas` : undefined,
    value: row.value,
    display: formatNumber(row.value),
    tone: (row.valueB ?? 0) >= 20 ? 'error' : (row.valueB ?? 0) >= 10 ? 'warn' : 'accent',
  }));

  const inactiveSlots = data.slots.filter((slot) => slot.value === 0);

  return (
    <>
      <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: instance.alias }]} />
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
                {instance.hasPgMonitor ? 'pg_monitor' : 'sin pg_monitor'}
              </span>
              <span className={`tag ${instance.statStatements === 'active' ? 'tag--ok' : 'tag--warn'}`}>
                {instance.statStatements === 'active' ? 'stat_statements' : 'stat_statements off'}
              </span>
              <span className={`tag ${instance.trackIoTiming ? 'tag--ok' : 'tag--muted'}`}>
                {instance.trackIoTiming ? 'track_io_timing' : 'io_timing off'}
              </span>
              <span className="font-mono text-[10px] text-foreground-muted">
                visto {formatAgo(instance.lastSeenAt)}
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
              <strong>{STAT_STATEMENTS_LABEL[instance.statStatements ?? 'not_preloaded']}.</strong> Sin esta
              extensión no hay análisis por consulta.{' '}
              {instance.statStatements === 'preloaded_not_created'
                ? 'La librería ya está cargada: basta un CREATE EXTENSION pg_stat_statements, sin reinicio.'
                : 'Agregar pg_stat_statements a shared_preload_libraries requiere reinicio del servidor.'}
            </div>
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="Health score"
            value={instance.score === null ? '—' : formatNumber(instance.score)}
            unit={instance.score === null ? undefined : '/100'}
            tone={toneForScore(instance.score)}
            hint={
              instance.scoreTs
                ? `${instance.critical} crít · ${instance.warning} avisos · ${formatAgo(instance.scoreTs)}`
                : 'sin corridas de checks'
            }
          />
          {data.host ? (
            <>
              <StatCard
                label="CPU del host"
                value={formatPct(data.host.cpuPct, 1)}
                hint={
                  data.host.iowaitPct !== null
                    ? `${formatPct(data.host.iowaitPct, 1)} esperando I/O`
                    : `${formatNumber(data.host.cores ?? 0)} núcleos`
                }
                tone={toneForPct(data.host.cpuPct, 75, 90)}
              />
              <StatCard
                label="Memoria del host"
                value={formatPct(data.host.memUsedPct, 1)}
                hint={`${formatBytes(data.host.memAvailableBytes ?? 0)} disponibles`}
                tone={toneForPct(data.host.memUsedPct, 90, 96)}
              />
            </>
          ) : (
            <StatCard
              label="CPU / memoria"
              value="—"
              hint="requiere hostMetrics · ver pestaña Host"
              tone="neutral"
            />
          )}
          <StatCard
            label="Throughput DML"
            value={dmlPerSec === null ? '—' : formatNumber(dmlPerSec, 0)}
            unit={dmlPerSec === null ? undefined : '/s'}
            hint="tuplas insertadas + modificadas + borradas"
            tone="accent"
          />
          <StatCard
            label="Conexiones"
            value={formatPct(instance.connectionsUsedPct, 0)}
            hint={
              instance.connectionsTotal === null
                ? undefined
                : `${formatNumber(instance.connectionsTotal)} de ${formatNumber(instance.connectionsMax)}`
            }
            tone={toneForPct(instance.connectionsUsedPct, 70, 90)}
          />
          <StatCard
            label="Cache hit"
            value={formatPct(instance.cacheHitPct, 2)}
            tone={toneForMinimum(instance.cacheHitPct, 99, 95)}
            hint="peor base de datos"
          />
          <StatCard
            label="Commits/s"
            value={formatNumber(instance.commitsPerSec, 1)}
            tone="accent"
            hint="tasa derivada de contadores"
          />
          <StatCard
            label="Sesiones bloqueadas"
            value={formatNumber(instance.blockedSessions)}
            tone={(instance.blockedSessions ?? 0) > 0 ? 'error' : 'ok'}
          />
          <StatCard
            label="Edad de XID"
            value={formatPct(instance.xidAgePct, 1)}
            hint="de autovacuum_freeze_max_age"
            tone={toneForPct(instance.xidAgePct, 50, 80)}
          />
          <StatCard
            label="Tuplas muertas"
            value={worstDeadPct > 0 ? formatPct(worstDeadPct, 1) : '—'}
            hint="peor tabla"
            tone={toneForPct(worstDeadPct, 10, 20)}
          />
          <StatCard label="Uptime" value={formatDuration(instance.uptimeSeconds)} tone="neutral" />
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
            title="Conexiones"
            hint={windowHint}
            data={data.connections}
            unit="count"
            series={[
              { metric: 'connections_total', label: 'Total', color: COLOR.accent },
              { metric: 'connections_active', label: 'Activas', color: COLOR.success },
              { metric: 'connections_idle_in_transaction', label: 'Idle in tx', color: COLOR.warning },
            ]}
          />
          <TimeseriesPanel
            title="Transacciones por segundo"
            hint={windowHint}
            data={data.throughput}
            unit="rate"
            series={[
              { metric: 'db_xact_commit_per_sec', label: 'Commits', color: COLOR.accent },
              { metric: 'db_xact_rollback_per_sec', label: 'Rollbacks', color: COLOR.error },
            ]}
          />
          <TimeseriesPanel
            title="WAL generado por segundo"
            hint={windowHint}
            data={data.wal}
            unit="bytes"
            series={[{ metric: 'wal_bytes_per_sec', label: 'WAL/s', color: COLOR.accent }]}
          />
          <TimeseriesPanel
            title="Sesiones bloqueadas"
            hint={windowHint}
            data={data.blocking}
            unit="count"
            series={[{ metric: 'blocked_sessions', label: 'Bloqueadas', color: COLOR.error }]}
          />
        </div>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          {/* CPU y memoria reales cuando la instancia los declara. Van antes de
              las aproximaciones: si hay dato del sistema operativo, es el que
              manda. El detalle completo (swap, carga, disco) vive en Host. */}
          {data.host ? (
            <TimeseriesPanel
              title="CPU y memoria del host"
              hint={`${formatNumber(data.host.cores ?? 0)} núcleos · detalle en Host`}
              data={data.hostCpu}
              unit="pct"
              series={[
                { metric: 'host_cpu_pct', label: 'CPU', color: COLOR.accent },
                { metric: 'host_cpu_iowait_pct', label: 'Espera de I/O', color: COLOR.warning },
                { metric: 'host_mem_used_pct', label: 'Memoria', color: COLOR.success },
              ]}
            />
          ) : null}
          <TimeseriesPanel
            title="Throughput DML (tuplas por segundo)"
            hint={windowHint}
            data={data.dml}
            unit="rate"
            series={[
              { metric: 'db_tup_inserted_per_sec', label: 'Insert', color: COLOR.success },
              { metric: 'db_tup_updated_per_sec', label: 'Update', color: COLOR.accent },
              { metric: 'db_tup_deleted_per_sec', label: 'Delete', color: COLOR.error },
            ]}
          />
          {/* Lo más cerca de "CPU" que da PostgreSQL sin agente: sesiones
              activas repartidas por clase de espera. CPU = trabajando. */}
          <TimeseriesPanel
            title="Sesiones activas por clase de espera"
            hint="CPU = ejecutando, no esperando"
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
            hint="memoria efectiva: shared_buffers + cache del sistema"
            data={data.cache}
            unit="pct"
            series={[{ metric: 'db_cache_hit_pct', label: 'Cache hit', color: COLOR.accent }]}
          />
          <TimeseriesPanel
            title="I/O por segundo"
            hint={windowHint}
            data={data.io}
            unit="rate"
            series={[
              { metric: 'io_reads_per_sec', label: 'Reads', color: COLOR.warning },
              { metric: 'io_writes_per_sec', label: 'Writes', color: COLOR.accent },
            ]}
          />
          {/* Bytes y bloques no comparten eje, así que el derrame va aparte. */}
          <TimeseriesPanel
            title="Derrame a archivos temporales"
            hint="síntoma de work_mem corto"
            data={data.io}
            unit="bytes"
            series={[{ metric: 'db_temp_bytes_per_sec', label: 'Temp bytes/s', color: COLOR.error }]}
          />
        </div>

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
            footer="sesiones activas"
            emptyMessage="Ninguna sesión activa esperando."
          />
          <LabeledBars
            title="Tablas más grandes"
            rows={tableRows}
            footer="tamaño total"
            emptyMessage="Sin muestras de tamaño todavía."
          />
          <LabeledBars
            title="Tuplas muertas"
            rows={deadRows}
            footer="top por conteo"
            emptyMessage="Ninguna tabla con tuplas muertas."
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
              <span className="panel-title">Replicación</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {data.slots.length} slot{data.slots.length === 1 ? '' : 's'}
              </span>
            </div>
            {data.slots.length === 0 ? (
              <div className="empty">Sin slots de replicación.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Tipo</th>
                    <th>WAL</th>
                    <th className="text-right">Estado</th>
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
                          {slot.value === 1 ? 'activo' : 'inactivo'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {inactiveSlots.length > 0 && (
              <div className="panel-body border-t border-border text-[11.5px] text-foreground-secondary">
                Un slot inactivo retiene WAL indefinidamente y puede llenar el disco del primario.
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Eventos del colector</span>
              <span className="font-mono text-[10px] text-foreground-muted">esta instancia</span>
            </div>
            {data.events.length === 0 ? (
              <div className="empty">Sin eventos registrados.</div>
            ) : (
              <table className="data-table">
                <tbody>
                  {data.events.map((event, index) => (
                    <tr key={`${event.ts}-${index}`}>
                      <td className="font-mono text-[11px] text-foreground-muted" style={{ width: '5.5rem' }}>
                        {formatClock(event.ts)}
                      </td>
                      <td style={{ width: '4.5rem' }}>
                        <span
                          className={`tag ${
                            event.level === 'error'
                              ? 'tag--error'
                              : event.level === 'warn'
                                ? 'tag--warn'
                                : 'tag--muted'
                          }`}
                        >
                          {event.level}
                        </span>
                      </td>
                      <td className="text-[12px]">{event.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
