import type { MssqlMaintenanceSnapshot, MssqlIndexFragmentationRow } from '@buho/core';
import type { CheckResult } from './types';

const CHECK = {
  checkId: 'mssql_index_fragmentation',
  title: 'Index fragmentation high',
} as const;

export interface MssqlFragOptions {
  minFragmentationPct?: number;
  minPageCount?: number;
}

const DEFAULTS: Required<MssqlFragOptions> = {
  minFragmentationPct: 30,
  minPageCount: 1000,
};

function severity(fragmentationPct: number): 'critical' | 'warning' {
  return fragmentationPct >= 50 ? 'critical' : 'warning';
}

function finding(row: MssqlIndexFragmentationRow): CheckResult {
  const object = `${row.schema}.${row.table}.${row.indexName}`;
  const frag = row.fragmentationPct;
  return {
    ...CHECK,
    severity: severity(frag),
    object,
    message:
      `Index fragmentation ${frag.toFixed(1)}% on ${row.pageCount.toLocaleString('en-US')} pages ` +
      `(${row.schema}.${row.table}).`,
    remediation:
      frag >= 50
        ? 'Rebuild the index (ONLINE if Enterprise) during a low-write window: ALTER INDEX ... REBUILD with appropriate FILLFACTOR, or REORGANIZE if rebuild is not possible.'
        : 'REORGANIZE or schedule an index rebuild when maintenance window allows; fragmentation above 30% often adds extra I/O on range scans.',
    value: frag,
  };
}

/**
 * Fragmentation findings from {@link sampleMssqlMaintenance} snapshot shape.
 *
 * @example
 * ```ts
 * import { sampleMssqlMaintenance } from '@buho/core';
 * import { evaluateMssqlFragmentation } from '@buho/checks';
 *
 * const maintenance = await sampleMssqlMaintenance(client);
 * const findings = evaluateMssqlFragmentation(maintenance);
 * ```
 */
export function evaluateMssqlFragmentation(
  snapshot: MssqlMaintenanceSnapshot | { fragmentation: MssqlIndexFragmentationRow[] },
  options: MssqlFragOptions = {},
): CheckResult[] {
  const limits = { ...DEFAULTS, ...options };
  const results: CheckResult[] = [];

  for (const row of snapshot.fragmentation) {
    if (row.fragmentationPct < limits.minFragmentationPct) continue;
    if (row.pageCount < limits.minPageCount) continue;
    results.push(finding(row));
  }

  results.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return results;
}
