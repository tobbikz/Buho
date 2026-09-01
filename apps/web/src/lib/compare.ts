import { query } from './db';
import { num } from './format';
import type { ChartPoint, CrossLabel, SeriesPoint } from './queries';
import { seriesSource } from './queries';

/**
 * Misma serie que `getSeries`, pero en un intervalo absoluto.
 *
 * Sirve para comparar dos momentos: se pide la window de ahora y la de hace
 * N horas, se desplaza la antigua al eje de la nueva, y el ojo ve "antes vs.
 * después" sin tener que memorizar dos pantallas.
 */
export async function getSeriesRange(
  instanceId: number,
  metrics: string[],
  from: Date,
  to: Date,
  bucketSeconds = 60,
  crossLabel: CrossLabel = 'sum',
): Promise<SeriesPoint[]> {
  const minutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
  const source = seriesSource(minutes, crossLabel);
  const rows = await query<Record<string, unknown>>(
    `with per_ts as (
       select metric, ${source.tsColumn} as ts, ${crossLabel}(${source.valueColumn}) as value
         from ${source.relation}
        where instance_id = $1
          and metric = any($2::text[])
          and ${source.tsColumn} >= $3::timestamptz
          and ${source.tsColumn} < $4::timestamptz
        group by metric, ${source.tsColumn}
     )
     select metric,
            date_bin(make_interval(secs => $5::int), ts, timestamptz 'epoch') as bucket,
            avg(value) as value
       from per_ts
      group by 1, 2
      order by 2`,
    [instanceId, metrics, from.toISOString(), to.toISOString(), bucketSeconds],
  );

  const byBucket = new Map<number, SeriesPoint>();
  for (const row of rows) {
    const bucket = (row['bucket'] as Date).getTime();
    let point = byBucket.get(bucket);
    if (!point) {
      point = { bucket };
      for (const metric of metrics) point[metric] = null;
      byBucket.set(bucket, point);
    }
    point[String(row['metric'])] = num(row['value']);
  }
  return [...byBucket.values()].sort((a, b) => a.bucket - b.bucket);
}

/**
 * Alinea una serie "de antes" sobre el eje de "ahora".
 *
 * Cada punto se mueve `offsetMs` hacia adelante. Así un pico de hace 24 h cae
 * en la misma X que el pico de ahora, y se puede decir "a esta hora, ayer
 * estaba más alto".
 */
export function shiftSeries(points: SeriesPoint[], offsetMs: number): SeriesPoint[] {
  return points.map((point) => ({ ...point, bucket: point.bucket + offsetMs }));
}

/**
 * Fusiona ahora + antes en un solo arreglo de puntos para Recharts.
 *
 * Las métricas de "antes" se renombran con el sufijo `:antes` para no pisar las
 * actuales. Los buckets se unen: donde sólo hay una serie, la otra queda null.
 */
export function mergeCompare(
  now: SeriesPoint[],
  before: SeriesPoint[],
  metrics: string[],
  offsetMs: number,
): ChartPoint[] {
  const shifted = shiftSeries(before, offsetMs);
  const byBucket = new Map<number, ChartPoint>();

  for (const point of now) {
    const entry: ChartPoint = { bucket: point.bucket };
    for (const metric of metrics) {
      entry[metric] = (point[metric] as number | null | undefined) ?? null;
      entry[`${metric}:antes`] = null;
    }
    byBucket.set(point.bucket, entry);
  }
  for (const point of shifted) {
    const entry = byBucket.get(point.bucket) ?? { bucket: point.bucket };
    for (const metric of metrics) {
      if (!(metric in entry)) entry[metric] = null;
      entry[`${metric}:antes`] = (point[metric] as number | null | undefined) ?? null;
    }
    byBucket.set(point.bucket, entry);
  }
  return [...byBucket.values()].sort((a, b) => a.bucket - b.bucket);
}

export const COMPARE_OFFSETS = [
  { key: '0', label: 'no compare', hours: 0 },
  { key: '1h', label: 'vs 1 h ago', hours: 1 },
  { key: '6h', label: 'vs 6 h ago', hours: 6 },
  { key: '24h', label: 'vs 24 h ago', hours: 24 },
  { key: '7d', label: 'vs 7 d ago', hours: 168 },
] as const;
