import { query } from './db';
import type { HeatCell } from './heat-types';

export type { HeatCell } from './heat-types';
export { WEEKDAY_LABEL } from './heat-types';

/**
 * Cuándo se usa la base: hora del día contra día de la semana.
 *
 * Una curva de 24 horas contesta "qué pasó ayer". Esta rejilla contesta otra
 * pregunta, que es la que hace falta para planificar: "cuándo se puede tocar
 * este servidor". Un lunes a las 3 de la tarde y un domingo a las 3 de la
 * mañana son el mismo punto en la hora del día y dos mundos distintos.
 *
 * Sale de `metric_rollup_1h`, que es exactamente la granularidad que la rejilla
 * necesita, así que ver un año no cuesta más que ver una semana. La hora se
 * calcula en la zona del operador: el store puede estar en UTC, pero la ventana
 * de mantenimiento la vive alguien en su horario.
 */

export interface Heatmap {
  metric: string;
  cells: HeatCell[];
  max: number;
  min: number;
  /** Días cubiertos por los datos, para poder decir cuánta historia hay. */
  daysCovered: number;
  /** Celdas sin ningún dato: los huecos se dibujan, no se rellenan con cero. */
  emptyCells: number;
}

export type HeatAgg = 'avg' | 'max';

/**
 * Una opción de la rejilla puede ser varias métricas.
 *
 * "Escrituras" no es una métrica sino tres —insertadas, actualizadas,
 * borradas— y además vienen por base de datos. Se suman primero dentro de cada
 * hora y sólo después se agrega entre horas: sumar promedios de horas distintas
 * daría un número sin unidad.
 */
export interface HeatOption {
  key: string;
  label: string;
  metrics: string[];
  unit: 'rate' | 'count';
  hint: string;
}

/**
 * Rejilla de una métrica.
 *
 * `agg` decide la pregunta: el promedio dice cómo es una hora típica, el máximo
 * dice qué tan mal se puso alguna vez a esa hora. Para elegir ventana de
 * mantenimiento sirve el máximo; para entender la forma de la carga, el
 * promedio.
 */
export async function getHeatmap(
  instanceId: number,
  option: HeatOption,
  days: number,
  agg: HeatAgg = 'avg',
): Promise<Heatmap> {
  // Dos pasos a propósito. El de adentro junta, dentro de cada hora, todas las
  // etiquetas y todas las métricas de la opción: seis bases de datos y tres
  // contadores de DML son una sola cifra de escrituras por segundo. El de
  // afuera agrega esas horas en la celda de la rejilla.
  const rows = await query<{
    weekday: number;
    hour: number;
    value: number;
    samples: number;
  }>(
    `with por_hora as (
       select bucket,
              sum(avg_value) as avg_value,
              sum(max_value) as max_value
         from buho.metric_rollup_1h
        where instance_id = $1
          and metric = any($2)
          and bucket > now() - ($3 || ' days')::interval
        group by bucket
     )
     select extract(dow  from bucket)::int as weekday,
            extract(hour from bucket)::int as hour,
            ${agg === 'max' ? 'max(max_value)' : 'avg(avg_value)'} as value,
            count(*) as samples
       from por_hora
      group by 1, 2`,
    [instanceId, option.metrics, days],
  );

  const cells: HeatCell[] = rows.map((fila) => ({
    weekday: Number(fila.weekday),
    hour: Number(fila.hour),
    value: Number(fila.value),
    samples: Number(fila.samples),
  }));

  const valores = cells.map((celda) => celda.value);
  const cobertura = await query<{ days: number }>(
    `select coalesce(extract(epoch from (max(bucket) - min(bucket))) / 86400, 0) as days
       from buho.metric_rollup_1h
      where instance_id = $1 and metric = any($2)
        and bucket > now() - ($3 || ' days')::interval`,
    [instanceId, option.metrics, days],
  );

  return {
    metric: option.key,
    cells,
    max: valores.length > 0 ? Math.max(...valores) : 0,
    min: valores.length > 0 ? Math.min(...valores) : 0,
    daysCovered: Number(cobertura[0]?.days ?? 0),
    emptyCells: 7 * 24 - cells.length,
  };
}

/**
 * La hora más tranquila de la semana.
 *
 * Es la conclusión práctica de la rejilla, y conviene calcularla y escribirla en
 * palabras en vez de dejar que cada quien la deduzca mirando colores. Se exige
 * un mínimo de muestras: la celda más fría puede ser simplemente la que casi no
 * tiene datos.
 */
export function quietestHour(
  heatmap: Heatmap,
  minSamples = 2,
): { weekday: number; hour: number; value: number } | null {
  let mejor: HeatCell | null = null;
  for (const celda of heatmap.cells) {
    if (celda.samples < minSamples) continue;
    if (!mejor || celda.value < mejor.value) mejor = celda;
  }
  return mejor ? { weekday: mejor.weekday, hour: mejor.hour, value: mejor.value } : null;
}

export function busiestHour(
  heatmap: Heatmap,
  minSamples = 2,
): { weekday: number; hour: number; value: number } | null {
  let peor: HeatCell | null = null;
  for (const celda of heatmap.cells) {
    if (celda.samples < minSamples) continue;
    if (!peor || celda.value > peor.value) peor = celda;
  }
  return peor ? { weekday: peor.weekday, hour: peor.hour, value: peor.value } : null;
}

/**
 * Opciones de la rejilla.
 *
 * Una lista corta y pensada en vez del catálogo completo: la rejilla sirve para
 * ver *carga*, y la mayoría de las cien métricas no son carga. Todas salen de
 * `metric_rollup_1h`, que guarda 400 días, así que ver un año no cuesta más que
 * ver una semana.
 */
export const HEAT_OPTIONS: HeatOption[] = [
  {
    key: 'escrituras',
    label: 'Escrituras',
    metrics: ['db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec'],
    unit: 'rate',
    hint: 'filas insertadas, actualizadas y borradas por segundo, sumando todas las bases del servidor',
  },
  {
    key: 'transacciones',
    label: 'Transacciones',
    metrics: ['db_xact_commit_per_sec'],
    unit: 'rate',
    hint: 'commits por segundo: la medida más cercana a "cuánto trabajo le está entrando"',
  },
  {
    key: 'conexiones',
    label: 'Conexiones',
    metrics: ['connections_total'],
    unit: 'count',
    hint: 'sesiones abiertas, activas o no',
  },
  {
    key: 'lecturas',
    label: 'Lecturas de disco',
    metrics: ['db_blks_read_per_sec'],
    unit: 'rate',
    hint: 'bloques que no estaban en caché: donde esto sube, el disco está trabajando',
  },
  {
    key: 'bloqueos',
    label: 'Sesiones bloqueadas',
    metrics: ['blocked_sessions'],
    unit: 'count',
    hint: 'cuándo aparece la contención, que rara vez es a cualquier hora',
  },
];
