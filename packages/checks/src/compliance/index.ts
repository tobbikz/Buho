import type { EngineClient } from '@buho/core';
import { CIS_POSTGRES_CONTROLS } from './cis-postgres';
import { CIS_MSSQL_CONTROLS } from './cis-mssql';
import type { ComplianceControl, ComplianceRunResult } from './types';

export type { ComplianceControl, ComplianceRunResult, ComplianceVerdict } from './types';
export { CIS_POSTGRES_CONTROLS } from './cis-postgres';
export { CIS_MSSQL_CONTROLS } from './cis-mssql';

export function controlsForPack(
  pack: 'cis-postgres' | 'cis-mssql' | 'stig-postgres',
): ComplianceControl[] {
  if (pack === 'cis-postgres') return CIS_POSTGRES_CONTROLS;
  if (pack === 'cis-mssql') return CIS_MSSQL_CONTROLS;
  // STIG pack placeholder — reuse CIS PG until dedicated controls land.
  return CIS_POSTGRES_CONTROLS.map((c) => ({ ...c, pack: 'stig-postgres' as const }));
}

export async function runCompliancePack(
  client: EngineClient,
  pack: 'cis-postgres' | 'cis-mssql' | 'stig-postgres',
): Promise<ComplianceRunResult> {
  const controls = controlsForPack(pack);
  const results: ComplianceRunResult['controls'] = [];
  let pass = 0;
  let scored = 0;
  for (const c of controls) {
    try {
      const rows = await client.query(c.probeSql);
      const ev = c.evaluate(rows);
      results.push({
        id: c.id,
        title: c.title,
        verdict: ev.verdict,
        severity: ev.severity,
        evidence: ev.evidence,
        remediation: ev.remediation,
      });
      if (ev.verdict !== 'not_verifiable') {
        scored += 1;
        if (ev.verdict === 'pass') pass += 1;
      }
    } catch (err) {
      results.push({
        id: c.id,
        title: c.title,
        verdict: 'not_verifiable',
        evidence: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const score = scored === 0 ? 0 : Math.round((pass / scored) * 100);
  return { pack, controls: results, score };
}
