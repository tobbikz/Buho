import type { Sample } from './types';

interface CounterState {
  value: number;
  at: number;
  statsReset: string | null;
}

export interface RateResult {
  rates: Sample[];
  /** Contadores descartados por reset de estadísticas o por regresión del valor. */
  discarded: number;
}

function labelKey(sample: Sample): string {
  if (!sample.labels) return sample.metric;
  const parts = Object.keys(sample.labels)
    .sort()
    .map((key) => `${key}=${sample.labels?.[key]}`);
  return `${sample.metric}{${parts.join(',')}}`;
}

/**
 * Convierte contadores acumulados en tasas por segundo.
 *
 * Dos trampas que hay que respetar, verificadas contra PG 18.4:
 *  - `stats_reset` es por fila, no global: en la misma instancia venía nulo en
 *    pg_stat_database pero igual a la hora de arranque en pg_stat_wal.
 *  - tras un reset o reinicio el contador baja; sin este guardia el monitor
 *    reporta picos que nunca ocurrieron.
 */
export class DeltaEngine {
  private readonly state = new Map<string, CounterState>();

  rates(scope: string, samples: Sample[], now = Date.now()): RateResult {
    const rates: Sample[] = [];
    let discarded = 0;

    for (const sample of samples) {
      if (!sample.counter) continue;

      const key = `${scope}|${labelKey(sample)}`;
      const statsReset = sample.statsReset ?? null;
      const previous = this.state.get(key);
      this.state.set(key, { value: sample.value, at: now, statsReset });

      if (!previous) continue;
      if (previous.statsReset !== statsReset) {
        discarded += 1;
        continue;
      }
      if (sample.value < previous.value) {
        discarded += 1;
        continue;
      }

      const elapsedSeconds = (now - previous.at) / 1000;
      if (elapsedSeconds <= 0) continue;

      rates.push({
        metric: `${sample.metric}_per_sec`,
        value: (sample.value - previous.value) / elapsedSeconds,
        labels: sample.labels,
      });
    }

    return { rates, discarded };
  }

  reset(scope?: string): void {
    if (!scope) {
      this.state.clear();
      return;
    }
    for (const key of this.state.keys()) {
      if (key.startsWith(`${scope}|`)) this.state.delete(key);
    }
  }
}
