/**
 * Peak (max) of a metric over a timeseries window.
 * Used for "peak in window" KPI cards that Superset-style monitors show
 * next to the current value.
 */

export function peakOf(
  points: Array<Record<string, number | null>>,
  metric: string,
): number | null {
  let peak: number | null = null;
  for (const point of points) {
    const value = point[metric];
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    peak = peak === null ? value : Math.max(peak, value);
  }
  return peak;
}

/** Peak of a derived series (e.g. sum of insert+update+delete). */
export function peakOfDerived(
  points: Array<Record<string, number | null>>,
  derive: (point: Record<string, number | null>) => number | null,
): number | null {
  let peak: number | null = null;
  for (const point of points) {
    const value = derive(point);
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    peak = peak === null ? value : Math.max(peak, value);
  }
  return peak;
}
