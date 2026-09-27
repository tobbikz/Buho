import { query } from './db';
import { formatBytes, formatNumber, formatPct } from './format';

/**
 * Presupuesto de capacidad.
 *
 * Pregunta: "con este crecimiento, ¿cuándo se acaba el disco / el XID / la
 * holgura de CPU o RAM?". La respuesta es una proyección lineal sobre el
 * rollup horario: barata, auditable y suficiente para planificar compras o
 * freeze antes de que duela.
 *
 * No es un modelo de colas ni ARIMA. Si el crecimiento no es estable (purga
 * semanal, carga batch), la fecha se mueve — la UI lo dice.
 */

export type CapacityResource = 'disco' | 'xid' | 'cpu' | 'ram';

/** Minimum distinct daily buckets before showing a growth projection. */
export const MIN_FORECAST_DAYS = 30;

export interface CapacityPoint {
  bucket: number;
  value: number;
}

export interface CapacityForecast {
  resource: CapacityResource;
  label: string;
  unit: 'bytes' | 'pct';
  /** Valor actual (último bucket con dato). */
  current: number | null;
  /** Umbral a partir del cual se considera "agotado". */
  threshold: number;
  /** Growth por día (misma unidad que current). */
  dailyRate: number | null;
  /** Días hasta cruzar el umbral; null si no crece o ya lo cruzó. */
  daysToExhaust: number | null;
  /** Fecha estimada, o null. */
  exhaustAt: Date | null;
  /** R² de la recta: qué tan estable es el crecimiento. */
  rSquared: number | null;
  /** Serie diaria usada (para el gráfico). */
  history: CapacityPoint[];
  /** Last real point plus the fitted line forward, so the chart shows the growth. */
  projection: CapacityPoint[];
  /** One-line English summary for the panel. */
  summary: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
}

interface LinearFit {
  slopePerMs: number;
  intercept: number;
  rSquared: number;
}

function forecastLine(history: CapacityPoint[], fit: LinearFit | null): CapacityPoint[] {
  if (!fit || history.length === 0) return [];
  const last = history[history.length - 1]!;
  const dayMs = 86_400_000;
  const horizonDays = 28;
  const steps = 12;
  const points: CapacityPoint[] = [{ bucket: last.bucket, value: last.value }];
  for (let step = 1; step <= steps; step += 1) {
    const bucket = last.bucket + (horizonDays * dayMs * step) / steps;
    const value = fit.intercept + fit.slopePerMs * bucket;
    if (!Number.isFinite(value)) continue;
    points.push({ bucket, value: Math.max(0, value) });
  }
  return points;
}

function fitLinear(points: CapacityPoint[]): LinearFit | null {
  if (points.length < 3) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const point of points) {
    sumX += point.bucket;
    sumY += point.value;
    sumXX += point.bucket * point.bucket;
    sumXY += point.bucket * point.value;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;
  const slopePerMs = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slopePerMs * sumX) / n;

  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const point of points) {
    const predicted = intercept + slopePerMs * point.bucket;
    ssTot += (point.value - meanY) ** 2;
    ssRes += (point.value - predicted) ** 2;
  }
  const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slopePerMs, intercept, rSquared };
}

export async function dailySeries(
  instanceId: number,
  metric: string,
  days: number,
  agg: 'avg' | 'max' = 'avg',
): Promise<CapacityPoint[]> {
  const rows = await query<Record<string, unknown>>(
    `select date_trunc('day', bucket) as day,
            ${agg}(avg_value) as value
       from buho.metric_rollup_1h
      where instance_id = $1
        and metric = $2
        and bucket > now() - make_interval(days => $3::int)
      group by 1
      order by 1`,
    [instanceId, metric, days],
  );
  return rows
    .map((row) => ({
      bucket: (row['day'] as Date).getTime(),
      value: Number(row['value']),
    }))
    .filter((point) => Number.isFinite(point.value));
}

