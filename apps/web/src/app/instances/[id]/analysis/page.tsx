import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { MetricPicker } from '@/components/MetricPicker';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel, type Unit } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import {
  DEFAULT_METRICS,
  FAMILY_ORDER,
  SERIES_COLORS,
  describeMetric,
  type MetricMeta,
} from '@/lib/metrics';
import {
  getInstance,
  getSeries,
  getSeriesByLabel,
  listMetrics,
  seriesSource,
  type CrossLabel,
  type ChartPoint,
} from '@/lib/queries';
import { MIN_SAMPLES, getBaseline, withBand } from '@/lib/baselines';
import { getInstanceEngine } from '@/lib/estate';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '15m', minutes: 15, bucketSeconds: 30 },
  { key: '1h', minutes: 60, bucketSeconds: 60 },
  { key: '6h', minutes: 360, bucketSeconds: 300 },
  { key: '24h', minutes: 1440, bucketSeconds: 900 },
  { key: '7d', minutes: 10_080, bucketSeconds: 3_600 },
] as const;

const AGGREGATIONS: { key: CrossLabel; label: string; hint: string }[] = [
  { key: 'sum', label: 'suma', hint: 'total entre etiquetas: correcto para tasas y conteos' },
  { key: 'avg', label: 'promedio', hint: 'promedio entre etiquetas' },
  { key: 'min', label: 'mínimo', hint: 'peor caso para ratios (cache hit)' },
  { key: 'max', label: 'máximo', hint: 'peor caso para uso y latencias' },
];

const UNIT_TITLE: Record<Unit, string> = {
  pct: 'Porcentajes',
  bytes: 'Bytes',
  rate: 'Por segundo',
  seconds: 'Duraciones',
  count: 'Conteos',
};

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Un gráfico por unidad, no todo junto.
 *
 * Es la decisión central de esta pantalla. Un selector libre invita a marcar
 * "sesiones bloqueadas" y "bytes de WAL" a la vez, y en un solo eje la primera
 * serie se aplana contra el cero y deja de decir nada — el mismo error que ya
 * se corrigió a mano en el chart de bloqueos. Agrupar por unidad lo hace
 * imposible por construcción, sin quitarle libertad a quien elige.
 */
function groupByUnit(metrics: MetricMeta[]): Map<Unit, MetricMeta[]> {
  const groups = new Map<Unit, MetricMeta[]>();
  for (const meta of metrics) {
    const list = groups.get(meta.unit) ?? [];
    list.push(meta);
    groups.set(meta.unit, list);
  }
  return groups;
}

