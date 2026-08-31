import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { FlowSankey, OperationBars } from '@/components/FlowSankey';
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
  { key: 'rows', label: 'Filas', hint: 'dónde cae el volumen de datos' },
  { key: 'time', label: 'Tiempo', hint: 'dónde se gasta el servidor' },
  { key: 'calls', label: 'Llamadas', hint: 'qué se llama más veces' },
];

const WINDOWS: { key: string; label: string; minutes: number }[] = [
  { key: '1h', label: '1 h', minutes: 60 },
  { key: '6h', label: '6 h', minutes: 360 },
  { key: '24h', label: '24 h', minutes: 1440 },
  { key: '7d', label: '7 d', minutes: 10080 },
];

const HEAT_WINDOWS: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7 días', days: 7 },
  { key: '30d', label: '30 días', days: 30 },
  { key: '90d', label: '90 días', days: 90 },
  { key: '365d', label: '1 año', days: 365 },
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
    calor?: string;
    cv?: string;
    agg?: string;
  }>;
}) {
  const { id } = await params;
  const { peso, v, dir, quien, calor, cv, agg } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  const weight = (WEIGHTS.find((entrada) => entrada.key === peso)?.key ?? 'rows') as FlowWeight;
  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[2]!;
  const direction: FlowDirection = dir === 'lectura' ? 'lectura' : 'escritura';
  const actor: FlowActor = quien === 'aplicacion' ? 'aplicacion' : 'rol';
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
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const crumbs = [
    { label: 'Flota', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Flujo' },
  ];

  const enlace = (cambios: Record<string, string>) => {
    const parametros = new URLSearchParams({
      peso: weight,
      v: window.key,
      dir: direction,
      quien: actor,
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
            <h1 className="page-title">Flujo y uso · {instance.alias}</h1>
            <p className="page-sub">
              Por dónde entra el tráfico y dónde cae. El diagrama cruza el rol que ejecuta con la tabla que toca;
              la rejilla muestra a qué horas de la semana se usa el servidor. La atribución del diagrama es{' '}
              <strong>aproximada</strong>: sale de leer el texto de cada consulta
              {engine === 'postgres'
                ? ', y los contadores de PostgreSQL están debajo para contrastarla.'
                : ', y en este motor no hay contadores por tabla con los que contrastarla.'}
            </p>
          </div>
          <AutoRefresh intervalMs={30000} />
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label={direction === 'escritura' ? 'Filas escritas' : 'Filas leídas'}
            value={formato(escriturasAtribuidas)}
            hint={`atribuidas, ventana ${window.label}`}
            tone="accent"
          />
          <StatCard
            label="Tablas con tráfico"
            value={formatNumber(flow.tables.length)}
            hint={direction === 'escritura' ? 'destino de algún DML' : 'leídas por alguna consulta'}
          />
          <StatCard
            label="Consultas atribuidas"
            value={`${formatNumber(flow.attributed)} / ${formatNumber(flow.statements)}`}
            hint={`${formatPct(cobertura, 0)} del peso total`}
            tone={cobertura >= 60 ? 'ok' : cobertura >= 25 ? 'warn' : 'neutral'}
          />
          {engine === 'postgres' ? (
            <StatCard
              label="Según los contadores"
              value={formatNumber(Math.round(escriturasContadas))}
              hint="filas de DML medidas por PostgreSQL"
            />
          ) : (
            <StatCard
              label="Rol de quien ejecuta"
              value={engine === 'mariadb' ? 'no informado' : 'por sesión'}
              hint={
                engine === 'mariadb'
                  ? 'performance_schema no guarda el usuario en los digests'
                  : 'SQL Server agrega por plan, sin el rol'
              }
            />
          )}
        </div>

        {/* ------------------------------------------------------------ flujo */}
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              {direction === 'escritura' ? 'Quién escribe en qué' : 'Quién lee de dónde'}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {(['rol', 'aplicacion'] as const).map((opcion) => (
                <Link
                  key={opcion}
                  href={enlace({ quien: opcion })}
                  className={`tag ${opcion === actor ? 'tag--info' : 'tag--muted'}`}
                  title={
                    opcion === 'rol'
                      ? 'exacto: pg_stat_statements guarda el rol'
                      : 'estimado por muestreo de pg_stat_activity'
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
                      'Los contadores ven escrituras pero ninguna consulta quedó registrada en pg_stat_statements. Suele ser tráfico excluido a propósito: Búho marca sus propias consultas para no contarse a sí mismo.'
                    : 'Sin consultas de la aplicación en la ventana. Las del propio Búho no cuentan, así que una instancia que sólo recibe monitoreo aparece vacía aquí; sin pg_stat_statements, también.'
                  : direction === 'escritura' && weight === 'rows' && engine === 'mssql'
                    ? // En SQL Server el DML no aporta filas a dm_exec_query_stats,
                      // así que pesar por filas deja el diagrama vacío aunque haya
                      // tráfico. Vale más decirlo que dejar la pantalla en blanco.
                      'SQL Server no cuenta las filas modificadas por consulta, así que pesar las escrituras por filas da cero. Probar con "tiempo" o "llamadas".'
                    : direction === 'escritura'
                      ? 'Ninguna escritura pudo atribuirse a una tabla en esta ventana. Si la base sólo se lee, probar con "lectura".'
                      : 'Ninguna lectura pudo atribuirse a una tabla en esta ventana.'
              }
            />
            {actor === 'aplicacion' && (
              <p className="mt-2 text-[11px] text-foreground-muted">
                La columna de la izquierda es una <strong>estimación</strong>: el nombre de aplicación no está en las
                estadísticas acumuladas, así que sale de mirar cada cinco segundos quién está ejecutando qué y repartir
                después el peso en esa proporción. Una consulta más corta que el intervalo puede no verse nunca, y por
                eso las que no se observaron aparecen juntas como «no observado»
                {flow.weightAttributed > 0
                  ? `, que hoy es ${formatPct(100 - (flow.weightWithActor / flow.weightAttributed) * 100, 0)} del peso atribuido.`
                  : '.'}{' '}
                El rol, en cambio, es exacto.
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
              <span className="panel-title">Qué clase de tráfico recibe cada tabla</span>
            </div>
            <div className="panel-body">
              {flow.tables.length === 0 ? (
                <div className="empty">Sin tablas atribuidas en la ventana.</div>
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
                  ? 'Lo que dicen los contadores de PostgreSQL'
                  : 'Contraste con los contadores del motor'}
              </span>
              <span className="font-mono text-[10px] text-foreground-muted">ventana {window.label}</span>
            </div>
            <div className="panel-body">
              {engine !== 'postgres' ? (
                <div className="empty">
                  {engine === 'mariadb' ? 'MariaDB' : 'SQL Server'} no expone contadores de filas por tabla como
                  los de <span className="font-mono">pg_stat_user_tables</span>, así que aquí no hay con qué
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
                        <th className="text-right">Por índice</th>
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
                                // reescribiendo índices: es la señal más directa
                                // de que sobran índices en una tabla caliente.
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
                  proporción de actualizaciones que no tocaron ningún índice.
                </p>
              )}
            </div>
          </section>
        </div>

        {/* ----------------------------------------------------------- calor */}
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Cuándo se usa · {heatOption.label}</span>
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
                      ? 'cómo es una hora típica'
                      : 'qué tan mal se puso alguna vez a esa hora'
                  }
                >
                  {opcion === 'avg' ? 'típico' : 'peor caso'}
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
                Sin rollups horarios todavía para {heatOption.label.toLowerCase()}. El primero aparece a la hora de
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
                          con {formatoCalor(tranquila.value)}: ahí va la ventana de mantenimiento
                        </>
                      )}
                      .
                    </>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-foreground-muted">
                  {heat.daysCovered < 14
                    ? `Sólo hay ${Math.round(heat.daysCovered)} día${Math.round(heat.daysCovered) === 1 ? '' : 's'} de historia: la rejilla todavía no distingue un martes de un jueves. Con dos semanas empieza a significar algo, y ${heat.emptyCells} celda${heat.emptyCells === 1 ? '' : 's'} siguen sin dato.`
                    : `${Math.round(heat.daysCovered)} días de historia. Las celdas rayadas no tienen dato y las pálidas se midieron una sola vez.`}{' '}
                  El color es relativo a esta rejilla, así que no compara entre instancias. La hora es la del
                  operador, no la del store.
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
