import Link from 'next/link';
import { FindingsPanel } from '@/components/FindingsPanel';
import { LabeledBars, type BarRow } from '@/components/LabeledBars';
import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatClock, formatCompactNumber, formatDuration, formatNumber, formatPct } from '@/lib/format';
import { getEvents, getFindings, getLabeled, getLabeledPair, getSeries, getSeriesByLabel } from '@/lib/queries';
import {
  isIdleReplicaWaitState,
  shortProcesslistState,
  shortPsWaitEvent,
} from '@/lib/maria-labels';
import { peakOf, peakOfDerived } from '@/lib/series-peak';
import { getConnectionsByUser, getWaitsByApplication } from '@/lib/sessions';

/**
 * Resumen de instancia para MariaDB y SQL Server.
 *
 * No es la plantilla de PostgreSQL con otros números: cada motor tiene su propia
 * pregunta central. En MariaDB es el buffer pool y las esperas por lock de fila;
 * en SQL Server es la latencia de disco por archivo y la memoria concedida. Se
 * eligen los indicadores de cada uno en vez de mostrar ocho tarjetas donde la
 * mitad diría "no data".
 *
 * Las métricas que **sí** son la misma cosa en los tres motores llevan el mismo
 * nombre en el store —connections, DML, cache hit, deadlocks, bloqueos—, así que
 * este componente y el de PostgreSQL leen las mismas series y las pantallas de
 * flota comparan sin traducir.
 */

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
  muted: '#7a828c',
};

const WAIT_COLORS = ['#0a6e42', '#005eb8', '#9a4a00', '#b01818', '#7a828c'];

/** Último valor no nulo de una serie: el bucket en curso puede estar vacío. */
function ultimo(points: Array<Record<string, number | null>>, metric: string): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const valor = points[index]?.[metric];
    if (valor !== null && valor !== undefined) return valor;
  }
  return null;
}

