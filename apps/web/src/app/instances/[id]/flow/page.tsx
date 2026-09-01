import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { FlowSankey, OperationBars } from '@/components/FlowSankey';
import { LiveFlow } from '@/components/LiveFlow';
import { Heatmap } from '@/components/Heatmap';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatNumber, formatPct } from '@/lib/format';
import { formatUnit, type Unit } from '@/lib/units';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { getFlow, getTableCounters, type FlowActor, type FlowDirection } from '@/lib/flow';
import {
  busiestHour,
  getHeatmap,
  quietestHour,
  HEAT_OPTIONS,
  WEEKDAY_LABEL,
  type HeatAgg,
} from '@/lib/heatmap';
import type { FlowWeight } from '@buho/core';

export const dynamic = 'force-dynamic';

const WEIGHTS: { key: FlowWeight; label: string; hint: string }[] = [
  { key: 'rows', label: 'Rows', hint: 'where data volume lands' },
  { key: 'time', label: 'Time', hint: 'where the server spends time' },
  { key: 'calls', label: 'Calls', hint: 'what is called most often' },
];

const WINDOWS: { key: string; label: string; minutes: number }[] = [
  { key: '1h', label: '1 h', minutes: 60 },
  { key: '6h', label: '6 h', minutes: 360 },
  { key: '24h', label: '24 h', minutes: 1440 },
  { key: '7d', label: '7 d', minutes: 10080 },
];

const HEAT_WINDOWS: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '365d', label: '1 year', days: 365 },
];

/** La unidad del peso elegido: el tiempo viene en milisegundos, el resto son cuentas. */
function unitFor(weight: FlowWeight): Unit {
  return weight === 'time' ? 'ms' : 'count';
}

