import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import {
  formatCompactNumber,
  formatDuration,
  formatNumber,
  formatPct,
} from '@/lib/format';
import { getSeries } from '@/lib/queries';
import { peakOf, peakOfDerived } from '@/lib/series-peak';

/** Last non-null sample — the in-flight bucket can be empty. */
function ultimo(points: Array<Record<string, number | null>>, metric: string): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const valor = points[index]?.[metric];
    if (valor !== null && valor !== undefined) return valor;
  }
  return null;
}

/**
 * Rich KPI strip for MariaDB / SQL Server Overview — sits above the editable
 * canvas so buffer-pool / memory posture is visible without opening charts.
 */
export async function ForeignOverviewKpis({
  instanceId,
  engine,
  windowMinutes,
  bucketSeconds,
}: {
  instanceId: number;
  engine: 'mariadb' | 'mssql';
  windowMinutes: number;
  bucketSeconds: number;
}) {
  const esMaria = engine === 'mariadb';

  const [connections, dml, cache, bloqueos, extra, throughput] = await Promise.all([
    getSeries(
      instanceId,
      ['connections_total', 'connections_active', 'connections_used_pct'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      [
        'db_tup_inserted_per_sec',
        'db_tup_updated_per_sec',
        'db_tup_deleted_per_sec',
        'queries_total_per_sec',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['db_cache_hit_pct'], windowMinutes, bucketSeconds, 'min'),
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
            'host_cpu_pct',
            'host_mem_used_pct',
            'mssql_process_memory_pct',
            'worker_threads_active',
            'worker_work_queue',
          ],
          windowMinutes,
          bucketSeconds,
        )
      : getSeries(
          instanceId,
          [
            'page_life_expectancy_seconds',
            'host_mem_used_pct',
            'host_cpu_pct',
            'mssql_process_memory_pct',
            'worker_threads_active',
            'worker_work_queue',
          ],
          windowMinutes,
          bucketSeconds,
        ),
    esMaria
      ? Promise.resolve([] as Array<Record<string, number | null>>)
      : getSeries(
          instanceId,
          ['queries_total_per_sec', 'db_xact_commit_per_sec'],
          windowMinutes,
          bucketSeconds,
        ),
  ]);

  const connectionsAhora = ultimo(connections, 'connections_total');
  const saturacion = ultimo(connections, 'connections_used_pct');
  const cacheAhora = ultimo(cache, 'db_cache_hit_pct');
  const bloqueadas = ultimo(bloqueos, 'blocked_sessions');
  const maxEspera = ultimo(bloqueos, 'max_blocked_seconds');
  const transaccionVieja = ultimo(bloqueos, 'oldest_xact_seconds');
  const historyList = ultimo(extra, 'innodb_history_list_length');
  const threadsRunning = ultimo(extra, 'threads_running');
  const workersActive = ultimo(extra, 'worker_threads_active');
  const workQueue = ultimo(extra, 'worker_work_queue');
  const cpuAhora = ultimo(extra, 'host_cpu_pct');
  const memAhora = ultimo(extra, 'host_mem_used_pct');
  const processMemPct = ultimo(extra, 'mssql_process_memory_pct');
  const batchAhora = esMaria ? null : ultimo(throughput, 'queries_total_per_sec');
  const txnAhora = esMaria ? null : ultimo(throughput, 'db_xact_commit_per_sec');

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

  return (
    <>
      <div className="stat-grid stat-grid--5">
        <StatCard
          label="Connections"
          value={connectionsAhora === null ? '—' : formatCompactNumber(connectionsAhora)}
        />
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
              value={maxEspera === null ? '—' : maxEspera > 0 ? formatDuration(maxEspera) : '0s'}
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
    </>
  );
}
