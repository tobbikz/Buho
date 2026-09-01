import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StatementsTable } from '@/components/StatementsTable';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatNumber } from '@/lib/format';
import {
  getInstance,
  getStatementLoad,
  getStatementSeries,
  getTopStatements,
  type StatementOrder,
  type StatementPoint,
  type TopStatement,
} from '@/lib/queries';
import { getInstanceEngine } from '@/lib/estate';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '15m', minutes: 15, bucketSeconds: 60 },
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
  // La retención de deltas por consulta es de 14 días, así que 7 d es una
  // window honesta acá.
  { key: '7d', minutes: 10_080, bucketSeconds: 3_600 },
] as const;

const ORDERS: Array<{ key: StatementOrder; label: string }> = [
  { key: 'time', label: 'Tiempo total' },
  { key: 'calls', label: 'Calls' },
  { key: 'mean', label: 'Media' },
  { key: 'rows', label: 'Rows' },
];

function duration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * Cuando falta la extensión no se muestra un vacío: se muestra qué correr. El
 * caso `preloaded_not_created` es el interesante porque no necesita reinicio, y
 * es el más común en instancias que nadie configuró a fondo.
 */
function ActivationAssistant({ state }: { state: string | null }) {
  const preloaded = state === 'preloaded_not_created';

  return (
    <section className="panel" style={{ borderLeft: '3px solid var(--warning)' }}>
      <div className="panel-header">
        <span className="panel-title">pg_stat_statements is not active</span>
        <span className="tag tag--warn">{state ?? 'desconocido'}</span>
      </div>
      <div className="panel-body">
        <p className="text-[12.5px]">
          {preloaded
            ? 'The library is already in shared_preload_libraries: the extension can be created hot, without restarting the server or dropping connections.'
            : 'The library is not preloaded. Adding it to shared_preload_libraries requires a server restart, so plan a maintenance window.'}
        </p>

        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          {preloaded ? 'Un solo paso' : 'Step 1 — preload the library (requires restart)'}
        </p>
        <pre className="mt-1 border border-border bg-surface-muted p-2 font-mono text-[11px]">
          {preloaded
            ? 'CREATE EXTENSION pg_stat_statements;'
            : "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';\n-- restart the server\nCREATE EXTENSION pg_stat_statements;"}
        </pre>

        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          Costo real de tenerlo activo
        </p>
        <p className="mt-1 text-[12px] text-foreground-secondary">
          Un arreglo en memoria compartida de tamaño fijo (<span className="font-mono">pg_stat_statements.max</span>,
          5.000 entradas por defecto) y unos pocos porcentajes de overhead por sentencia. Guarda el texto{' '}
          <strong>normalized</strong>: without literals, so it does not expose business data.
        </p>

        <p className="mt-3 text-[12px] text-foreground-secondary">
          Búho detecta el cambio en el siguiente reprobe (una hora como max) y empieza a guardar los deltas por
          <span className="font-mono"> queryid</span> sin reiniciar nada.
        </p>
      </div>
    </section>
  );
}


/**
 * Por qué la pantalla de consultas puede estar vacía en MariaDB o SQL Server.
 *
 * No es lo mismo "no hay consultas" que "no puedo verlas", y la diferencia es
 * distinta en cada motor: en MariaDB hace falta encender performance_schema
 * (con reinicio); en SQL Server la caché de planes se vacía sola y basta con
 * esperar tráfico.
 */