export default async function AnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ m?: string | string[]; w?: string; agg?: string; by?: string; base?: string }>;
}) {
  const { id } = await params;
  const { m, w, agg, by, base } = await searchParams;

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
  const resolution = seriesSource(window.minutes).label;

  let instance;
  let available;
  try {
    [instance, available] = await Promise.all([getInstance(instanceId), listMetrics(instanceId)]);
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

  const labelKeysOf = new Map(available.map((item) => [item.metric, item.labelKeys]));
  const catalog = available.map((item) => describeMetric(item.metric, item.labelKeys));

  const requested = asArray(m);
  // Se ignoran las métricas que esta instancia no tiene: un enlace copiado de
  // otra instancia no debe romper la pantalla, sólo mostrar menos.
  const selected = (requested.length > 0 ? requested : DEFAULT_METRICS).filter((metric) =>
    labelKeysOf.has(metric),
  );
  const selectedMeta = selected.map((metric) => describeMetric(metric, labelKeysOf.get(metric) ?? []));

  const aggregation = (AGGREGATIONS.find((entry) => entry.key === agg)?.key ?? null) as CrossLabel | null;

  // El desglose por etiqueta sólo tiene sentido con una métrica: con dos, cada
  // serie se multiplica por sus etiquetas y el gráfico deja de leerse.
  const single = selectedMeta.length === 1 ? selectedMeta[0] : undefined;
  const breakdownKey = single && by && single.labelKeys.includes(by) ? by : null;

  const basePath = `/instances/${instanceId}/analysis`;
  const pickerParams = {
    w: window.key,
    ...(aggregation ? { agg: aggregation } : {}),
    ...(breakdownKey ? { by: breakdownKey } : {}),
    ...(base === '1' ? { base: '1' } : {}),
  };

  function linkWith(overrides: Record<string, string | null>): string {
    const search = new URLSearchParams();
    const merged: Record<string, string | null> = { ...pickerParams, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      if (value) search.set(key, value);
    }
    for (const metric of selected) search.append('m', metric);
    return `${basePath}?${search.toString()}`;
  }

  let panels: {
    key: string;
    title: string;
    unit: Unit;
    data: ChartPoint[];
    series: { metric: string; label: string; color: string }[];
    band?: { key: string; medianKey: string; label: string };
  }[] = [];
  let failure: string | null = null;

  // La banda sólo se ofrece con una métrica sin desglose: con dos series, dos
  // bandas superpuestas no se leen, y con desglose la línea base sería la del
  // total y no la de cada etiqueta.
  const canCompare = selectedMeta.length === 1 && !breakdownKey;
  const comparing = canCompare && base === '1';
  let baselineNote: string | null = null;

  try {
    if (breakdownKey && single) {
      const result = await getSeriesByLabel(
        instanceId,
        single.metric,
        breakdownKey,
        window.minutes,
        window.bucketSeconds,
        8,
      );
      panels = [
        {
          key: 'breakdown',
          title: `${single.label} por ${breakdownKey}`,
          unit: single.unit,
          data: result.points,
          series: result.keys.map((key, index) => ({
            metric: key,
            label: key,
            color: SERIES_COLORS[index % SERIES_COLORS.length] as string,
          })),
        },
      ];
    } else {
      const groups = groupByUnit(selectedMeta);
      panels = await Promise.all(
        [...groups.entries()].map(async ([unit, metas]) => {
          const data = await getSeries(
            instanceId,
            metas.map((meta) => meta.metric),
            window.minutes,
            window.bucketSeconds,
            aggregation ?? metas[0]?.defaultAgg ?? 'sum',
          );
          return {
            key: unit,
            title: UNIT_TITLE[unit],
            unit,
            data,
            series: metas.map((meta, index) => ({
              metric: meta.metric,
              label: meta.label,
              // El color sigue la posición global de la métrica seleccionada,
              // no la del grupo: así una serie no cambia de color al agregar
              // otra de unidad distinta.
              color: SERIES_COLORS[selected.indexOf(meta.metric) % SERIES_COLORS.length] as string,
            })),
          };
        }),
      );
    }
    if (comparing && single) {
      const baseline = await getBaseline(instanceId, single.metric);
      if (!baseline) {
        baselineNote =
          `Todavía no hay línea base para ${single.label}: hacen falta al menos ${MIN_SAMPLES} ` +
          'observaciones de la misma hora, y se recalculan una vez por hora.';
      } else {
        const scopeLabel =
          baseline.scope === 'hora_semana' ? 'por día de la semana y hora' : 'por hora del día';
        baselineNote =
          `Banda del percentil 10 al 90 ${scopeLabel}, con ${baseline.medianSamples} ` +
          'observaciones típicas por celda.' +
          (baseline.scope === 'hora_dia'
            ? ' Con más semanas de historia pasa a distinguir el martes del domingo.'
            : '');
        panels = panels.map((panel) => ({
          ...panel,
          data: withBand(panel.data, baseline),
          band: { key: 'banda', medianKey: 'mediana', label: 'Normal para esta hora' },
        }));
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const cumulative = selectedMeta.filter((meta) => meta.cumulative);

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Flota', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Análisis' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Análisis · {instance.alias}</h1>
            <p className="page-sub">
              Cualquier métrica del store en un gráfico de líneas. La selección va en la URL: el enlace es el gráfico.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {WINDOWS.map((candidate) => (
              <Link
                key={candidate.key}
                href={linkWith({ w: candidate.key })}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </Link>
            ))}
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={instance.blockedSessions ?? 0} />

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-[19rem_minmax(0,1fr)]">
          <MetricPicker
            available={catalog.map((meta) => ({
              metric: meta.metric,
              label: meta.label,
              family: meta.family,
              unit: meta.unit,
            }))}
            selected={selected}
            basePath={basePath}
            params={pickerParams}
            familyOrder={FAMILY_ORDER}
          />

          <div className="flex min-w-0 flex-col gap-[0.875rem]">
            <section className="panel">
              <div className="panel-body flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="font-semibold uppercase tracking-wide text-foreground-muted">
                    Entre etiquetas
                  </span>
                  {AGGREGATIONS.map((entry) => (
                    <Link
                      key={entry.key}
                      href={linkWith({ agg: aggregation === entry.key ? null : entry.key })}
                      title={entry.hint}
                      className={`tag ${aggregation === entry.key ? 'tag--info' : 'tag--muted'}`}
                    >
                      {entry.label}
                    </Link>
                  ))}
                  {aggregation === null && (
                    <span className="text-foreground-muted">
                      automática por unidad (los porcentajes usan el peor caso)
                    </span>
                  )}
                </span>

                {single && single.labelKeys.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold uppercase tracking-wide text-foreground-muted">
                      Desglosar por
                    </span>
                    {single.labelKeys.map((key) => (
                      <Link
                        key={key}
                        href={linkWith({ by: breakdownKey === key ? null : key })}
                        className={`tag ${breakdownKey === key ? 'tag--info' : 'tag--muted'}`}
                      >
                        {key}
                      </Link>
                    ))}
                  </span>
                )}

                {canCompare && (
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold uppercase tracking-wide text-foreground-muted">
                      Línea base
                    </span>
                    <Link
                      href={linkWith({ base: comparing ? null : '1' })}
                      title="Compara la serie contra lo normal para esa hora"
                      className={`tag ${comparing ? 'tag--info' : 'tag--muted'}`}
                    >
                      comparar
                    </Link>
                  </span>
                )}

                <span className="ml-auto font-mono text-[10px] text-foreground-muted">
                  ventana {window.key} · {resolution}
                </span>
              </div>
            </section>

            {cumulative.length > 0 && (
              <section className="panel" style={{ borderLeft: '3px solid var(--warning)' }}>
                <div className="panel-body text-[12px]">
                  <strong>
                    {cumulative.map((meta) => meta.label).join(', ')}
                  </strong>{' '}
                  {cumulative.length === 1 ? 'es un contador acumulado' : 'son contadores acumulados'} desde el arranque
                  del servidor: la línea sólo sube. Para ver actividad, elegir la versión{' '}
                  <span className="font-mono">_per_sec</span>.
                </div>
              </section>
            )}

            {baselineNote && (
              <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
                <div className="panel-body text-[12px] text-foreground-secondary">{baselineNote}</div>
              </section>
            )}

            {failure ? (
              <StoreError message={failure} />
            ) : selected.length === 0 ? (
              <section className="panel">
                <div className="empty" style={{ height: 200 }}>
                  Elegí una o más métricas de la lista para graficarlas.
                </div>
              </section>
            ) : (
              panels.map((panel) => (
                <TimeseriesPanel
                  key={panel.key}
                  title={panel.title}
                  hint={
                    panels.length > 1
                      ? 'un gráfico por unidad: mezclarlas aplasta la serie más chica'
                      : `ventana ${window.key} · ${resolution}`
                  }
                  data={panel.data}
                  unit={panel.unit}
                  height={260}
                  series={panel.series}
                  band={panel.band}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
