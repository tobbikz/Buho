import type { Sample as SensorSample } from './types.js';

/** Buho metric_samples row shape (avoids depending on @buho/core). */
export type BuhoMetricSample = {
  metric: string;
  value: number;
  labels?: Record<string, string>;
};

/**
 * Flatten sensor Sample.metrics → Buho metric_samples rows.
 * Always emits `sensor_ok` + `sensor_duration_ms` plus numeric metric keys.
 */
export function sensorSampleToBuho(sample: SensorSample): BuhoMetricSample[] {
  const labels = {
    sensor_id: sample.sensorId,
    sensor_type: sample.sensorType,
  };
  const out: BuhoMetricSample[] = [
    { metric: 'sensor_ok', value: sample.ok ? 1 : 0, labels },
    { metric: 'sensor_duration_ms', value: sample.durationMs, labels },
  ];
  for (const [key, raw] of Object.entries(sample.metrics ?? {})) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out.push({ metric: `sensor_${key}`, value: raw, labels });
    } else if (typeof raw === 'boolean') {
      out.push({ metric: `sensor_${key}`, value: raw ? 1 : 0, labels });
    }
  }
  if (sample.sensorType === 'host') {
    const idle = sample.metrics['cpuIdlePct'];
    if (typeof idle === 'number' && Number.isFinite(idle)) {
      out.push({ metric: 'host_cpu_pct', value: Math.min(100, Math.max(0, 100 - idle)), labels });
    }
    const mem = sample.metrics['memUsedPct'];
    if (typeof mem === 'number' && Number.isFinite(mem)) {
      out.push({ metric: 'host_mem_used_pct', value: mem, labels });
    }
    const disk = sample.metrics['diskUsedPct'];
    if (typeof disk === 'number' && Number.isFinite(disk)) {
      out.push({ metric: 'host_disk_used_pct', value: disk, labels });
    }
  }
  return out;
}

export function sensorSamplesToBuho(samples: SensorSample[]): BuhoMetricSample[] {
  return samples.flatMap(sensorSampleToBuho);
}
