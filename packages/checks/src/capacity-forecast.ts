import { formatBytes, formatPct } from '@buho/core';
import type { CheckResult, Severity } from './types';

const CHECK = {
  checkId: 'capacity_growth',
  title: 'Capacity growth projection',
} as const;

/** One metric sample; `bucket` is epoch milliseconds (same convention as capacity UI). */
export interface MetricTimeSample {
  bucket: number;
  value: number;
}

export interface CapacityGrowthOptions {
  /** Minimum points before projecting (default 3). */
  minSamples?: number;
  /** Only alert if breach is within this many days (default 90). */
  horizonDays?: number;
  /** Threshold for connections_used_pct (default warning 75, critical 90). */
  connectionsWarningPct?: number;
  connectionsCriticalPct?: number;
  /** Optional byte cap for database_size_bytes (e.g. volume size). */
  databaseSizeThresholdBytes?: number;
}

interface LinearFit {
  slopePerMs: number;
  intercept: number;
}

function fitLinear(points: MetricTimeSample[]): LinearFit | null {
  if (points.length < 2) return null;
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
  if (!Number.isFinite(slopePerMs)) return null;
  return { slopePerMs, intercept };
}

function daysUntilThreshold(
  points: MetricTimeSample[],
  threshold: number,
  horizonDays: number,
): { days: number | null; current: number; slopePerDay: number } | null {
  const sorted = [...points].sort((a, b) => a.bucket - b.bucket);
  const fit = fitLinear(sorted);
  if (!fit) return null;

  const current = sorted[sorted.length - 1]!.value;
  const slopePerDay = fit.slopePerMs * 86_400_000;
  const lastBucket = sorted[sorted.length - 1]!.bucket;

  if (slopePerDay <= 0) return { days: null, current, slopePerDay };

  if (current >= threshold) {
    return { days: 0, current, slopePerDay };
  }

  const targetBucket = (threshold - fit.intercept) / fit.slopePerMs;
  if (!Number.isFinite(targetBucket) || targetBucket <= lastBucket) {
    return { days: null, current, slopePerDay };
  }

  const ms = targetBucket - lastBucket;
  const days = ms / 86_400_000;
  if (days > horizonDays) return { days: null, current, slopePerDay };
  return { days, current, slopePerDay };
}

function breachSeverity(days: number | null, warningDays: number, criticalDays: number): Severity | null {
  if (days === null) return null;
  if (days === 0) return 'critical';
  if (days <= criticalDays) return 'critical';
  if (days <= warningDays) return 'warning';
  return 'info';
}

/**
 * Linear growth projection on recent metric samples. Supports `connections_used_pct`
 * and `database_size_bytes` (requires `databaseSizeThresholdBytes`).
 *
 * @example
 * ```ts
 * import { evaluateCapacityGrowth, type MetricTimeSample } from '@buho/checks';
 *
 * const series: MetricTimeSample[] = history.map((h) => ({
 *   bucket: h.bucket.getTime(),
 *   value: h.connections_used_pct,
 * }));
 *
 * const findings = evaluateCapacityGrowth({
 *   connections_used_pct: series,
 * }, { databaseSizeThresholdBytes: diskBytes });
 * ```
 */
export function evaluateCapacityGrowth(
  samplesByMetric: Record<string, MetricTimeSample[]>,
  options: CapacityGrowthOptions = {},
): CheckResult[] {
  const minSamples = options.minSamples ?? 3;
  const horizonDays = options.horizonDays ?? 90;
  const connWarn = options.connectionsWarningPct ?? 75;
  const connCrit = options.connectionsCriticalPct ?? 90;
  const warningDays = Math.min(56, horizonDays);
  const criticalDays = Math.min(14, horizonDays);

  const results: CheckResult[] = [];

  const connSeries = samplesByMetric['connections_used_pct'];
  if (connSeries && connSeries.length >= minSamples) {
    const projCrit = daysUntilThreshold(connSeries, connCrit, horizonDays);
    const projWarn =
      projCrit?.current !== undefined && projCrit.current >= connCrit
        ? null
        : daysUntilThreshold(connSeries, connWarn, horizonDays);
    const pick =
      projCrit && breachSeverity(projCrit.days, warningDays, criticalDays)
        ? { threshold: connCrit, proj: projCrit }
        : projWarn && breachSeverity(projWarn.days, warningDays, criticalDays)
          ? { threshold: connWarn, proj: projWarn }
          : null;

    if (pick) {
      const severity = breachSeverity(pick.proj.days, warningDays, criticalDays)!;
      results.push({
        ...CHECK,
        severity,
        object: 'connections_used_pct',
        message:
          pick.proj.days === 0
            ? `Connection usage is ${formatPct(pick.proj.current)} (at or above ${pick.threshold}% limit).`
            : `Connection usage ${formatPct(pick.proj.current)} growing ~${pick.proj.slopePerDay.toFixed(2)} pts/day; ` +
              `projects ${formatPct(pick.threshold)} in ~${Math.ceil(pick.proj.days!)} day(s).`,
        remediation:
          'Add pooling (PgBouncer, ProxySQL, driver pool) and fix connection leaks before raising max_connections.',
        value: pick.proj.days ?? pick.proj.current,
      });
    }
  }

  const sizeSeries = samplesByMetric['database_size_bytes'];
  const sizeCap = options.databaseSizeThresholdBytes;
  if (sizeSeries && sizeSeries.length >= minSamples && sizeCap != null && sizeCap > 0) {
    const proj = daysUntilThreshold(sizeSeries, sizeCap, horizonDays);
    if (proj) {
      const severity = breachSeverity(proj.days, warningDays, criticalDays);
      if (severity) {
        results.push({
          ...CHECK,
          severity,
          object: 'database_size_bytes',
          message:
            proj.days === 0
              ? `Database size ${formatBytes(proj.current)} is at or above the ${formatBytes(sizeCap)} budget.`
              : `Database size ${formatBytes(proj.current)} growing ~${formatBytes(proj.slopePerDay)}/day; ` +
                `projects ${formatBytes(sizeCap)} in ~${Math.ceil(proj.days!)} day(s).`,
          remediation:
            'Plan disk expansion, purge/archive cold data, or shrink logs before the volume fills. Linear projection assumes steady growth.',
          value: proj.days ?? proj.current,
        });
      }
    }
  }

  return results;
}
