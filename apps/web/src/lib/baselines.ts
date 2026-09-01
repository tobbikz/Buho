import { query } from './db';
import type { ChartPoint } from './queries';

/**
 * Líneas base: qué es normal para esta métrica a esta hora.
 *
 * La pregunta que contestan es la que un umbral fijo no puede: 400 connections un
 * martes a las 3 de la tarde puede ser rutina, y las mismas 400 un domingo a las
 * 4 de la mañana un proceso que se soltó. La referencia es el propio pasado del
 * servidor a la misma hora.
 *
 * Con pocas observaciones por celda una banda es ruido disfrazado de estadística,
 * así que hay un min y, cuando no se alcanza, se dice que no hay línea base en
 * lugar de dibujar una.
 */

/** Observaciones mínimas por celda para que la banda signifique algo. */
export const MIN_SAMPLES = 5;

export type BaselineScope = 'hora_semana' | 'hora_dia';

export interface BaselineCell {
  dow: number;
  hour: number;
  samples: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

export interface Baseline {
  metric: string;
  scope: BaselineScope;
  cells: Map<string, BaselineCell>;
  /** Observaciones típicas por celda: es lo que da o quita confianza. */
  medianSamples: number;
  computedAt: Date;
}

function key(dow: number, hour: number): string {
  return `${dow}:${hour}`;
}

/**
 * Devuelve la línea base más fina que tenga datos suficientes.
 *
 * `hora_semana` distingue el martes del domingo y es la buena, pero necesita
 * semanas de historia. `hora_dia` sirve con días. Elegir la primera que califica
 * es lo que hace que la función sea útil desde el segundo día de instalación en
 * vez de quedarse muda un mes.
 */
export async function getBaseline(
  instanceId: number,
  metric: string,
): Promise<Baseline | null> {
  const rows = await query<{
    scope: BaselineScope;
    dow: number;
    hour: number;
    samples: number;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    computed_at: Date;
  }>(
    `select scope, dow, hour, samples, p10, p50, p90, computed_at
       from buho.metric_baselines
      where instance_id = $1 and metric = $2`,
    [instanceId, metric],
  );

  if (rows.length === 0) return null;

  for (const scope of ['hora_semana', 'hora_dia'] as BaselineScope[]) {
    const scoped = rows.filter((row) => row.scope === scope);
    if (scoped.length === 0) continue;

    const counts = scoped.map((row) => Number(row.samples)).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)] ?? 0;
    if (median < MIN_SAMPLES) continue;

    const cells = new Map<string, BaselineCell>();
    for (const row of scoped) {
      cells.set(key(Number(row.dow), Number(row.hour)), {
        dow: Number(row.dow),
        hour: Number(row.hour),
        samples: Number(row.samples),
        p10: row.p10 === null ? null : Number(row.p10),
        p50: row.p50 === null ? null : Number(row.p50),
        p90: row.p90 === null ? null : Number(row.p90),
      });
    }

    return {
      metric,
      scope,
      cells,
      medianSamples: median,
      computedAt: scoped[0]!.computed_at,
    };
  }

  return null;
}

/** Cuántas observaciones hay, para explicar por qué todavía no hay banda. */
export async function getBaselineCoverage(
  instanceId: number,
): Promise<{ metrics: number; medianSamples: number; computedAt: Date | null } | null> {
  const rows = await query<{ metrics: string; median_samples: string; computed_at: Date | null }>(
    `select count(distinct metric)                                        as metrics,
            percentile_cont(0.5) within group (order by samples)          as median_samples,
            max(computed_at)                                              as computed_at
       from buho.metric_baselines
      where instance_id = $1 and scope = 'hora_dia'`,
    [instanceId],
  );

  const row = rows[0];
  if (!row || Number(row.metrics) === 0) return null;
  return {
    metrics: Number(row.metrics),
    medianSamples: Number(row.median_samples ?? 0),
    computedAt: row.computed_at,
  };
}

