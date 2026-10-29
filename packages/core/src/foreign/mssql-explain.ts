/**
 * SQL Server plan capture for DPA auto-plans.
 *
 * Uses cached plan XML from dm_exec_query_stats (no SET SHOWPLAN — unsafe on pools).
 * Falls back to a normalized-SQL shape fingerprint when no cache hit.
 */
import type { EngineClient } from '../engine';
import { fingerprintPlanText } from '../waits/fingerprint';

export interface MssqlPlanCapture {
  fingerprint: string;
  planText: string;
  totalCost: number | null;
  source: 'cache' | 'shape';
}

function extractCost(xml: string): number | null {
  const m =
    /StatementSubTreeCost="([\d.]+)"/i.exec(xml) ??
    /EstimatedTotalSubtreeCost="([\d.]+)"/i.exec(xml);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function snippet(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 120).replace(/'/g, "''");
}

export async function runMssqlExplain(
  client: EngineClient,
  sql: string,
): Promise<MssqlPlanCapture> {
  const needle = snippet(sql);
  if (needle.length < 12) {
    throw new Error('SQL too short to match a cached plan');
  }

  const like = needle.slice(0, 80);
  const cached = await client.query(`
    select top 1 convert(nvarchar(max), qp.query_plan) as plan_xml
      from sys.dm_exec_query_stats qs
     cross apply sys.dm_exec_sql_text(qs.sql_handle) st
     cross apply sys.dm_exec_query_plan(qs.plan_handle) qp
     where st.text like N'%${like}%'
       and qp.query_plan is not null
     order by qs.last_execution_time desc`);

  const xml = String(cached[0]?.['plan_xml'] ?? '');
  if (xml.length >= 40) {
    return {
      fingerprint: fingerprintPlanText(xml),
      planText: xml.slice(0, 32_000),
      totalCost: extractCost(xml),
      source: 'cache',
    };
  }

  const normalized = needle.toLowerCase();
  return {
    fingerprint: fingerprintPlanText(`mssql-shape:${normalized}`),
    planText: `-- no cached plan XML for snippet\n-- ${needle.slice(0, 500)}`,
    totalCost: null,
    source: 'shape',
  };
}
