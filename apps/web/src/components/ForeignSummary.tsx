import Link from 'next/link';
import { FindingsPanel } from '@/components/FindingsPanel';
import { LabeledBars, type BarRow } from '@/components/LabeledBars';
import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatClock, formatDuration, formatNumber, formatPct } from '@/lib/format';
import { getEvents, getFindings, getLabeled, getLabeledPair, getSeries, getSeriesByLabel } from '@/lib/queries';

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

  const [connections, dml, cache, esperas, bloqueos, extra, findings, esperasTop, tablas, bases, eventos] =
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
      getSeries(
        instanceId,
        ['blocked_sessions', 'max_blocked_seconds', 'oldest_xact_seconds'],
        windowMinutes,
        bucketSeconds,
      ),
      esMaria
        ? getSeries(
            instanceId,
            ['buffer_pool_dirty_pct', 'buffer_pool_free_pct', 'innodb_row_lock_waits_per_sec'],
            windowMinutes,
            bucketSeconds,
          )
        : getSeries(
            instanceId,
            ['page_life_expectancy_seconds', 'memory_grants_pending', 'host_mem_used_pct'],
            windowMinutes,
            bucketSeconds,
          ),
      getFindings(instanceId),
      getLabeled(instanceId, 'wait_event_sessions', 8, 5),
      getLabeledPair(instanceId, 'table_total_bytes', 'table_index_bytes', 10, 30),
      getLabeled(instanceId, 'database_size_bytes', 8, 30),
      getEvents(instanceId, 10),
    ]);

  const latenciaDisco = esMaria
    ? null
    : await getLabeledPair(instanceId, 'file_read_latency_ms', 'file_write_latency_ms', 8, 30);

  const connectionsAhora = ultimo(connections, 'connections_total');
  const saturacion = ultimo(connections, 'connections_used_pct');
  const cacheAhora = ultimo(cache, 'db_cache_hit_pct');
  const bloqueadas = ultimo(bloqueos, 'blocked_sessions');
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

  const esperasRows: BarRow[] = esperasTop.map((row) => ({
    label: row.labels['wait_event'] ?? '—',
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

  const discoRows: BarRow[] = (latenciaDisco ?? []).map((row) => ({
    label: `${row.labels['database']} · ${row.labels['file_type']}`,
    sub: row.valueB !== null ? `escritura ${row.valueB.toFixed(1)} ms` : undefined,
    value: row.value,
    display: `${row.value.toFixed(1)} ms`,
    // 20 ms de lectura es el umbral con el que trabaja cualquier DBA de SQL
    // Server; arriba de 50 el disco es el problema y no hay discusión.
    tone: row.value >= 50 ? 'error' : row.value >= 20 ? 'warn' : 'accent',
  }));

  return (
    <>
      <div className="stat-grid">
        <StatCard label="Connections" value={connectionsAhora === null ? '—' : formatNumber(connectionsAhora)} />
        <StatCard
          label="Saturation"
          value={saturacion === null ? '—' : formatPct(saturacion, 1)}
          tone={saturacion === null ? undefined : toneForPct(saturacion, 75, 90)}
          hint="of configured maximum"
        />
        <StatCard
          label="Cache hits"
          value={cacheAhora === null ? '—' : formatPct(cacheAhora, 2)}
          tone={cacheAhora === null ? undefined : toneForMinimum(cacheAhora, 99, 95)}
          hint={esMaria ? 'buffer pool de InnoDB' : 'buffer pool'}
        />
        <StatCard
          label="DML per second"
          value={dmlPorSegundo === null ? '—' : formatNumber(dmlPorSegundo, 1)}
          hint="insert + update + delete"
        />
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
              value={ultimo(extra, 'buffer_pool_dirty_pct') === null
                ? '—'
                : formatPct(ultimo(extra, 'buffer_pool_dirty_pct') ?? 0, 1)}
              hint="of the buffer pool"
            />
            <StatCard
              label="Buffer pool libre"
              value={ultimo(extra, 'buffer_pool_free_pct') === null
                ? '—'
                : formatPct(ultimo(extra, 'buffer_pool_free_pct') ?? 0, 1)}
              hint="unused pages"
            />
          </>
        ) : (
          <>
            <StatCard
              label="Page life"
              value={ultimo(extra, 'page_life_expectancy_seconds') === null
                ? '—'
                : formatDuration(ultimo(extra, 'page_life_expectancy_seconds') ?? 0)}
              // 300 s es el umbral histórico, pensado para 4 GB de RAM; con más
              // memoria lo razonable es más alto, y por eso el aviso es suave.
              tone={
                ultimo(extra, 'page_life_expectancy_seconds') === null
                  ? undefined
                  : toneForMinimum(ultimo(extra, 'page_life_expectancy_seconds') ?? 0, 900, 300)
              }
              hint="how long a page survives in memory"
            />
            <StatCard
              label="System memory"
              value={ultimo(extra, 'host_mem_used_pct') === null
                ? '—'
                : formatPct(ultimo(extra, 'host_mem_used_pct') ?? 0, 1)}
              tone={
                ultimo(extra, 'host_mem_used_pct') === null
                  ? undefined
                  : toneForPct(ultimo(extra, 'host_mem_used_pct') ?? 0, 85, 95)
              }
              hint="per the engine itself"
            />
          </>
        )}
      </div>

      <div className="grid-2">
        <TimeseriesPanel
          title="Connections"
          hint={windowHint}
          data={connections}
          series={[
            { metric: 'connections_total', label: 'total', color: COLOR.accent },
            { metric: 'connections_active', label: 'activas', color: COLOR.success },
          ]}
        />
        <TimeseriesPanel
          title="DML per second"
          hint={windowHint}
          data={dml}
          series={[
            { metric: 'db_tup_inserted_per_sec', label: 'insert', color: COLOR.success },
            { metric: 'db_tup_updated_per_sec', label: 'update', color: COLOR.accent },
            { metric: 'db_tup_deleted_per_sec', label: 'delete', color: COLOR.error },
          ]}
        />
        <TimeseriesPanel
          title="Cache hits"
          hint={`${windowHint} · worst case`}
          data={cache}
          series={[{ metric: 'db_cache_hit_pct', label: 'hit %', color: COLOR.accent }]}
          unit="pct"
        />
        <TimeseriesPanel
          title="Blocked sessions"
          hint={windowHint}
          data={bloqueos}
          series={[{ metric: 'blocked_sessions', label: 'bloqueadas', color: COLOR.error }]}
        />
        {esMaria ? (
          <TimeseriesPanel
            title="Buffer pool"
            hint={windowHint}
            data={extra}
            series={[
              { metric: 'buffer_pool_dirty_pct', label: 'sucias %', color: COLOR.warning },
              { metric: 'buffer_pool_free_pct', label: 'libres %', color: COLOR.muted },
            ]}
            unit="pct"
          />
        ) : (
          <TimeseriesPanel
            title="Page life y memoria"
            hint={windowHint}
            data={extra}
            series={[
              { metric: 'page_life_expectancy_seconds', label: 'page life (s)', color: COLOR.accent },
              { metric: 'host_mem_used_pct', label: 'memoria usada %', color: COLOR.warning },
            ]}
          />
        )}
        <TimeseriesPanel
          title="Wait classes"
          hint={`${windowHint} · active sessions`}
          data={esperas.points}
          series={esperas.keys.map((key, index) => ({
            metric: key,
            label: key,
            color: WAIT_COLORS[index % WAIT_COLORS.length] ?? COLOR.muted,
          }))}
        />
      </div>

      <div className="grid-2">
        <FindingsPanel findings={findings} checkedAt={findings[0] ? formatClock(findings[0].ts) : null} />
        <LabeledBars
          title="What sessions are waiting on"
          rows={esperasRows}
          emptyMessage="No sessions waiting."
          footer={esMaria ? 'command state in processlist' : 'wait type of the active request'}
        />
        <LabeledBars title="Largest tables" rows={tablasRows} emptyMessage="No table data yet." />
        {esMaria ? (
          <LabeledBars title="Size by database" rows={basesRows} emptyMessage="No database data yet." />
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
                    {evento.ts.toLocaleTimeString('es')}
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