export default async function FlowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    peso?: string;
    v?: string;
    dir?: string;
    quien?: string;
    vista?: string;
    calor?: string;
    cv?: string;
    agg?: string;
  }>;
}) {
  const { id } = await params;
  const { peso, v, dir, quien, vista, calor, cv, agg } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;
  const direction: FlowDirection = dir === 'lectura' ? 'lectura' : 'escritura';
  const actor: FlowActor = quien === 'aplicacion' ? 'aplicacion' : 'rol';
  // El lienzo vivo es lo primero que se ve porque contesta la pregunta más
  // frecuente al abrir la pantalla —"¿está pasando algo ahora?"—, y el diagrama
  // acumulado queda a un clic para la pregunta de después: "¿qué pasó hoy?".
  const enVivo = vista !== 'acumulado';
  const heatOption = HEAT_OPTIONS.find((entrada) => entrada.key === calor) ?? HEAT_OPTIONS[0]!;
  const heatWindow = HEAT_WINDOWS.find((entrada) => entrada.key === cv) ?? HEAT_WINDOWS[1]!;
  const heatAgg: HeatAgg = agg === 'max' ? 'max' : 'avg';

  let instance;
  let flow: Awaited<ReturnType<typeof getFlow>>;
  let counters: Awaited<ReturnType<typeof getTableCounters>>;
  let heat: Awaited<ReturnType<typeof getHeatmap>>;
  try {
    [instance, flow, counters, heat] = await Promise.all([
      getInstance(instanceId),
      getFlow(instanceId, window.minutes, weight, direction, engine, actor),
      getTableCounters(instanceId, window.minutes),
      getHeatmap(instanceId, heatOption, heatWindow.days, heatAgg),
    ]);
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
    { label: 'Flow' },
  ];

  const enlace = (cambios: Record<string, string>) => {
    const parametros = new URLSearchParams({
      peso: weight,
      v: window.key,
      dir: direction,
      quien: actor,
      vista: enVivo ? 'vivo' : 'acumulado',
      calor: heatOption.key,
      cv: heatWindow.key,
      agg: heatAgg,
      ...cambios,
    });
    return `/instances/${instanceId}/flow?${parametros.toString()}`;
  };

  const unidad = unitFor(weight);
  const formato = (valor: number): string => formatUnit(valor, unidad);
  const pesoTabla = (tabla: (typeof flow.tables)[number]): number =>
    weight === 'calls' ? tabla.calls : weight === 'time' ? tabla.execMs : tabla.rows;

  const cobertura =
    flow.weightTotal > 0 ? (flow.weightAttributed / flow.weightTotal) * 100 : 0;

  // Los contadores del propio PostgreSQL, para contrastar la atribución.
  const escriturasContadas = counters.reduce(
    (suma, fila) => suma + fila.inserted + fila.updated + fila.deleted,
    0,
  );
  const escriturasAtribuidas = flow.tables.reduce((suma, tabla) => suma + tabla.rows, 0);

  const tranquila = quietestHour(heat, 2);
  const cargada = busiestHour(heat, 2);
  const unidadCalor: Unit = heatOption.unit === 'rate' ? 'rate' : 'count';
  const formatoCalor = (valor: number): string => formatUnit(valor, unidadCalor);

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Flow and usage · {instance.alias}</h1>
            <p className="page-sub">
              Por dónde entra el tráfico y dónde cae. El diagrama cruza el rol que ejecuta con la tabla que toca;
              la rejilla muestra a qué horas de la semana se usa el servidor. La atribución del diagrama es{' '}
              <strong>aproximada</strong>: sale de leer el texto de cada consulta
              {engine === 'postgres'
                ? ', and PostgreSQL counters are below for contrast.'
                : ', and this engine has no per-table counters to contrast against.'}
            </p>
          </div>
          <AutoRefresh intervalMs={30000} />
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label={direction === 'escritura' ? 'Rows written' : 'Rows read'}
            value={formato(escriturasAtribuidas)}
            hint={`attributed, window ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Tables with traffic"
            value={formatNumber(flow.tables.length)}
            hint={direction === 'escritura' ? 'target of some DML' : 'read by some query'}
          />
          <StatCard
            label="Attributed queries"
            value={`${formatNumber(flow.attributed)} / ${formatNumber(flow.statements)}`}
            hint={`${formatPct(cobertura, 0)} of total weight`}
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
          {engine === 'postgres' ? (
            <StatCard
              label="Per the counters"
              value={formatNumber(Math.round(escriturasContadas))}
              hint="DML rows measured by PostgreSQL"
            />
          ) : (
            <StatCard
              label="Rol de quien ejecuta"
              value={engine === 'mariadb' ? 'no informado' : 'per session'}
              hint={
                engine === 'mariadb'
                  ? 'performance_schema does not store the user in digests'
                  : 'SQL Server aggregates by plan, without the role'
              }
            />
          )}
        </div>

        {/* ------------------------------------------------------------ flujo */}
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {direction === 'escritura' ? 'Who writes where' : 'Who reads from where'}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <Link
                href={enlace({ vista: 'vivo' })}
                className={`tag ${enVivo ? 'tag--ok' : 'tag--muted'}`}
                title="what is moving now, last 5 minutes"
              >
                en vivo
              </Link>
              <Link
                href={enlace({ vista: 'acumulado' })}
                className={`tag ${enVivo ? 'tag--muted' : 'tag--info'}`}
                title="total for the selected window"
              >
                acumulado
              </Link>
              <span className="mx-1 text-foreground-muted">·</span>
              {(['rol', 'aplicacion'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ quien: opcion })}
                  className={`tag ${opcion === actor ? 'tag--info' : 'tag--muted'}`}
                  title={
                    opcion === 'rol'
                      ? 'exact: pg_stat_statements stores the role'
                      : 'estimated by sampling pg_stat_activity'
                  }
                >
                  por {opcion}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {(['escritura', 'lectura'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ dir: opcion })}
                  className={`tag ${opcion === direction ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {WEIGHTS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ peso: opcion.key })}
                  className={`tag ${opcion.key === weight ? 'tag--info' : 'tag--muted'}`}
                  title={opcion.hint}
                >
                  {opcion.label}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {WINDOWS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ v: opcion.key })}
                  className={`tag ${opcion.key === window.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="panel-body">
            {enVivo ? (
              <LiveFlow
                scope="instancia"
                instanceId={instanceId}
                weight={weight}
                direction={direction}
                actor={actor}
                unit={unidad}
              />
            ) : (
            <FlowSankey
              nodes={flow.nodes}
              links={flow.links}
              unit={unidad}
              emptyMessage={
                flow.statements === 0
                  ? escriturasContadas > 0
                    ? // Caso real y confuso si no se explica: los contadores ven
                      // tráfico pero no hay ninguna consulta que atribuir. Pasa
                      // cuando quien escribe queda fuera de pg_stat_statements,
                      // y el caso más común es esta misma base, porque Búho
                      // marca sus consultas para no contarse a sí mismo.
                      'Counters see writes but no query was recorded in pg_stat_statements. Often intentional exclusion: Búho tags monitor queries and does not attribute them.'
                    : "No application queries in the window. Búho's own queries do not count, so an instance that only receives monitoring looks empty here."
                  : direction === 'escritura' && weight === 'rows' && engine === 'mssql'
                    ? // En SQL Server el DML no aporta filas a dm_exec_query_stats,
                      // así que pesar por filas deja el diagrama vacío aunque haya
                      // tráfico. Vale más decirlo que dejar la pantalla en blanco.
                      'SQL Server does not count rows modified per query, so weighting writes by rows is zero. Try "tiempo" or "llamadas".'
                    : direction === 'escritura'
                      ? 'No writes could be attributed to a table in this window. If the database is read-only, try "lectura".'
                      : 'No reads could be attributed to a table in this window.'
              }
            />
            )}
            {actor === 'aplicacion' && (
              <p className="mt-2 text-[11px] text-foreground-muted">
                The left column is an <strong>estimate</strong>: the application name is not in the
                cumulative statistics, so it comes from looking every five seconds at who is running what and then
                distributing weight in that proportion. A query shorter than the interval may never be seen, and
                that is why unobserved ones are grouped as «not observed»
                {flow.weightAttributed > 0
                  ? `, which today is ${formatPct(100 - (flow.weightWithActor / flow.weightAttributed) * 100, 0)} of attributed weight.`
                  : '.'}{' '}
                The role, by contrast, is exact.
              </p>
            )}
            <p className="mt-2 text-[11px] text-foreground-muted">
              Cuando una consulta toca varias tablas, su peso se reparte entre ellas: cargarlo entero a cada una
              multiplicaría el tráfico y el diagrama mentiría sobre el volumen. Los esquemas del sistema quedan
              fuera —<span className="font-mono">pg_catalog</span>,{' '}
              <span className="font-mono">information_schema</span>,{' '}
              <span className="font-mono">performance_schema</span>,{' '}
              <span className="font-mono">mysql</span>— porque ese tráfico es del monitoreo y de las herramientas,
              no de la aplicación.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-3">
          {/* ------------------------------------------------- por operación */}
          <section className="panel xl:col-span-1">
            <div className="panel-header">
              <span className="panel-title">What kind of traffic recibe cada tabla</span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">No attributed tables in the window.</div>
              ) : (
                <OperationBars
                  rows={flow.tables.map((tabla) => ({
                    relation: tabla.relation,
                    byOperation: tabla.byOperation as Record<string, number | undefined>,
                    total: pesoTabla(tabla),
                  }))}
                  unit={unidad}
                />
              )}
            </div>
          </section>

          {/* ----------------------------------------------- contraste honesto */}
          <section className="panel xl:col-span-2">
            <div className="panel-header">
              <span className="panel-title">
                {engine === 'postgres'
                  ? 'What PostgreSQL counters say'
                  : 'Contrast with engine counters'}
              </span>
              <span className="font-mono text-[10px] text-foreground-muted">window {window.label}</span>
            </div>
            <div className="panel-body">
              {engine !== 'postgres' ? (
                <div className="empty">
                  {engine === 'mariadb' ? 'MariaDB' : 'SQL Server'} no expone contadores de filas por tabla como
                  those in <span className="font-mono">pg_stat_user_tables</span>, so there is nothing here to
                  contrastar: en este motor el diagrama es la única fuente y su atribución es aproximada.
                </div>
              ) : counters.length === 0 ? (
                <div className="empty">
                  Todavía no hay dos muestras de actividad por tabla. El colector las toma cada minuto.
                </div>
              ) : (
                <div className="table-scroll" style={{ maxHeight: '20rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tabla</th>
                        <th className="text-right">Insertadas</th>
                        <th className="text-right">Actualizadas</th>
                        <th className="text-right">HOT</th>
                        <th className="text-right">Borradas</th>
                        <th className="text-right">Secuenciales</th>
                        <th className="text-right">By index</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counters.slice(0, 20).map((fila) => {
                        const hotPct =
                          fila.updated > 0 ? (fila.hotUpdated / fila.updated) * 100 : null;
                        return (
                          <tr key={fila.relation}>
                            <td className="font-mono text-[11px]">{fila.relation}</td>
                            <td className="num">{formatNumber(Math.round(fila.inserted))}</td>
                            <td className="num">{formatNumber(Math.round(fila.updated))}</td>
                            <td className="num">
                              {hotPct === null ? (
                                '·'
                              ) : (
                                // Por debajo del 50 % de HOT, cada update está
                                // reescribiendo indexs: es la señal más directa
                                // de que sobran indexes en una tabla caliente.
                                <span className={hotPct < 50 ? 'text-[var(--warning)]' : ''}>
                                  {hotPct.toFixed(0)}%
                                </span>
                              )}
                            </td>
                            <td className="num">{formatNumber(Math.round(fila.deleted))}</td>
                            <td className="num">{formatNumber(Math.round(fila.seqScans))}</td>
                            <td className="num">{formatNumber(Math.round(fila.idxScans))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {engine === 'postgres' && (
                <p className="mt-2 text-[11px] text-foreground-muted">
                  Estos números no dependen de haber entendido ninguna consulta. Si no cuadran con el diagrama,
                  ellos tienen razón: la atribución se pierde con triggers, cascadas de claves foráneas y consultas
                  que se cayeron de <span className="font-mono">pg_stat_statements</span>. La columna HOT es la
                  share of updates that touched no index.
                </p>
              )}
            </div>
          </section>
        </div>

        {/* ----------------------------------------------------------- calor */}
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">When it is used · {heatOption.label}</span>
            <div className="flex flex-wrap items-center gap-1">
              {HEAT_OPTIONS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ calor: opcion.key })}
                  className={`tag ${opcion.key === heatOption.key ? 'tag--info' : 'tag--muted'}`}
                  title={opcion.hint}
                >
                  {opcion.label}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {(['avg', 'max'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ agg: opcion })}
                  className={`tag ${opcion === heatAgg ? 'tag--info' : 'tag--muted'}`}
                  title={
                    opcion === 'avg'
                      ? 'what a typical hour looks like'
                      : 'how bad it ever got at that hour'
                  }
                >
                  {opcion === 'avg' ? 'typical' : 'worst case'}
                </Link>
              ))}
              <span className="mx-1 text-foreground-muted">·</span>
              {HEAT_WINDOWS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ cv: opcion.key })}
                  className={`tag ${opcion.key === heatWindow.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="panel-body">
            {heat.cells.length === 0 ? (
              <div className="empty">
                No hourly rollups yet for {heatOption.label.toLowerCase()}. The first appears at the hour of
                arrancar el colector.
              </div>
            ) : (
              <>
                <Heatmap cells={heat.cells} max={heat.max} unit={unidadCalor} minSamples={2} />
                <p className="mt-3 text-[12px]">
                  {cargada && (
                    <>
                      La hora más cargada es el{' '}
                      <strong>
                        {WEEKDAY_LABEL[cargada.weekday]} a las {String(cargada.hour).padStart(2, '0')}:00
                      </strong>{' '}
                      con {formatoCalor(cargada.value)}
                      {tranquila && (
                        <>
                          , y la más tranquila el{' '}
                          <strong>
                            {WEEKDAY_LABEL[tranquila.weekday]} a las{' '}
                            {String(tranquila.hour).padStart(2, '0')}:00
                          </strong>{' '}
                          con {formatoCalor(tranquila.value)}: ahí va la window de mantenimiento
                        </>
                      )}
                      .
                    </>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-foreground-muted">
                  {heat.daysCovered < 14
                    ? `Only ${Math.round(heat.daysCovered)} day${Math.round(heat.daysCovered) === 1 ? '' : 's'} of history: the grid does not yet distinguish Tuesday from Thursday. With two weeks it starts to mean something, and ${heat.emptyCells} cell${heat.emptyCells === 1 ? '' : 's'} still have no data.`
                    : `${Math.round(heat.daysCovered)} days of history. Hatched cells have no data; pale ones were measured only once.`}{' '}
                  Color is relative to this grid, so it does not compare across instances. The hour is the
                  operator's, not the store's.
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