/**
 * Pega la banda a los puntos de la serie.
 *
 * Recharts dibuja un área entre dos valores si el dato es un par, así que la
 * banda viaja como `[p10, p90]` bajo una clave propia. El punto medio va
 * aparte para poder mostrar la mediana como línea de referencia.
 */
export function withBand(
  points: ChartPoint[],
  baseline: Baseline,
  bandKey = 'banda',
  medianKey = 'mediana',
): ChartPoint[] {
  return points.map((point) => {
    const at = new Date(point.bucket);
    const cell =
      baseline.scope === 'hora_semana'
        ? baseline.cells.get(key(at.getDay(), at.getHours()))
        : baseline.cells.get(key(-1, at.getHours()));

    if (!cell || cell.p10 === null || cell.p90 === null) {
      return { ...point, [bandKey]: null, [medianKey]: null };
    }
    return {
      ...point,
      [bandKey]: [cell.p10, cell.p90] as [number, number],
      [medianKey]: cell.p50,
    };
  });
}

export interface Anomaly {
  metric: string;
  value: number;
  p10: number;
  p50: number;
  p90: number;
  samples: number;
  scope: BaselineScope;
  direction: 'arriba' | 'abajo';
  /** Cuántas veces el ancho de la banda se pasó. Ordena por gravedad. */
  excess: number;
}

/**
 * Métricas fuera de su banda ahora mismo.
 *
 * Se comparan los últimos veinte minutos contra la celda que corresponde al
 * momento actual. Sólo se reporta lo que se sale de la banda **y** por un margen
 * relativo al ancho de esa banda: una métrica que normalmente oscila mucho tiene
 * que salirse mucho para ser noticia, y una muy estable con poco.
 */
export async function getAnomalies(instanceId: number, limit = 12): Promise<Anomaly[]> {
  const rows = await query<{
    metric: string;
    value: number;
    p10: number;
    p50: number;
    p90: number;
    samples: number;
    scope: BaselineScope;
  }>(
    `with ahora as (
       select metric, avg(value) as value
         from buho.metric_samples
        where instance_id = $1
          and ts >= now() - interval '20 minutes'
          and labels = '{}'::jsonb
        group by metric
     ),
     -- Se prefiere la línea base por día de la semana cuando tiene suficientes
     -- observaciones; si no, la de sólo hora.
     elegida as (
       select distinct on (metric) metric, scope, p10, p50, p90, samples
         from buho.metric_baselines
        where instance_id = $1
          and samples >= $2
          and ((scope = 'hora_semana'
                and dow = extract(dow from now())::smallint
                and hour = extract(hour from now())::smallint)
            or (scope = 'hora_dia'
                and dow = -1
                and hour = extract(hour from now())::smallint))
        order by metric, case scope when 'hora_semana' then 0 else 1 end
     )
     select a.metric, a.value, e.p10, e.p50, e.p90, e.samples, e.scope
       from ahora a
       join elegida e using (metric)
      where e.p10 is not null and e.p90 is not null
        and (a.value > e.p90 or a.value < e.p10)`,
    [instanceId, MIN_SAMPLES],
  );

  const anomalies: Anomaly[] = [];

  for (const row of rows) {
    const value = Number(row.value);
    const p10 = Number(row.p10);
    const p50 = Number(row.p50);
    const p90 = Number(row.p90);

    // El ancho de la banda es la unidad natural del exceso. Cuando es cero —una
    // métrica que never se movió— se usa la mediana, y si también es cero, el
    // propio valor: cualquier cosa distinta de cero ya es un cambio.
    const width = p90 - p10 || Math.abs(p50) || Math.abs(value) || 1;
    const above = value > p90;
    const excess = above ? (value - p90) / width : (p10 - value) / width;

    // Menos de un cuarto del ancho es ruido de redondeo, no una anomalía.
    if (excess < 0.25) continue;

    anomalies.push({
      metric: row.metric,
      value,
      p10,
      p50,
      p90,
      samples: Number(row.samples),
      scope: row.scope,
      direction: above ? 'arriba' : 'abajo',
      excess,
    });
  }

  return anomalies.sort((a, b) => b.excess - a.excess).slice(0, limit);
}