export function project(
  resource: CapacityResource,
  label: string,
  unit: 'bytes' | 'pct',
  history: CapacityPoint[],
  threshold: number,
  formatCurrent: (v: number) => string,
): CapacityForecast {
  if (history.length === 0) {
    return {
      resource,
      label,
      unit,
      current: null,
      threshold,
      dailyRate: null,
      daysToExhaust: null,
      exhaustAt: null,
      rSquared: null,
      history,
      projection: [],
      summary: `No history yet to project ${label.toLowerCase()}.`,
      tone: 'neutral',
    };
  }

  const current = history[history.length - 1]!.value;
  const fit = fitLinear(history);
  const dayMs = 86_400_000;
  const dailyRate = fit ? fit.slopePerMs * dayMs : null;

  let daysToExhaust: number | null = null;
  let exhaustAt: Date | null = null;

  if (current >= threshold) {
    daysToExhaust = 0;
    exhaustAt = new Date();
  } else if (dailyRate !== null && dailyRate > 0) {
    const remaining = threshold - current;
    daysToExhaust = remaining / dailyRate;
    exhaustAt = new Date(Date.now() + daysToExhaust * dayMs);
  }

  const tone: CapacityForecast['tone'] =
    daysToExhaust === null
      ? dailyRate !== null && dailyRate < 0
        ? 'ok'
        : 'neutral'
      : daysToExhaust <= 14
        ? 'error'
        : daysToExhaust <= 56
          ? 'warn'
          : 'ok';

  let summary: string;
  if (daysToExhaust === 0) {
    summary = `${label} is already at or above the threshold (${formatCurrent(threshold)}).`;
  } else if (daysToExhaust === null) {
    if (dailyRate !== null && dailyRate < -1e-9) {
      summary =
        `${label} is falling ~${formatCurrent(Math.abs(dailyRate))}/day: at this trend it will not exhaust.`;
    } else {
      summary =
        `${label} is at ${formatCurrent(current)} with no clear growth ` +
        `(R²=${fit ? fit.rSquared.toFixed(2) : '—'}).`;
    }
  } else {
    const semanas = daysToExhaust / 7;
    const cuando =
      daysToExhaust < 2
        ? 'in under two days'
        : daysToExhaust < 14
          ? `in ~${Math.round(daysToExhaust)} days`
          : `in ~${semanas.toFixed(1)} weeks`;
    summary =
      `At the current growth (~${formatCurrent(dailyRate!)}/day), ${label.toLowerCase()} ` +
      `reaches ${formatCurrent(threshold)} ${cuando}` +
      (exhaustAt ? ` (${exhaustAt.toLocaleDateString('en')})` : '') +
      `.`;
  }

  return {
    resource,
    label,
    unit,
    current,
    threshold,
    dailyRate,
    daysToExhaust,
    exhaustAt,
    rSquared: fit?.rSquared ?? null,
    history,
    projection: forecastLine(history, fit),
    summary,
    tone,
  };
}

/**
 * Lee disco, XID, CPU y RAM y proyecta cuándo se cruzan los umbrales.
 *
 * Umbrales por defecto:
 * - disco: el tamaño actual × 1.5 no sirve como "lleno"; se usa el max
 *   observado × 1.2 si no hay techo configurado — mejor: proyectamos crecimiento
 *   absoluto y el umbral es un techo opcional. Sin techo, reportamos tasa y
 *   "sin techo conocido".
 * - xid: 80 % de autovacuum_freeze_max_age (ya viene como xid_age_pct)
 * - cpu / ram: 85 % sostenido (promedio diario)
 */
export async function getCapacityBudget(
  instanceId: number,
  days = 28,
  opts?: {
    diskCeilingBytes?: number | null;
    xidPctThreshold?: number;
    cpuPctThreshold?: number;
    ramPctThreshold?: number;
  },
): Promise<CapacityForecast[]> {
  const xidThreshold = opts?.xidPctThreshold ?? 80;
  const cpuThreshold = opts?.cpuPctThreshold ?? 85;
  const ramThreshold = opts?.ramPctThreshold ?? 85;

  const [disk, xid, cpu, ram] = await Promise.all([
    dailySeries(instanceId, 'database_size_bytes', days, 'avg'),
    dailySeries(instanceId, 'xid_age_pct', days, 'max'),
    dailySeries(instanceId, 'host_cpu_pct', days, 'avg'),
    dailySeries(instanceId, 'host_mem_used_pct', days, 'avg'),
  ]);

  // Sin techo de disco configurado: proyectamos al doble del tamaño actual
  // (señal de "se dobló") — útil para comprar almacenamiento con margen.
  const diskCurrent = disk[disk.length - 1]?.value ?? 0;
  const diskCeiling =
    opts?.diskCeilingBytes && opts.diskCeilingBytes > 0
      ? opts.diskCeilingBytes
      : diskCurrent > 0
        ? diskCurrent * 2
        : 0;

  return [
    project(
      'disco',
      opts?.diskCeilingBytes ? 'Disk (configured ceiling)' : 'Disk (up to ×2 current size)',
      'bytes',
      disk,
      diskCeiling,
      (v) => formatBytes(v),
    ),
    project('xid', 'XID age', 'pct', xid, xidThreshold, (v) => formatPct(v, 1)),
    project('cpu', 'Host CPU', 'pct', cpu, cpuThreshold, (v) => formatPct(v, 1)),
    project('ram', 'Host RAM', 'pct', ram, ramThreshold, (v) => formatPct(v, 1)),
  ];
}

export function historyDayCount(history: CapacityPoint[]): number {
  return history.length;
}

export function canForecast(history: CapacityPoint[]): boolean {
  return historyDayCount(history) >= MIN_FORECAST_DAYS;
}

export function formatDays(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return 'now';
  if (days < 2) return `${(days * 24).toFixed(0)} h`;
  if (days < 14) return `${Math.round(days)} d`;
  return `${(days / 7).toFixed(1)} wk`;
}

export { formatNumber };