export async function ForeignSummary({
  instanceId,
  engine,
  windowMinutes,
  bucketSeconds,
  windowHint,
}: {
  instanceId: number;
  engine: 'mariadb' | 'mssql';
  windowMinutes: number;
  bucketSeconds: number;
  windowHint: string;
}) {
  const esMaria = engine === 'mariadb';

  const [connections, dml, cache, esperas, waitMs, psWaits, bloqueos, extra, auth, findings, esperasTop, tablas, bases, eventos, byUser, waitByApp, psTableIo] =
    await Promise.all([
      getSeries(
        instanceId,
        ['connections_total', 'connections_active', 'connections_used_pct'],
        windowMinutes,
        bucketSeconds,
      ),
      getSeries(
        instanceId,
        ['db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec', 'queries_total_per_sec'],
        windowMinutes,
        bucketSeconds,
      ),
      // El cache hit es un porcentaje: se toma el worst case entre etiquetas, no
      // la suma. Es la misma lección que dejó el 397 % de PostgreSQL.
      getSeries(instanceId, ['db_cache_hit_pct'], windowMinutes, bucketSeconds, 'min'),
      getSeriesByLabel(instanceId, 'wait_event_sessions', 'wait_event_type', windowMinutes, bucketSeconds, 5),
      getSeriesByLabel(instanceId, 'wait_event_ms', 'wait_event', windowMinutes, bucketSeconds, 6),
      esMaria
        ? getSeriesByLabel(instanceId, 'ps_wait_ms_per_sec', 'wait_event', windowMinutes, bucketSeconds, 6)
        : Promise.resolve({ points: [], keys: [] as string[] }),
      getSeries(
        instanceId,
        ['blocked_sessions', 'max_blocked_seconds', 'oldest_xact_seconds'],
        windowMinutes,
        bucketSeconds,
      ),
      esMaria
        ? getSeries(
            instanceId,
            [
              'buffer_pool_dirty_pct',
              'buffer_pool_free_pct',
              'innodb_row_lock_waits_per_sec',
              'innodb_history_list_length',
              'threads_running',
              'slow_queries_per_sec',
              'slow_digest_count',
            ],
            windowMinutes,
            bucketSeconds,
          )
        : getSeries(
            instanceId,
            [
              'page_life_expectancy_seconds',
              'memory_grants_pending',
              'host_mem_used_pct',
              'host_cpu_pct',
              'mssql_process_memory_pct',
              'mssql_server_memory_pct',
              'mssql_process_memory_bytes',
              'total_server_memory_bytes',
              'target_server_memory_bytes',
              'worker_threads_active',
              'worker_threads_current',
              'worker_work_queue',
              'sessions_running',
              'sessions_runnable',
              'sessions_sleeping',
            ],
            windowMinutes,
            bucketSeconds,
          ),
      esMaria
        ? getSeries(
            instanceId,
            ['aborted_connects_per_sec', 'aborted_clients_per_sec'],
            windowMinutes,
            bucketSeconds,
          )
        : getSeries(
            instanceId,
            ['logins_per_sec', 'logouts_per_sec'],
            windowMinutes,
            bucketSeconds,
          ),
      getFindings(instanceId),
      getLabeled(instanceId, 'wait_event_sessions', 8, 5),
      getLabeledPair(instanceId, 'table_total_bytes', 'table_index_bytes', 10, 30),
      getLabeled(instanceId, 'database_size_bytes', 8, 30),
      getEvents(instanceId, 10),
      getConnectionsByUser(instanceId, windowMinutes, 10),
      getWaitsByApplication(instanceId, windowMinutes, 10),
      esMaria
        ? getLabeled(instanceId, 'ps_table_io_ms_per_sec', 8, 15)
        : Promise.resolve([]),
    ]);

  // SQL Server: el zip de Superset vivía de Batch/s + Transactions/s + IO +
  // locks + compilations. Esos contadores ya se muestrean; faltaba pintarlas.
  const [throughput, pageIo, lockRates, accessMethods, logIo] = esMaria
    ? [[], [], [], [], []]
    : await Promise.all([
        getSeries(
          instanceId,
          [
            'queries_total_per_sec',
            'db_xact_commit_per_sec',
            'write_transactions_per_sec',
            'sql_compilations_per_sec',
            'sql_recompilations_per_sec',
          ],
          windowMinutes,
          bucketSeconds,
        ),
        getSeries(
          instanceId,
          ['db_blks_read_per_sec', 'pages_written_per_sec', 'lazy_writes_per_sec'],
          windowMinutes,
          bucketSeconds,
        ),
        getSeries(
          instanceId,
          ['lock_waits_per_sec', 'lock_timeouts_per_sec', 'db_deadlocks_per_sec'],
          windowMinutes,
          bucketSeconds,
        ),
        getSeries(
          instanceId,
          ['full_scans_per_sec', 'index_searches_per_sec', 'page_splits_per_sec'],
          windowMinutes,
          bucketSeconds,
        ),
        getSeries(
          instanceId,
          ['wal_bytes_per_sec', 'log_flush_waits_per_sec', 'temp_tables_created_per_sec'],
          windowMinutes,
          bucketSeconds,
        ),
      ]);

  const rgGroups = esMaria
    ? []
    : await getLabeled(instanceId, 'rg_active_requests', 8, 30);

  const latenciaDisco = esMaria
    ? null
    : await getLabeledPair(instanceId, 'file_read_latency_ms', 'file_write_latency_ms', 8, 30);

  const connectionsAhora = ultimo(connections, 'connections_total');
  const saturacion = ultimo(connections, 'connections_used_pct');
  const cacheAhora = ultimo(cache, 'db_cache_hit_pct');
  const bloqueadas = ultimo(bloqueos, 'blocked_sessions');
  const maxEspera = ultimo(bloqueos, 'max_blocked_seconds');
  const transaccionVieja = ultimo(bloqueos, 'oldest_xact_seconds');

  const dmlPorSegundo = (() => {
    for (let index = dml.length - 1; index >= 0; index -= 1) {
      const punto = dml[index];
      if (!punto) continue;
      const insert = punto['db_tup_inserted_per_sec'];
      const update = punto['db_tup_updated_per_sec'];
      const del = punto['db_tup_deleted_per_sec'];
      if (insert !== null || update !== null || del !== null) {
        return (insert ?? 0) + (update ?? 0) + (del ?? 0);
      }
    }
    return null;
  })();

  const peakConn = peakOf(connections, 'connections_used_pct');
  const peakDml = peakOfDerived(dml, (punto) => {
    if (
      punto['db_tup_inserted_per_sec'] === null &&
      punto['db_tup_updated_per_sec'] === null &&
      punto['db_tup_deleted_per_sec'] === null
    ) {
      return null;
    }
    return (
      (punto['db_tup_inserted_per_sec'] ?? 0) +
      (punto['db_tup_updated_per_sec'] ?? 0) +
      (punto['db_tup_deleted_per_sec'] ?? 0)
    );
  });
  const peakQueries = peakOf(dml, 'queries_total_per_sec');
  const peakBatch = esMaria ? peakQueries : peakOf(throughput, 'queries_total_per_sec');
  const peakTxn = esMaria ? null : peakOf(throughput, 'db_xact_commit_per_sec');
  const batchAhora = esMaria ? null : ultimo(throughput, 'queries_total_per_sec');
  const txnAhora = esMaria ? null : ultimo(throughput, 'db_xact_commit_per_sec');
  const historyList = ultimo(extra, 'innodb_history_list_length');
  const threadsRunning = ultimo(extra, 'threads_running');
  const workersActive = ultimo(extra, 'worker_threads_active');
  const workQueue = ultimo(extra, 'worker_work_queue');
  const cpuAhora = ultimo(extra, 'host_cpu_pct');
  const memAhora = ultimo(extra, 'host_mem_used_pct');
  const sqlMemPct = ultimo(extra, 'mssql_server_memory_pct');
  const processMemPct = ultimo(extra, 'mssql_process_memory_pct');

  const esperasRows: BarRow[] = esperasTop
    .filter((row) => !isIdleReplicaWaitState(row.labels['wait_event'] ?? ''))
    .map((row) => ({
      label: shortProcesslistState(row.labels['wait_event'] ?? '—'),
      sub: row.labels['wait_event_type'],
      value: row.value,
      display: formatNumber(row.value),
      tone: row.labels['wait_event_type'] === 'Lock' ? 'error' : 'accent',
    }));

  const tablasRows: BarRow[] = tablas.map((row) => ({
    label: `${row.labels['schema']}.${row.labels['table']}`,
    sub: row.valueB !== null && row.valueB > 0 ? `indexes ${formatBytes(row.valueB)}` : undefined,
    value: row.value,
    display: formatBytes(row.value),
  }));

  const basesRows: BarRow[] = bases.map((row) => ({
    label: row.labels['database'] ?? '—',
    value: row.value,
    display: formatBytes(row.value),
  }));

  const psTableIoRows: BarRow[] = (psTableIo ?? []).map((row) => ({
    label: `${row.labels['schema'] ?? '?'}.${row.labels['table'] ?? '?'}`,
    value: row.value,
    display: `${row.value.toFixed(1)} ms/s`,
    tone: row.value >= 50 ? 'error' : row.value >= 10 ? 'warn' : 'accent',
  }));

  const discoRows: BarRow[] = (latenciaDisco ?? []).map((row) => ({
    label: `${row.labels['database']} · ${row.labels['file_type']}`,
    sub: row.valueB !== null ? `escritura ${row.valueB.toFixed(1)} ms` : undefined,
    value: row.value,
    display: `${row.value.toFixed(1)} ms`,
    // 20 ms de lectura es el umbral con el que trabaja cualquier DBA de SQL
    // Server; arriba de 50 el disco es el problema y no hay discusión.
    tone: row.value >= 50 ? 'error' : row.value >= 20 ? 'warn' : 'accent',
  }));

  const byUserRows: BarRow[] = byUser.map((row) => ({
    label: row.label,
    value: row.count,
    display: formatNumber(row.count),
  }));

  const waitByAppRows: BarRow[] = waitByApp.map((row) => ({
    label: row.label,
    sub: row.waitType,
    value: row.count,
    display: formatNumber(row.count),
    tone: row.waitType.toLowerCase().includes('lock') ? 'error' : 'accent',
  }));

  const rgRows: BarRow[] = rgGroups.map((row) => ({
    label: row.labels['workload_group'] ?? '—',
    value: row.value,
    display: formatNumber(row.value),
    tone: row.value > 0 ? 'accent' : undefined,
  }));

  return (
    <>
      {!esMaria ? (
        <div className="chart-panel--full">
          <TimeseriesPanel
            title="System CPU and memory"
            hint={`${windowHint} · SQL Server process CPU vs all cores · host RAM from dm_os_sys_memory (no SSH)`}
            data={extra}
            unit="pct"
            height={220}
            series={[
              { metric: 'host_cpu_pct', label: 'SQL CPU %', color: COLOR.accent },
              { metric: 'host_mem_used_pct', label: 'Host RAM %', color: COLOR.warning },
              { metric: 'mssql_process_memory_pct', label: 'SQL process %', color: COLOR.success },
              { metric: 'mssql_server_memory_pct', label: 'Buffer / target %', color: COLOR.muted },
            ]}
          />
        </div>
      ) : null}

      <div className="stat-grid stat-grid--5">
        <StatCard label="Connections" value={connectionsAhora === null ? '—' : formatCompactNumber(connectionsAhora)} />
        <StatCard
          label="Saturation"
          value={saturacion === null ? '—' : formatPct(saturacion, 1)}
          tone={saturacion === null ? undefined : toneForPct(saturacion, 75, 90)}
          hint="of configured maximum"
        />
        {esMaria ? (
          <StatCard
            label="Cache hit"
            value={cacheAhora === null ? '—' : formatPct(cacheAhora, 2)}
            tone={cacheAhora === null ? undefined : toneForMinimum(cacheAhora, 99, 95)}
            hint="InnoDB buffer pool"
          />
        ) : (
          <StatCard
            label="SQL CPU"
            value={cpuAhora === null ? '—' : formatPct(cpuAhora, 1)}
            tone={cpuAhora === null ? undefined : toneForPct(cpuAhora, 70, 90)}
            hint="process vs all cores"
          />
        )}
        {esMaria ? (
          <StatCard
            label="DML per second"
            value={dmlPorSegundo === null ? '—' : formatCompactNumber(dmlPorSegundo, 1)}
            hint="insert + update + delete"
          />
        ) : (
          <StatCard
            label="Batch /s"
            value={batchAhora === null ? '—' : formatCompactNumber(batchAhora, 1)}
            unit={batchAhora === null ? undefined : '/s'}
            hint="Batch Requests/sec"
          />
        )}
        <StatCard
          label={esMaria ? 'Wait time' : 'Transactions /s'}
          value={
            esMaria
              ? maxEspera === null
                ? '—'
                : maxEspera > 0
                  ? formatDuration(maxEspera)
                  : '0s'
              : txnAhora === null
                ? '—'
                : formatCompactNumber(txnAhora, 1)
          }
          unit={!esMaria && txnAhora !== null ? '/s' : undefined}
          hint={esMaria ? 'max lock wait now' : 'Transactions/sec · all DBs'}
          tone={
            esMaria
              ? maxEspera === null
                ? undefined
                : maxEspera > 60
                  ? 'error'
                  : maxEspera > 0
                    ? 'warn'
                    : 'ok'
              : undefined
          }
        />
      </div>

      <div className="stat-grid stat-grid--5">
        <StatCard
          label="Blocked sessions"
          value={bloqueadas === null ? '—' : formatNumber(bloqueadas)}
          tone={bloqueadas && bloqueadas > 0 ? 'error' : undefined}
        />
        <StatCard
          label="Oldest transaction"
          value={transaccionVieja === null ? '—' : formatDuration(transaccionVieja)}
          tone={transaccionVieja && transaccionVieja > 300 ? 'warn' : undefined}
          hint="open right now"
        />
        {esMaria ? (
          <>
            <StatCard
              label="Dirty pages"
              value={
                ultimo(extra, 'buffer_pool_dirty_pct') === null
                  ? '—'
                  : formatPct(ultimo(extra, 'buffer_pool_dirty_pct') ?? 0, 1)
              }
              hint="of the buffer pool"
            />
            <StatCard
              label="History list"
              value={historyList === null ? '—' : formatCompactNumber(historyList, 0)}
              tone={
                historyList === null
                  ? undefined
                  : historyList > 1_000_000
                    ? 'error'
                    : historyList > 100_000
                      ? 'warn'
                      : 'ok'
              }
              hint="InnoDB purge lag (undo)"
            />
            <StatCard
              label="Threads running"
              value={threadsRunning === null ? '—' : formatNumber(threadsRunning)}
              hint="executing right now"
            />
          </>
        ) : (
          <>
            <StatCard
              label="Host memory"
              value={memAhora === null ? '—' : formatPct(memAhora, 1)}
              tone={memAhora === null ? undefined : toneForPct(memAhora, 85, 95)}
              hint={
                processMemPct !== null
                  ? `SQL process ${formatPct(processMemPct, 1)} of RAM`
                  : 'physical RAM'
              }
            />
            <StatCard
              label="Page life"
              value={
                ultimo(extra, 'page_life_expectancy_seconds') === null
                  ? '—'
                  : formatDuration(ultimo(extra, 'page_life_expectancy_seconds') ?? 0)
              }
              tone={
                ultimo(extra, 'page_life_expectancy_seconds') === null
                  ? undefined
                  : toneForMinimum(ultimo(extra, 'page_life_expectancy_seconds') ?? 0, 900, 300)
              }
              hint="page survival in buffer"
            />
            <StatCard
              label="Wait time"
              value={
                maxEspera === null ? '—' : maxEspera > 0 ? formatDuration(maxEspera) : '0s'
              }
              hint="max lock wait now"
              tone={
                maxEspera === null
                  ? undefined
                  : maxEspera > 60
                    ? 'error'
                    : maxEspera > 0
                      ? 'warn'
                      : 'ok'
              }
            />
          </>
        )}
      </div>

      <div className="stat-grid stat-grid--5">
        <StatCard
          label="Peak conn util"
          value={peakConn === null ? '—' : formatPct(peakConn, 1)}
          tone={peakConn === null ? undefined : toneForPct(peakConn, 75, 90)}
          hint="max in window"
        />
        {esMaria ? (
          <>
            <StatCard
              label="Peak DML/s"
              value={peakDml === null ? '—' : formatCompactNumber(peakDml, 1)}
              unit={peakDml === null ? undefined : '/s'}
              hint="max insert+update+delete"
            />
            <StatCard
              label="Peak queries/s"
              value={peakQueries === null ? '—' : formatCompactNumber(peakQueries, 1)}
              unit={peakQueries === null ? undefined : '/s'}
              hint="QUESTIONS"
            />
          </>
        ) : (
          <>
            <StatCard
              label="Peak batch/s"
              value={peakBatch === null ? '—' : formatCompactNumber(peakBatch, 1)}
              unit={peakBatch === null ? undefined : '/s'}
              hint="max Batch Requests/sec"
            />
            <StatCard
              label="Peak transactions/s"
              value={peakTxn === null ? '—' : formatCompactNumber(peakTxn, 1)}
              unit={peakTxn === null ? undefined : '/s'}
              hint="max Transactions/sec"
            />
          </>
        )}
        <StatCard
          label={esMaria ? 'Free buffer pool' : 'Cache hit'}
          value={
            esMaria
              ? ultimo(extra, 'buffer_pool_free_pct') === null
                ? '—'
                : formatPct(ultimo(extra, 'buffer_pool_free_pct') ?? 0, 1)
              : cacheAhora === null
                ? '—'
                : formatPct(cacheAhora, 2)
          }
          hint={esMaria ? 'unused buffer pool pages' : 'buffer pool'}
          tone={
            esMaria
              ? undefined
              : cacheAhora === null
                ? undefined
                : toneForMinimum(cacheAhora, 99, 95)
          }
        />
        <StatCard
          label={esMaria ? 'Row lock waits/s' : 'Workers / queue'}
          value={
            esMaria
              ? ultimo(extra, 'innodb_row_lock_waits_per_sec') === null
                ? '—'
                : formatCompactNumber(ultimo(extra, 'innodb_row_lock_waits_per_sec') ?? 0, 2)
              : workersActive === null
                ? '—'
                : formatNumber(workersActive)
          }
          hint={
            esMaria
              ? 'InnoDB row lock waits rate'
              : workQueue !== null
                ? `runnable queue ${formatNumber(workQueue)}`
                : 'VISIBLE ONLINE schedulers'
          }
          tone={
            (!esMaria && workQueue !== null && workQueue > 0) ||
            (esMaria && (ultimo(extra, 'innodb_row_lock_waits_per_sec') ?? 0) > 1)
              ? 'warn'
              : undefined
          }
        />
      </div>

      {!esMaria ? (
        <>
          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <TimeseriesPanel
              title="Batch requests /s"
              hint={`${windowHint} · Batch Requests/sec`}
              data={throughput}
              unit="rate"
              series={[{ metric: 'queries_total_per_sec', label: 'Batch/s', color: COLOR.accent, filled: true }]}
            />
            <TimeseriesPanel
              title="Transactions /s"
              hint={`${windowHint} · Transactions/sec + write tx`}
              data={throughput}
              unit="rate"
              series={[
                { metric: 'db_xact_commit_per_sec', label: 'Transactions/s', color: COLOR.accent, filled: true },
                { metric: 'write_transactions_per_sec', label: 'Write tx/s', color: COLOR.success },
              ]}
            />
          </div>

          <div className="chart-panel--full">
            <TimeseriesPanel
              title="Wait time"
              hint={`${windowHint} · sum wait_time on dm_exec_requests (ms)`}
              data={waitMs.points}
              unit="ms"
              height={220}
              series={waitMs.keys.map((key, index) => ({
                metric: key,
                label: key,
                color: WAIT_COLORS[index % WAIT_COLORS.length] ?? COLOR.muted,
                filled: index === 0,
              }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <TimeseriesPanel
              title="Connections"
              hint={windowHint}
              data={connections}
              unit="count"
              series={[
                { metric: 'connections_total', label: 'Total', color: COLOR.accent },
                { metric: 'connections_active', label: 'Active', color: COLOR.success },
              ]}
            />
            <TimeseriesPanel
              title="Active sessions by wait class"
              hint={`${windowHint} · CPU = running, not waiting`}
              data={esperas.points}
              unit="count"
              series={esperas.keys.map((key, index) => ({
                metric: key,
                // Legacy Spanish family label from older collectors.
                label: key === 'Otro' ? 'Other' : key,
                color: WAIT_COLORS[index % WAIT_COLORS.length] ?? COLOR.muted,
              }))}
            />
          </div>

          <div className="chart-panel--full">
            <TimeseriesPanel
              title="DML throughput (rows per second)"
              hint={windowHint}
              data={dml}
              unit="rate"
              height={220}
              series={[
                { metric: 'db_tup_inserted_per_sec', label: 'Insert', color: COLOR.success, filled: true },
                { metric: 'db_tup_updated_per_sec', label: 'Update', color: COLOR.accent, filled: true },
                { metric: 'db_tup_deleted_per_sec', label: 'Delete', color: COLOR.error, filled: true },
              ]}
            />
          </div>

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2 2xl:grid-cols-3">
            <TimeseriesPanel
              title="Blocked sessions"
              hint={windowHint}
              data={bloqueos}
              unit="count"
              series={[{ metric: 'blocked_sessions', label: 'Blocked', color: COLOR.error }]}
            />
            <TimeseriesPanel
              title="Worker pool"
              hint={`${windowHint} · VISIBLE ONLINE schedulers`}
              data={extra}
              unit="count"
              series={[
                { metric: 'worker_threads_active', label: 'Active', color: COLOR.accent },
                { metric: 'worker_threads_current', label: 'Current', color: COLOR.muted },
                { metric: 'worker_work_queue', label: 'Work queue', color: COLOR.error },
              ]}
            />
            <TimeseriesPanel
              title="Page life & grants"
              hint={windowHint}
              data={extra}
              series={[
                { metric: 'page_life_expectancy_seconds', label: 'Page life (s)', color: COLOR.accent },
                { metric: 'memory_grants_pending', label: 'Grants pending', color: COLOR.error },
              ]}
            />
            <TimeseriesPanel
              title="Page I/O /s"
              hint={`${windowHint} · buffer manager`}
              data={pageIo}
              unit="rate"
              series={[
                { metric: 'db_blks_read_per_sec', label: 'Page reads/s', color: COLOR.accent, filled: true },
                { metric: 'pages_written_per_sec', label: 'Page writes/s', color: COLOR.success, filled: true },
                { metric: 'lazy_writes_per_sec', label: 'Lazy writes/s', color: COLOR.muted },
              ]}
            />
            <TimeseriesPanel
              title="Lock pressure /s"
              hint={windowHint}
              data={lockRates}
              unit="rate"
              series={[
                { metric: 'lock_waits_per_sec', label: 'Lock waits/s', color: COLOR.warning },
                { metric: 'lock_timeouts_per_sec', label: 'Timeouts/s', color: COLOR.error },
                { metric: 'db_deadlocks_per_sec', label: 'Deadlocks/s', color: COLOR.error },
              ]}
            />
            <TimeseriesPanel
              title="Cache hit"
              hint={`${windowHint} · worst case`}
              data={cache}
              unit="pct"
              series={[{ metric: 'db_cache_hit_pct', label: 'Hit %', color: COLOR.accent, filled: true }]}
            />
            <TimeseriesPanel
              title="SQL compilations /s"
              hint={windowHint}
              data={throughput}
              unit="rate"
              series={[
                { metric: 'sql_compilations_per_sec', label: 'Compilations/s', color: COLOR.warning },
                { metric: 'sql_recompilations_per_sec', label: 'Recompiles/s', color: COLOR.error },
              ]}
            />
            <TimeseriesPanel
              title="Access methods /s"
              hint={`${windowHint} · scans vs seeks`}
              data={accessMethods}
              unit="rate"
              series={[
                { metric: 'full_scans_per_sec', label: 'Full scans/s', color: COLOR.error },
                { metric: 'index_searches_per_sec', label: 'Index searches/s', color: COLOR.accent },
                { metric: 'page_splits_per_sec', label: 'Page splits/s', color: COLOR.warning },
              ]}
            />
            <TimeseriesPanel
              title="Log / temp /s"
              hint={`${windowHint} · log flush + temp tables`}
              data={logIo}
              unit="rate"
              series={[
                { metric: 'wal_bytes_per_sec', label: 'Log bytes flushed/s', color: COLOR.accent },
                { metric: 'log_flush_waits_per_sec', label: 'Log flush waits/s', color: COLOR.warning },
                { metric: 'temp_tables_created_per_sec', label: 'Temp tables/s', color: COLOR.muted },
              ]}
            />
            <TimeseriesPanel
              title="Session state mix"
              hint={`${windowHint} · dm_exec_sessions`}
              data={extra}
              unit="count"
              series={[
                { metric: 'sessions_running', label: 'Running', color: COLOR.accent },
                { metric: 'sessions_runnable', label: 'Runnable', color: COLOR.warning },
                { metric: 'sessions_sleeping', label: 'Sleeping', color: COLOR.muted },
              ]}
            />
          </div>

          <div className="chart-panel--full">
            <TimeseriesPanel
              title="Logins / logouts"
              hint={`${windowHint} · General Statistics`}
              data={auth}
              unit="rate"
              height={200}
              series={[
                { metric: 'logins_per_sec', label: 'Logins/s', color: COLOR.accent, filled: true },
                { metric: 'logouts_per_sec', label: 'Logouts/s', color: COLOR.muted, filled: true },
              ]}
            />
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <TimeseriesPanel
              title="Queries /s"
              hint={`${windowHint} · QUESTIONS`}
              data={dml}
              unit="rate"
              series={[{ metric: 'queries_total_per_sec', label: 'QPS', color: COLOR.accent, filled: true }]}
            />
            <TimeseriesPanel
              title="DML /s"
              hint={windowHint}
              data={dml}
              unit="rate"
              series={[
                { metric: 'db_tup_inserted_per_sec', label: 'Insert', color: COLOR.success, filled: true },
                { metric: 'db_tup_updated_per_sec', label: 'Update', color: COLOR.accent, filled: true },
                { metric: 'db_tup_deleted_per_sec', label: 'Delete', color: COLOR.error, filled: true },
              ]}
            />
          </div>

          <div className="chart-panel--full">
            <TimeseriesPanel
              title="Wait time"
              hint={`${windowHint} · PROCESSLIST time × sessions (ms) · idle replica/dump threads excluded`}
              data={waitMs.points}
              unit="ms"
              height={220}
              series={waitMs.keys
                .filter((key) => !isIdleReplicaWaitState(key))
                .map((key, index) => ({
                  metric: key,
                  label: shortProcesslistState(key),
                  color: WAIT_COLORS[index % WAIT_COLORS.length] ?? COLOR.muted,
                  filled: index === 0,
                }))}
            />
          </div>

          {psWaits.keys.length > 0 ? (
            <div className="chart-panel--full">
              <TimeseriesPanel
                title="Instrumented waits (performance_schema)"
                hint={`${windowHint} · events_waits_summary · IO / locks (cond noise filtered)`}
                data={psWaits.points}
                unit="rate"
                height={200}
                series={psWaits.keys.map((key, index) => ({
                  metric: key,
                  label: shortPsWaitEvent(key),
                  color: WAIT_COLORS[index % WAIT_COLORS.length] ?? COLOR.muted,
                  filled: index === 0,
                }))}
              />
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2 2xl:grid-cols-3">
            <TimeseriesPanel
              title="Connections"
              hint={windowHint}
              data={connections}
              series={[
                { metric: 'connections_total', label: 'Total', color: COLOR.accent },
                { metric: 'connections_active', label: 'Active', color: COLOR.success },
              ]}
            />
            <TimeseriesPanel
              title="Aborted connects"
              hint={`${windowHint} · handshake / client drop`}
              data={auth}
              series={[
                { metric: 'aborted_connects_per_sec', label: 'aborted connects/s', color: COLOR.error },
                { metric: 'aborted_clients_per_sec', label: 'aborted clients/s', color: COLOR.warning },
              ]}
            />
            <TimeseriesPanel
              title="Slow queries /s"
              hint={`${windowHint} · SLOW_QUERIES counter + slow digests (≥500ms avg)`}
              data={extra}
              unit="rate"
              series={[
                { metric: 'slow_queries_per_sec', label: 'slow/s', color: COLOR.error, filled: true },
                { metric: 'slow_digest_count', label: 'slow digests', color: COLOR.warning },
              ]}
            />
            <TimeseriesPanel
              title="Cache hits"
              hint={`${windowHint} · buffer pool`}
              data={cache}
              series={[{ metric: 'db_cache_hit_pct', label: 'hit %', color: COLOR.accent, filled: true }]}
              unit="pct"
            />
            <TimeseriesPanel
              title="Blocked sessions"
              hint={windowHint}
              data={bloqueos}
              series={[{ metric: 'blocked_sessions', label: 'Blocked', color: COLOR.error }]}
            />
            <TimeseriesPanel
              title="Buffer pool"
              hint={windowHint}
              data={extra}
              series={[
                { metric: 'buffer_pool_dirty_pct', label: 'Dirty %', color: COLOR.warning, filled: true },
                { metric: 'buffer_pool_free_pct', label: 'Free %', color: COLOR.muted },
              ]}
              unit="pct"
            />
            <TimeseriesPanel
              title="History list length"
              hint={`${windowHint} · InnoDB undo purge lag`}
              data={extra}
              series={[
                { metric: 'innodb_history_list_length', label: 'history list', color: COLOR.error, filled: true },
                { metric: 'threads_running', label: 'threads running', color: COLOR.accent },
              ]}
            />
            <TimeseriesPanel
              title="Wait classes"
              hint={`${windowHint} · PROCESSLIST state`}
              data={esperas.points}
              series={esperas.keys
                .filter((key) => !isIdleReplicaWaitState(key))
                .map((key, index) => ({
                  metric: key,
                  label: shortProcesslistState(key),
                  color: WAIT_COLORS[index % WAIT_COLORS.length] ?? COLOR.muted,
                }))}
            />
            <TimeseriesPanel
              title="Row lock waits /s"
              hint={windowHint}
              data={extra}
              unit="rate"
              series={[{ metric: 'innodb_row_lock_waits_per_sec', label: 'row lock waits/s', color: COLOR.warning }]}
            />
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
        <FindingsPanel findings={findings} checkedAt={findings[0] ? formatClock(findings[0].ts) : null} />
        <LabeledBars
          title="What sessions are waiting on"
          rows={esperasRows}
          emptyMessage="No sessions waiting."
          footer={esMaria ? 'command state in processlist' : 'wait type of the active request'}
        />
        <LabeledBars title="Largest tables" rows={tablasRows} emptyMessage="No table data yet." />
        <LabeledBars
          title="Connections by user"
          rows={byUserRows}
          emptyMessage="No session samples yet."
          footer={`last ${windowMinutes}m of session snapshots`}
        />
        <LabeledBars
          title="Waits by application"
          rows={waitByAppRows}
          emptyMessage="No wait samples by app yet."
          footer="from session_samples · sub = wait type"
        />
        {!esMaria ? (
          <LabeledBars
            title="Resource Governor · active requests"
            rows={rgRows}
            emptyMessage="No RG workload groups yet (or RG not in use)."
            footer="dm_resource_governor_workload_groups"
          />
        ) : null}
        {esMaria ? (
          <>
            <LabeledBars title="Size by database" rows={basesRows} emptyMessage="No database data yet." />
            {psTableIoRows.length > 0 ? (
              <LabeledBars
                title="Hot tables (performance_schema I/O)"
                rows={psTableIoRows}
                emptyMessage="No table I/O samples (needs P_S)."
                footer="table_io_waits_summary_by_table · ms/s"
              />
            ) : null}
          </>
        ) : (
          <LabeledBars
            title="Disk latency by file"
            rows={discoRows}
            emptyMessage="No I/O data yet."
            footer="the bar is reads; writes are under each row"
          />
        )}
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Collector events</h2>
          <Link href={`/instances/${instanceId}/logs`} className="text-[11px] text-accent">
            see the engine log →
          </Link>
        </div>
        {eventos.length === 0 ? (
          <div className="panel-body empty">No events.</div>
        ) : (
          <table className="data-table">
            <tbody>
              {eventos.map((evento, index) => (
                <tr key={`${evento.ts.getTime()}-${index}`}>
                  <td className="font-mono text-[11px] text-foreground-muted">
                    {evento.ts.toLocaleTimeString('en')}
                  </td>
                  <td>
                    <span
                      className={`tag ${
                        evento.level === 'error' ? 'tag--error' : evento.level === 'warn' ? 'tag--warn' : 'tag--muted'
                      }`}
                    >
                      {evento.component}
                    </span>
                  </td>
                  <td className="text-[12px]">{evento.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