function ForeignQueriesNotice({ engine, instanceId }: { engine: string; instanceId: number }) {
  const esMaria = engine === 'mariadb';
  return (
    <section className="panel" style={{ borderLeft: '3px solid var(--warning)' }}>
      <div className="panel-header">
        <span className="panel-title">
          {esMaria ? 'performance_schema may be off' : 'no queries recorded yet'}
        </span>
      </div>
      <div className="panel-body text-[12px]">
        {esMaria ? (
          <>
            <p>
              MariaDB agrupa las consultas por digest en{' '}
              <span className="font-mono">performance_schema.events_statements_summary_by_digest</span>, y esa vista
              está vacía si <span className="font-mono">performance_schema</span> está apagado. Es el valor por
              omisión en varias distribuciones.
            </p>
            <div className="query-block mt-2">{'[mysqld]\nperformance_schema = ON'}</div>
            <p className="mt-2">
              Requiere reiniciar el servidor; el costo typical es de un 5 % de CPU. El colector deja escrito el motivo
              exacto en los{' '}
              <Link href={`/instances/${instanceId}`} className="text-accent">
                eventos de la instancia
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <p>
              Las consultas salen de <span className="font-mono">sys.dm_exec_query_stats</span>, que vive en la caché
              de planes: se vacía al reiniciar el servicio, al recompilar un plan y bajo presión de memoria. Con
              tráfico, las filas aparecen en el primer ciclo de un minuto.
            </p>
            <p className="mt-2">
              If it must survive a restart, turn on Query Store in the database:{' '}
              <span className="font-mono">ALTER DATABASE … SET QUERY_STORE = ON</span>.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export default async function QueriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string; order?: string; monitor?: string; buscar?: string }>;
}) {
  const { id } = await params;
  const { w, order, monitor, buscar } = await searchParams;
  const filtro = buscar?.trim() ? buscar.trim() : null;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();
  // Estas pantallas leen vistas de PostgreSQL. Si alguien llega acá con la URL
  // de un MariaDB o un SQL Server, se lo devuelve a su inventario en vez de
  // mostrarle paneles vacíos que parecen un fallo.
  const engineKind = await getInstanceEngine(instanceId);
  // Bloqueos, métricas, consultas y log existen en los tres motores desde la
  // paridad; sólo Vacuum, Host y Replicación siguen siendo de PostgreSQL.
  const engine = engineKind ?? 'postgres';


  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1];
  const selectedOrder: StatementOrder =
    ORDERS.find((candidate) => candidate.key === order)?.key ?? 'time';
  const showMonitorQueries = monitor === 'on';

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

  const crumbs = [
    { label: 'Fleet', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Queries' },
  ];

  let statements: TopStatement[] = [];
  let load: Awaited<ReturnType<typeof getStatementLoad>> = [];
  let trends: Map<string, StatementPoint[]> = new Map();
  let failure: string | null = null;
  try {
    [statements, load] = await Promise.all([
      getTopStatements(instanceId, window.minutes, selectedOrder, !showMonitorQueries, 25, filtro),
      getStatementLoad(instanceId, window.minutes, window.bucketSeconds, !showMonitorQueries),
    ]);
    // Depende del top, así que va en un segundo viaje: pedir la evolución de
    // todas las consultas de la window traería miles de series inútiles.
    trends = await getStatementSeries(
      instanceId,
      statements.map((row) => row.queryid),
      window.minutes,
      window.bucketSeconds,
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const totalExecMs = statements.reduce((sum, row) => sum + row.execMs, 0);
  const totalCalls = statements.reduce((sum, row) => sum + row.calls, 0);
  const peakLoad = load.reduce((peak, point) => Math.max(peak, point['db_time_sessions'] ?? 0), 0);

  const queryLink = (patch: Record<string, string>) => {
    const search = new URLSearchParams({
      w: window.key,
      order: selectedOrder,
      ...(showMonitorQueries ? { monitor: 'on' } : {}),
      ...patch,
    });
    return `/instances/${instanceId}/queries?${search.toString()}`;
  };

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Queries · {instance.alias}</h1>
            <p className="page-sub">
              Actividad por consulta normalizada, sumada por intervalos. No es el contador acumulado desde el último
              reset del servidor: es lo que pasó en la window elegida.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((candidate) => (
              <Link
                key={candidate.key}
                href={queryLink({ w: candidate.key })}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </Link>
            ))}
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />


        {filtro && (

          <div className="panel">

            <div className="panel-body flex items-center justify-between gap-3 text-[12px]">

              <span>

                Filtering by <span className="font-mono">{filtro}</span>. Only queries whose text,

                rol o base lo contienen.

              </span>

              <Link href={`/instances/${instanceId}/queries?w=${window.key}&order=${selectedOrder}`} className="tag tag--muted">

                quitar filtro

              </Link>

            </div>

          </div>

        )}

        {engine === 'postgres' && instance.statStatements !== 'active' ? (
          <ActivationAssistant state={instance.statStatements} />
        ) : engine !== 'postgres' && statements.length === 0 ? (
          <ForeignQueriesNotice engine={engine} instanceId={instanceId} />
        ) : failure ? (
          <StoreError message={failure} />
        ) : (
          <>
            <div className="stat-grid">
              <StatCard
                label="Distinct queries"
                value={formatNumber(statements.length)}
                hint={`window ${window.key}`}
                tone="accent"
              />
              <StatCard label="Execution time" value={duration(totalExecMs)} hint="suma del top 25" />
              <StatCard label="Calls" value={formatNumber(totalCalls)} hint="suma del top 25" />
              <StatCard
                label="Pico de DB time"
                value={peakLoad > 0 && peakLoad < 0.01 ? '<0.01' : peakLoad.toFixed(2)}
                unit=" sessions"
                hint="1.00 = one fully busy session"
                tone={peakLoad >= 4 ? 'error' : peakLoad >= 1 ? 'warn' : 'ok'}
              />
            </div>

            <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
              <TimeseriesPanel
                title="DB time (equivalent sessions)"
                hint="load approximation: PostgreSQL does not expose host CPU"
                data={load}
                unit="count"
                height={160}
                series={[{ metric: 'db_time_sessions', label: 'Equivalent sessions', color: '#005eb8' }]}
              />
              <TimeseriesPanel
                title="Calls per second"
                hint={`window ${window.key}`}
                data={load}
                unit="rate"
                height={160}
                series={[{ metric: 'calls_per_sec', label: 'Calls', color: '#0a6e42' }]}
              />
            </div>

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Top queries</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-foreground-muted">ordenar por</span>
                  <div className="flex items-center gap-1">
                    {ORDERS.map((candidate) => (
                      <Link
                        key={candidate.key}
                        href={queryLink({ order: candidate.key })}
                        className={`tag ${candidate.key === selectedOrder ? 'tag--info' : 'tag--muted'}`}
                      >
                        {candidate.label}
                      </Link>
                    ))}
                  </div>
                  <Link
                    href={queryLink({ monitor: showMonitorQueries ? 'off' : 'on' })}
                    className={`tag ${showMonitorQueries ? 'tag--warn' : 'tag--muted'}`}
                    title="The monitor's own catalog queries dominate any ranking by calls"
                  >
                    {showMonitorQueries ? 'with monitor queries' : 'without monitor queries'}
                  </Link>
                </div>
              </div>
              <StatementsTable
                instanceId={instanceId}
                explainable={engine === 'postgres'}
                totalExecMs={totalExecMs}
                rows={statements.map((row) => {
                  const points = trends.get(row.queryid) ?? [];
                  return {
                    queryid: row.queryid,
                    query: row.query,
                    username: row.username,
                    calls: row.calls,
                    execMs: row.execMs,
                    meanMs: row.meanMs,
                    rows: row.rows,
                    tempWritten: row.tempWritten,
                    walBytes: row.walBytes,
                    hitPct: row.hitPct,
                    trend: points.map((point) => point.execMs),
                    callsTrend: points.map((point) => point.calls),
                  };
                })}
              />
            </section>
          </>
        )}
      </div>
    </>
  );
}
