import { tagged } from './tag';
import type { Pool } from 'pg';
import type { Capabilities, MetricCollector, Sample } from './types';

export interface CollectorError {
  collectorId: string;
  message: string;
}

export interface CollectionResult {
  samples: Sample[];
  errors: CollectorError[];
  latencyMs: number;
}

export async function measureLatency(pool: Pool): Promise<number> {
  const started = performance.now();
  await pool.query(tagged('select 1'));
  return performance.now() - started;
}

/**
 * Ejecuta los colectores de forma aislada: si uno falla (permisos, vista
 * ausente, timeout) los demás siguen. Una instancia enferma no puede tumbar
 * el ciclo completo.
 */
export async function runCollectors(
  pool: Pool,
  caps: Capabilities,
  collectors: MetricCollector[],
): Promise<CollectionResult> {
  const samples: Sample[] = [];
  const errors: CollectorError[] = [];
  const latencyMs = await measureLatency(pool);

  for (const collector of collectors) {
    if (collector.appliesTo && !collector.appliesTo(caps)) continue;
    try {
      const result = await pool.query(tagged(collector.sql(caps)));
      samples.push(...collector.toSamples(result.rows as Record<string, unknown>[], caps));
    } catch (error) {
      errors.push({
        collectorId: collector.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  samples.push({ metric: 'probe_latency_ms', value: latencyMs });
  return { samples, errors, latencyMs };
}
