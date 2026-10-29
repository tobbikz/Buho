/**
 * Oracle plan capture for DPA auto-plans.
 *
 * Prefers EXPLAIN PLAN + DBMS_XPLAN.DISPLAY. Falls back to normalized-SQL shape
 * when the account lacks PLAN_TABLE / privileges or the SQL is not EXPLAIN-able.
 */
import type { EngineClient } from '../engine';
import { fingerprintPlanText } from '../waits/fingerprint';

export interface OraclePlanCapture {
  fingerprint: string;
  planText: string;
  totalCost: number | null;
  source: 'xplan' | 'shape';
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

function extractCost(planText: string): number | null {
  const m = /Cost\s*=\s*([\d.]+)/i.exec(planText) ?? /cost=([\d.]+)/i.exec(planText);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function statementId(): string {
  return `BUHO${Date.now().toString(36).slice(-8).toUpperCase()}`;
}

/**
 * Capture an estimated plan via EXPLAIN PLAN FOR … + DBMS_XPLAN.
 * Only safe for read-ish statements; caller should filter DDL/utility.
 */
export async function runOracleExplain(
  client: EngineClient,
  sql: string,
): Promise<OraclePlanCapture> {
  const trimmed = sql.replace(/;\s*$/, '').trim();
  if (trimmed.length < 8) {
    throw new Error('SQL too short for Oracle plan capture');
  }

  const id = statementId();
  try {
    await client.query(`delete from plan_table where statement_id = '${id}'`);
  } catch {
    // PLAN_TABLE may not exist yet; EXPLAIN PLAN often creates it for the user.
  }

  try {
    // Bind-free EXPLAIN PLAN — statement_id scoped delete above.
    await client.query(`explain plan set statement_id = '${id}' for ${trimmed}`);
    const rows = await client.query(`
      select plan_table_output as line
        from table(dbms_xplan.display(null, '${id}', 'TYPICAL'))`);
    const planText = rows
      .map((r) => String(r['line'] ?? r['PLAN_TABLE_OUTPUT'] ?? ''))
      .filter(Boolean)
      .join('\n');
    try {
      await client.query(`delete from plan_table where statement_id = '${id}'`);
    } catch {
      /* ignore cleanup */
    }
    if (planText.length >= 20) {
      return {
        fingerprint: fingerprintPlanText(planText),
        planText: planText.slice(0, 32_000),
        totalCost: extractCost(planText),
        source: 'xplan',
      };
    }
  } catch {
    // Fall through to shape fingerprint.
  }

  const normalized = normalizeSql(trimmed);
  return {
    fingerprint: fingerprintPlanText(`oracle-shape:${normalized}`),
    planText: `-- Oracle shape fallback (no XPLAN)\n-- ${normalized.slice(0, 500)}`,
    totalCost: null,
    source: 'shape',
  };
}
