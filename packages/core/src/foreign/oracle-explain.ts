/**
 * Oracle plan capture stub for DPA auto-plans.
 *
 * Full DISPLAY_CURSOR / DBMS_XPLAN wiring is engine-specific and permission-heavy;
 * until then, expose a stable shape fingerprint from normalized SQL (same idea as
 * MSSQL cache miss fallback).
 */
import type { EngineClient } from '../engine';
import { fingerprintPlanText } from '../waits/fingerprint';

export interface OraclePlanCapture {
  fingerprint: string;
  planText: string;
  totalCost: number | null;
  source: 'shape';
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'([^']|'')*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

/** Shape-only fingerprint; `client` reserved for a future v$sql / XPLAN path. */
export async function runOracleExplain(
  _client: EngineClient,
  sql: string,
): Promise<OraclePlanCapture> {
  const normalized = normalizeSql(sql);
  if (normalized.length < 8) {
    throw new Error('SQL too short for Oracle shape fingerprint');
  }
  return {
    fingerprint: fingerprintPlanText(`oracle-shape:${normalized}`),
    planText: `-- Oracle auto-plan stub (normalized SQL shape)\n-- ${normalized.slice(0, 500)}`,
    totalCost: null,
    source: 'shape',
  };
}
