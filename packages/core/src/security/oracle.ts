import type { EngineClient } from '../engine';
import type { SecurityAudit, SecurityFinding } from './types';

const REQUIRED_VIEWS = [
  'V$INSTANCE',
  'V$DATABASE',
  'V$SESSION',
  'V$SQL',
  'V$PARAMETER',
  'V$ARCHIVED_LOG',
  'DBA_USERS',
  'DBA_DATA_FILES',
  'DBA_TABLESPACES',
] as const;

/**
 * Probe catalog visibility. Missing SELECT → Needs-grants findings with GRANT text.
 * Full account-audit pack (PUBLIC grants, profiles) remains deferred — never green empty.
 */
export async function auditOracle(client: EngineClient): Promise<SecurityAudit> {
  const findings: SecurityFinding[] = [];
  let verified = 0;

  for (const view of REQUIRED_VIEWS) {
    const checkId = `oracle_grant_${view.toLowerCase().replace(/\$/g, '').replace(/\./g, '_')}`;
    try {
      await client.query(`select 1 from ${view} where rownum = 1`);
      verified += 1;
      findings.push({
        checkId,
        category: 'privilegios',
        severity: 'ok',
        title: `Can read ${view}`,
        detail: `SELECT on ${view} succeeded for the monitor user.`,
        remediation: undefined,
        evidence: { view, ok: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        checkId,
        category: 'privilegios',
        severity: 'no_verificable',
        title: `Needs grants · ${view}`,
        detail: `Cannot SELECT ${view}: ${msg}`,
        remediation: `GRANT SELECT ON ${view} TO buho_monitor;  -- or run sql/monitor-user-oracle.sql`,
        evidence: { view, error: msg, grant: `GRANT SELECT ON ${view} TO buho_monitor;` },
      });
    }
  }

  const missing = findings.filter((f) => f.severity === 'no_verificable').length;
  if (missing > 0) {
    findings.unshift({
      checkId: 'oracle_security_pack',
      category: 'privilegios',
      severity: 'no_verificable',
      title: 'Oracle monitor user Needs grants',
      detail: `${missing} catalog view(s) are not readable. Copy sql/monitor-user-oracle.sql or the per-view GRANT lines below.`,
      remediation:
        'As DBA: @sql/monitor-user-oracle.sql (or GRANT SELECT_CATALOG_ROLE TO buho_monitor). Re-check Security → Findings after the next collector cycle.',
      evidence: {
        pack: 'grants-probe',
        missing,
        script: 'sql/monitor-user-oracle.sql',
      },
    });
  } else {
    findings.unshift({
      checkId: 'oracle_security_pack',
      category: 'privilegios',
      severity: 'media',
      title: 'Oracle catalog readable · deep account audit still pending',
      detail:
        'Monitor user can read required V$/DBA views. Login/profile/PUBLIC privilege audit is not implemented yet — do not treat Security as full SIEM for Oracle.',
      remediation:
        'Track DBA_USERS / DBA_PROFILES / DBA_TAB_PRIVS manually until the deep Oracle pack ships.',
      evidence: { pack: 'grants-ok-audit-pending', verified },
    });
  }

  const score =
    missing > 0
      ? 0
      : Math.round((verified / REQUIRED_VIEWS.length) * 60); // cap: no deep audit yet

  return {
    engine: 'oracle',
    findings,
    principals: [],
    score,
    verified,
    total: REQUIRED_VIEWS.length + 1,
  };
}
