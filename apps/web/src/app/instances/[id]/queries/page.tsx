import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { statementKind } from '@buho/core';
import { InstanceTabs } from '@/components/InstanceTabs';
import { PollWhilePending } from '@/components/PollWhilePending';
import { StatCard } from '@/components/StatCard';
import { StatementsTable } from '@/components/StatementsTable';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatDuration, formatNumber } from '@/lib/format';
import {
  getInstance,
  getSeries,
  getStatementLoad,
  getStatementSeries,
  getTopStatements,
  type StatementOrder,
  type StatementPoint,
  type TopStatement,
} from '@/lib/queries';
import { getInstanceEngine } from '@/lib/estate';
import { getPlanRequest, requestPlan } from '@/lib/plans';
import { currentSession } from '@/lib/session';
import { getLatestSessions } from '@/lib/sessions';

async function explainLiveQuery(formData: FormData): Promise<void> {
  'use server';
  const session = await currentSession();
  const instanceId = Number(formData.get('instanceId'));
  const pid = String(formData.get('pid') ?? '');
  const sql = String(formData.get('sql') ?? '').trim();
  const back = `/instances/${instanceId}/queries?vista=live&pid=${encodeURIComponent(pid)}`;
  if (!sql) redirect(`${back}&error=${encodeURIComponent('This session has no query text to explain.')}`);
  const kind = statementKind(sql);
  if (kind === 'utilitaria') {
    redirect(`${back}&error=${encodeURIComponent('This statement has no query plan.')}`);
  }
  const requestId = await requestPlan(instanceId, sql, 'estimate', session.username, null);
  redirect(`${back}&plan=${requestId}`);
}

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
          {esMaria ? 'waiting for query samples' : 'no queries recorded yet'}
        </span>
      </div>
      <div className="panel-body text-[12px]">
        {esMaria ? (
          <>
            <p>
              With <span className="font-mono">performance_schema=ON</span>, Búho reads digests from{' '}
              <span className="font-mono">events_statements_summary_by_digest</span>. Without it, the collector
              samples <span className="font-mono">INFORMATION_SCHEMA.PROCESSLIST</span> (lossy for sub-second
              queries — leave a longer statement running or wait a cycle).
            </p>
            <div className="query-block mt-2">{'[mysqld]\nperformance_schema = ON'}</div>
            <p className="mt-2">
              Enabling P_S needs a restart (~5% CPU typical) and unlocks digests, wait instruments, stages, and
              table I/O. See instance{' '}
              <Link href={`/instances/${instanceId}`} className="text-accent">
                events
              </Link>{' '}
              for the exact probe limitation.
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
  searchParams: Promise<{
    w?: string;
    order?: string;
    monitor?: string;
    buscar?: string;
    vista?: string;
    plan?: string;
    pid?: string;
    error?: string;
  }>;
}) {
  const { id } = await params;
  const { w, order, monitor, buscar, vista, plan, pid, error: planError } = await searchParams;
  const live = vista === 'live';
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

  let latest: Awaited<ReturnType<typeof getLatestSessions>> | null = null;
  let statements: TopStatement[] = [];
  let load: Awaited<ReturnType<typeof getStatementLoad>> = [];
  let trends: Map<string, StatementPoint[]> = new Map();
  let slow: TopStatement[] = [];
  let slowSeries: Awaited<ReturnType<typeof getSeries>> = [];
  let failure: string | null = null;
  let planText: string | null = null;
  let planState: string | null = null;
  let planMessage: string | null = planError ?? null;
  try {
    if (live) {
      latest = await getLatestSessions(instanceId);
      if (plan) {
        const requested = await getPlanRequest(Number(plan));
        if (requested && requested.instanceId === instanceId) {
          planText = requested.planText;
          planState = requested.state;
          planMessage = requested.error ?? planMessage;
        }
      }
    } else {
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
    if (engine === 'mariadb') {
      const byMean = await getTopStatements(
        instanceId,
        window.minutes,
        'mean',
        !showMonitorQueries,
        40,
        filtro,
      );
      slow = byMean.filter((row) => row.meanMs >= 500).slice(0, 15);
      slowSeries = await getSeries(
        instanceId,
        ['slow_queries_per_sec', 'slow_digest_count'],
        window.minutes,
        window.bucketSeconds,
      );
    }
    }
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
      vista: live ? 'live' : 'analytical',
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
              {live
                ? 'What is running in the latest session snapshot. Analytical is the retained window of normalized statements.'
                : 'Actividad por consulta normalizada, sumada por intervalos. No es el contador acumulado desde el último reset del servidor: es lo que pasó en la window elegida.'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Link href={queryLink({ vista: 'analytical' })} className={`tag ${live ? 'tag--muted' : 'tag--info'}`}>
              Analytical
            </Link>
            <Link href={queryLink({ vista: 'live' })} className={`tag ${live ? 'tag--ok' : 'tag--muted'}`}>
              Live
            </Link>
            {live ? null : (
            <>
            <span className="mx-1 text-foreground-muted">·</span>
            {WINDOWS.map((candidate) => (
              <Link
                key={candidate.key}
                href={queryLink({ w: candidate.key })}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </Link>
            ))}
            </>
            )}
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        {live ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Running now</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                {latest?.at ? formatAgo(latest.at) : 'no snapshot'}
              </span>
            </div>
            {planMessage ? (
              <div className="panel-body text-[12px]" style={{ color: 'var(--warning)' }}>
                {planMessage}
              </div>
            ) : null}
            {planState === 'pendiente' || planState === 'corriendo' ? <PollWhilePending /> : null}
            {!latest || latest.sessions.length === 0 ? (
              <div className="empty">No session snapshot in the last 10 minutes.</div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>State</th>
                      <th>Session</th>
                      <th className="text-right">Query</th>
                      <th>Text</th>
                      <th>Plan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latest.sessions.map((session) => {
                      const open = pid === String(session.pid);
                      return (
                        <tr key={session.pid}>
                          <td className="font-mono text-[11px]">{session.state}</td>
                          <td className="font-mono text-[11px]">
                            pid {session.pid}
                            {session.application ? ` · ${session.application}` : ''}
                          </td>
                          <td className="num">
                            {session.queryMs === null ? '—' : formatDuration(session.queryMs / 1000)}
                          </td>
                          <td className="max-w-[28rem] font-mono text-[11px]">
                            <div className="truncate" title={session.query ?? ''}>
                              {session.query?.trim() || '—'}
                            </div>
                            {open && planText ? (
                              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border border-border bg-surface-muted p-2 text-[10.5px]">
                                {planText}
                              </pre>
                            ) : null}
                          </td>
                          <td>
                            <form action={explainLiveQuery}>
                              <input type="hidden" name="instanceId" value={instanceId} />
                              <input type="hidden" name="pid" value={session.pid} />
                              <input type="hidden" name="sql" value={session.query ?? ''} />
                              <button type="submit" className="tag tag--muted" disabled={!session.query?.trim()}>
                                Estimated plan
                              </button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        {live ? null : (
        <>
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

            {engine === 'mariadb' ? (
              <>
                <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
                  <TimeseriesPanel
                    title="Slow queries /s"
                    hint={`${window.key} · SLOW_QUERIES counter (long_query_time)`}
                    data={slowSeries}
                    unit="rate"
                    height={160}
                    series={[
                      {
                        metric: 'slow_queries_per_sec',
                        label: 'Slow queries/s',
                        color: '#b01818',
                        filled: true,
                      },
                    ]}
                  />
                  <TimeseriesPanel
                    title="Slow digests"
                    hint="digests with avg ≥ long_query_time (performance_schema)"
                    data={slowSeries}
                    unit="count"
                    height={160}
                    series={[
                      {
                        metric: 'slow_digest_count',
                        label: 'Slow digests',
                        color: '#9a4a00',
                        filled: true,
                      },
                    ]}
                  />
                </div>
                <section className="panel">
                  <div className="panel-header">
                    <span className="panel-title">Slow queries · mean ≥ 500 ms</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-foreground-muted">
                        {slow.length} in window {window.key}
                      </span>
                      <Link
                        href={`/instances/${instanceId}/slow-queries?w=${window.key}`}
                        className="tag tag--info"
                      >
                        Full Slow queries tab →
                      </Link>
                    </div>
                  </div>
                  {slow.length === 0 ? (
                    <div className="panel-body empty text-[12px]">
                      No digests with mean ≥ 500 ms in this window. Lower{' '}
                      <span className="font-mono">long_query_time</span> or wait for slower traffic. Without
                      performance_schema, sort Top queries by Media after PROCESSLIST sampling catches a long
                      statement.
                    </div>
                  ) : (
                    <StatementsTable
                      instanceId={instanceId}
                      explainable={true}
                      totalExecMs={slow.reduce((sum, row) => sum + row.execMs, 0)}
                      rows={slow.map((row) => ({
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
                        trend: [],
                        callsTrend: [],
                      }))}
                    />
                  )}
                </section>
              </>
            ) : null}

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Top queries</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-foreground-muted">sort by</span>
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
                explainable={engine === 'postgres' || engine === 'mariadb'}
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
        </>
        )}
      </div>
    </>
  );
}
