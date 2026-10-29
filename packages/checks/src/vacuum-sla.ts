import { formatBytes, formatPct } from '@buho/core';
import type { VacuumTable } from '@buho/core';
import type { CheckResult } from './types';

/** Row shape from `buho.vacuum_tables` when the collector reads from store instead of core snapshot. */
export interface VacuumTableRow {
  schema_name: string;
  table_name: string;
  live_tuples?: number | null;
  dead_tuples?: number | null;
  dead_pct?: number | null;
  remaining?: number | null;
  autovacuum_enabled?: boolean | null;
  size_bytes?: number | null;
  xid_age?: number | null;
  mxid_age?: number | null;
  freeze_max_age?: number | null;
  xid_pct?: number | null;
  mxid_pct?: number | null;
}

export type VacuumSlaInput = VacuumTable | VacuumTableRow;

const CHECK_WRAP = {
  checkId: 'vacuum_wraparound_risk',
  title: 'Vacuum wraparound risk (table)',
} as const;

const CHECK_OVERDUE = {
  checkId: 'vacuum_overdue',
  title: 'Autovacuum overdue',
} as const;

function objectName(row: VacuumSlaInput): string {
  if ('schema' in row) return `${row.schema}.${row.table}`;
  return `${row.schema_name}.${row.table_name}`;
}

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pctOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(row: VacuumSlaInput): {
  object: string;
  deadPct: number | null;
  remaining: number | null;
  autovacuumEnabled: boolean;
  sizeBytes: number;
  xidPct: number | null;
  mxidPct: number | null;
  xidAge: number;
  mxidAge: number;
  freezeMaxAge: number;
} {
  if ('schema' in row) {
    return {
      object: objectName(row),
      deadPct: row.deadPct,
      remaining: row.remaining,
      autovacuumEnabled: row.autovacuumEnabled,
      sizeBytes: row.sizeBytes,
      xidPct: row.xidPct,
      mxidPct: row.mxidPct,
      xidAge: row.xidAge,
      mxidAge: row.mxidAge,
      freezeMaxAge: row.freezeMaxAge,
    };
  }
  return {
    object: objectName(row),
    deadPct: pctOrNull(row.dead_pct),
    remaining: row.remaining === null || row.remaining === undefined ? null : num(row.remaining),
    autovacuumEnabled: row.autovacuum_enabled !== false,
    sizeBytes: num(row.size_bytes),
    xidPct: pctOrNull(row.xid_pct),
    mxidPct: pctOrNull(row.mxid_pct),
    xidAge: num(row.xid_age),
    mxidAge: num(row.mxid_age),
    freezeMaxAge: num(row.freeze_max_age),
  };
}

function wrapSeverity(peor: number): 'critical' | 'warning' | 'info' | null {
  if (peor >= 90) return 'critical';
  if (peor >= 75) return 'warning';
  if (peor >= 50) return 'info';
  return null;
}

/**
 * Wraparound / multixact pressure from a vacuum snapshot or persisted `vacuum_tables` rows.
 *
 * @example
 * ```ts
 * import { sampleVacuum } from '@buho/core';
 * import { evaluateVacuumSla } from '@buho/checks';
 *
 * const snapshot = await sampleVacuum(pool, caps);
 * const findings = evaluateVacuumSla(snapshot.tables);
 * ```
 */
export function evaluateVacuumSla(tables: VacuumSlaInput[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const raw of tables) {
    const row = normalize(raw);
    const xidPct = row.xidPct ?? 0;
    const mxidPct = row.mxidPct ?? 0;
    const peor = Math.max(xidPct, mxidPct);
    const severity = wrapSeverity(peor);
    if (!severity) continue;

    const mxidWorse = mxidPct >= xidPct && mxidPct > 0;
    const cual = mxidWorse ? 'multixact' : 'transaction';
    const edad = mxidWorse ? row.mxidAge : row.xidAge;
    const limite = row.freezeMaxAge;

    results.push({
      ...CHECK_WRAP,
      severity,
      object: row.object,
      message:
        `${cual} freeze age is ${formatPct(peor)} of the forced-vacuum limit ` +
        `(${Math.round(edad).toLocaleString('en-US')} / ${Math.round(limite).toLocaleString('en-US')}), ` +
        `table size ${formatBytes(row.sizeBytes)}` +
        (!row.autovacuumEnabled ? ', autovacuum disabled on table' : '') +
        '.',
      remediation: !row.autovacuumEnabled
        ? 'Re-enable autovacuum on the table (ALTER TABLE ... RESET (autovacuum_enabled)) or schedule VACUUM (FREEZE) in a maintenance window before autovacuum forces it.'
        : 'Schedule VACUUM (FREEZE, VERBOSE) on this table before the forced freeze vacuum. If age keeps climbing, look for long transactions, inactive replication slots, or prepared transactions holding XIDs.',
      value: peor,
    });
  }

  return results;
}

export interface VacuumOverdueOptions {
  /** Minimum dead_pct to flag when remaining <= 0 (default 20). */
  minDeadPct?: number;
}

/**
 * Tables that passed the autovacuum threshold but still carry heavy dead tuple load.
 */
export function evaluateVacuumOverdue(
  tables: VacuumSlaInput[],
  options: VacuumOverdueOptions = {},
): CheckResult[] {
  const minDeadPct = options.minDeadPct ?? 20;
  const results: CheckResult[] = [];

  for (const raw of tables) {
    const row = normalize(raw);
    if (row.remaining === null || row.remaining > 0) continue;

    const deadPct =
      row.deadPct ??
      (() => {
        const live = 'liveTuples' in raw ? raw.liveTuples : num(raw.live_tuples);
        const dead = 'deadTuples' in raw ? raw.deadTuples : num(raw.dead_tuples);
        const total = live + dead;
        return total > 0 ? (dead / total) * 100 : null;
      })();

    if (deadPct === null || deadPct < minDeadPct) continue;

    const overdueBy = row.remaining === 0 ? 0 : Math.abs(row.remaining);
    results.push({
      ...CHECK_OVERDUE,
      severity: deadPct >= 50 ? 'warning' : 'info',
      object: row.object,
      message:
        `Autovacuum threshold exceeded${overdueBy > 0 ? ` by ${overdueBy.toLocaleString('en-US')} dead tuples` : ''}: ` +
        `${formatPct(deadPct)} dead tuples, table size ${formatBytes(row.sizeBytes)}` +
        (!row.autovacuumEnabled ? ', autovacuum disabled' : '') +
        '.',
      remediation:
        !row.autovacuumEnabled
          ? 'Autovacuum is off: run VACUUM manually or re-enable autovacuum. Overdue tables bloat and slow scans.'
          : 'Lower autovacuum_vacuum_scale_factor / raise autovacuum workers and cost limits, or VACUUM the table now. Check for autovacuum blocked by long transactions.',
      value: deadPct,
    });
  }

  return results;
}

/** Convenience: wraparound + overdue in one pass. */
export function evaluateVacuumMaintenance(
  tables: VacuumSlaInput[],
  options?: VacuumOverdueOptions,
): CheckResult[] {
  return [...evaluateVacuumSla(tables), ...evaluateVacuumOverdue(tables, options)];
}
