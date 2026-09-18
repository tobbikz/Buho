import { query } from './db';

/**
 * Ajustes editables desde la consola.
 *
 * La retención vive acá y no en config.json porque cambiarla es una decisión
 * operativa —"el store está creciendo, bajemos las raw samples a 3 días"—
 * que no debería exigir editar un archivo en el servidor y reiniciar el
 * colector. El archivo sigue siendo el valor inicial; el store, si tiene una
 * fila, manda.
 *
 * Product floor: ~90 days of operable history on rollups / statements / checks.
 * Raw samples stay short — they dominate store size.
 */

export interface Retention {
  rawDays: number;
  rollup5mDays: number;
  rollup1hDays: number;
  lockEpisodeDays: number;
  statementDays: number;
  planDays: number;
  logDays: number;
  checkResultDays: number;
  collectorEventDays: number;
  healthScoreDays: number;
  unreachableAfterMinutes: number;
}

export const RETENTION_DEFAULTS: Retention = {
  rawDays: 7,
  rollup5mDays: 90,
  rollup1hDays: 400,
  lockEpisodeDays: 90,
  statementDays: 90,
  planDays: 90,
  logDays: 90,
  checkResultDays: 90,
  collectorEventDays: 90,
  healthScoreDays: 90,
  unreachableAfterMinutes: 5,
};

/** Topes de cordura: un valor de 0 borraría todo y uno enorme llena el disco. */
export const RETENTION_LIMITS: Record<
  keyof Retention,
  { min: number; max: number; label: string; hint: string }
> = {
  rawDays: {
    min: 1,
    max: 90,
    label: 'Raw samples',
    hint: '5–60 s resolution; the heaviest part of the store',
  },
  rollup5mDays: {
    min: 90,
    max: 400,
    label: '5-minute rollup',
    hint: 'product floor 90 days — hour-to-week windows',
  },
  rollup1hDays: {
    min: 90,
    max: 1_100,
    label: '1-hour rollup',
    hint: 'month-scale trends; very cheap to store',
  },
  lockEpisodeDays: {
    min: 7,
    max: 400,
    label: 'Lock episodes',
    hint: 'few rows, gold in a postmortem',
  },
  statementDays: {
    min: 14,
    max: 400,
    label: 'Per-query statistics',
    hint: 'pg_stat_statements deltas, partitioned by day',
  },
  planDays: {
    min: 7,
    max: 400,
    label: 'Execution plans',
    hint: 'history to spot plan changes for a query',
  },
  logDays: {
    min: 7,
    max: 400,
    label: 'Server log events',
    hint: 'deadlocks and errors parsed from the engine log',
  },
  checkResultDays: {
    min: 14,
    max: 400,
    label: 'Check findings',
    hint: 'historical check_results rows',
  },
  collectorEventDays: {
    min: 14,
    max: 400,
    label: 'Collector events',
    hint: 'ops log for the Búho collector itself',
  },
  healthScoreDays: {
    min: 14,
    max: 400,
    label: 'Health scores',
    hint: 'score time series for fleet trends',
  },
  unreachableAfterMinutes: {
    min: 2,
    max: 120,
    label: 'Unreachable after (minutes)',
    hint: 'no samples → resolve zombie alerts and fire instance_unreachable',
  },
};

export async function getRetention(): Promise<Retention> {
  const rows = await query("select value from buho.settings where key = 'retention'");
  const stored = rows[0]?.['value'] as Partial<Retention> | undefined;
  if (!stored) return RETENTION_DEFAULTS;
  return { ...RETENTION_DEFAULTS, ...stored };
}

export function validateRetention(input: Retention): string[] {
  const problems: string[] = [];

  for (const [field, limits] of Object.entries(RETENTION_LIMITS) as [
    keyof Retention,
    (typeof RETENTION_LIMITS)[keyof Retention],
  ][]) {
    const value = input[field];
    if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
      problems.push(`${limits.label}: must be an integer between ${limits.min} and ${limits.max}.`);
    }
  }

  // Un agregado que se borra antes que el detalle que lo alimenta deja huecos
  // permanentes en las windows largas: el gráfico de 30 días perdería los
  // últimos días justamente donde hay más datos.
  if (input.rollup5mDays < input.rawDays) {
    problems.push('The 5-minute rollup cannot be shorter than raw samples.');
  }
  if (input.rollup1hDays < input.rollup5mDays) {
    problems.push('The 1-hour rollup cannot be shorter than the 5-minute rollup.');
  }

  return problems;
}

export async function saveRetention(input: Retention, username: string): Promise<void> {
  await query(
    `insert into buho.settings (key, value, updated_at, updated_by)
          values ('retention', $1, now(), $2)
     on conflict (key) do update set value = excluded.value,
                                     updated_at = now(),
                                     updated_by = excluded.updated_by`,
    [JSON.stringify(input), username],
  );
}

export async function retentionUpdatedBy(): Promise<{ at: Date; by: string | null } | null> {
  const rows = await query("select updated_at, updated_by from buho.settings where key = 'retention'");
  const row = rows[0];
  if (!row) return null;
  return {
    at: new Date(row['updated_at'] as string),
    by: row['updated_by'] ? String(row['updated_by']) : null,
  };
}

export interface TableSize {
  name: string;
  bytes: number;
  rows: number | null;
}

/**
 * Tamaño real de lo que ocupa cada cosa.
 *
 * Va en la misma pantalla que la retención a propósito: decidir cuántos días
 * guardar sin ver lo que cuesta es adivinar.
 *
 * Cada relación se atribuye a su raíz de particionado. Consultar sólo las
 * tablas padre dejaba fuera justamente a las más grandes: `metric_samples` y
 * `statement_stats` no almacenan nada en el padre —todo está en las particiones
 * diarias— así que aparecían con cero bytes y la pantalla mostraba un store
 * mucho más pequeño de lo que era.
 */
export async function getStoreSizes(): Promise<{ tables: TableSize[]; total: number }> {
  const rows = await query(
    `select root.relname as name,
            sum(pg_total_relation_size(c.oid)) as bytes,
            -- reltuples es -1 mientras nadie haya hecho analyze; sumarlo así
            -- restaría filas reales de las otras particiones.
            nullif(sum(greatest(c.reltuples, 0)), 0)::bigint as rows
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_class root on root.oid = coalesce(pg_partition_root(c.oid), c.oid)
      where n.nspname = 'buho'
        and c.relkind in ('r', 'p')
      group by root.relname
      order by 2 desc`,
  );

  const tables = rows.map((row) => ({
    name: String(row['name']),
    bytes: Number(row['bytes'] ?? 0),
    rows: row['rows'] === null || row['rows'] === undefined ? null : Number(row['rows']),
  }));

  return { tables, total: tables.reduce((sum, table) => sum + table.bytes, 0) };
}
