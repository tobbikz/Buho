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
 * calcula en la zona del operador: el store puede estar en UTC, pero la window
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
 * `agg` decide la pregunta: el promedio dice what a typical hour looks like, el max
 * dice how bad it ever got at that hour. Para elegir window de
 * mantenimiento sirve el max; para entender la forma de la carga, el
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
  // contadores de DML son una sola cifra de escrituras per second. El de
  // afuera agrega esas horas en la celda de la rejilla.
  const hourSql = (relation: 'buho.metric_rollup_1h' | 'buho.metric_rollup_5m') => {
    const bucket =
      relation === 'buho.metric_rollup_1h'
        ? 'bucket'
        : `date_bin('1 hour', bucket, timestamptz 'epoch')`;
    const avg =
      relation === 'buho.metric_rollup_1h'
        ? 'sum(avg_value)'
        : 'sum(avg_value * samples) / nullif(sum(samples), 0)';
    return `with por_hora as (
       select ${bucket} as bucket,
              ${avg} as avg_value,
              max(max_value) as max_value
         from ${relation}
        where instance_id = $1
          and metric = any($2)
          and bucket > now() - ($3 || ' days')::interval
        group by 1
     )
     select extract(dow  from bucket)::int as weekday,
            extract(hour from bucket)::int as hour,
            ${agg === 'max' ? 'max(max_value)' : 'avg(avg_value)'} as value,
            count(*) as samples
       from por_hora
      group by 1, 2`;
  };

  let rows = await query<{
    weekday: number;
    hour: number;
    value: number;
    samples: number;
  }>(hourSql('buho.metric_rollup_1h'), [instanceId, option.metrics, days]);

  // The hour rollup is built from 5-minute buckets. Until that hour closes, the
  // grid would stay empty even though the collector has already been writing.
  if (rows.length === 0) {
    rows = await query(hourSql('buho.metric_rollup_5m'), [instanceId, option.metrics, days]);
  }

  const cells: HeatCell[] = rows.map((fila) => ({
    weekday: Number(fila.weekday),
    hour: Number(fila.hour),
    value: Number(fila.value),
    samples: Number(fila.samples),
  }));

  const valores = cells.map((celda) => celda.value);
  const coverageSql = (relation: string) =>
    `select coalesce(extract(epoch from (max(bucket) - min(bucket))) / 86400, 0) as days
       from ${relation}
      where instance_id = $1 and metric = any($2)
        and bucket > now() - ($3 || ' days')::interval`;
  let cobertura = await query<{ days: number }>(coverageSql('buho.metric_rollup_1h'), [
    instanceId,
    option.metrics,
    days,
  ]);
  if (Number(cobertura[0]?.days ?? 0) === 0) {
    cobertura = await query(coverageSql('buho.metric_rollup_5m'), [instanceId, option.metrics, days]);
  }

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
 * un min de muestras: la celda más fría puede ser simplemente la que casi no
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
    key: 'batch',
    label: 'Query rate',
    metrics: ['queries_total_per_sec'],
    unit: 'rate',
    hint: 'Queries/sec · SQL Server Batch Requests, MariaDB QUESTIONS, Oracle user calls / equivalent',
  },
  {
    key: 'escrituras',
    label: 'Writes',
    metrics: ['db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec'],
    unit: 'rate',
    hint: 'rows inserted, updated, and deleted per second across all databases on the server',
  },
  {
    key: 'batch',
    label: 'Batch requests',
    metrics: ['queries_total_per_sec'],
    unit: 'rate',
    hint: 'SQL Server Batch Requests/sec or MariaDB QUESTIONS. PostgreSQL does not publish this counter.',
  },
  {
    key: 'connections',
    label: 'Connections',
    metrics: ['connections_total'],
    unit: 'count',
    hint: 'open sessions, active or not',
  },
  {
    key: 'cpu',
    label: 'CPU',
    metrics: ['host_cpu_pct'],
    unit: 'count',
    hint: 'host or SQL Server process CPU percent',
  },
  {
    key: 'lecturas',
    label: 'Disk reads',
    metrics: ['db_blks_read_per_sec'],
    unit: 'rate',
    hint: 'blocks that were not in cache: when this rises, the disk is working',
  },
  {
    key: 'bloqueos',
    label: 'Blocked sessions',
    metrics: ['blocked_sessions'],
    unit: 'count',
    hint: 'when contention appears — rarely at a random hour',
  },
];
