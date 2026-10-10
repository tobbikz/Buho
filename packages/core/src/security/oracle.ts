import type { EngineClient } from '../engine';
import type { SecurityAudit } from './types';

/**
 * Oracle has no account-audit pack yet. Returning score 100 + empty findings
 * lied “secure”. Emit an explicit Needs-grants / not-implemented finding instead.
 */
export async function auditOracle(_client: EngineClient): Promise<SecurityAudit> {
  return {
    engine: 'oracle',
    findings: [
      {
        checkId: 'oracle_security_pack',
        category: 'privilegios',
        severity: 'no_verificable',
        title: 'Oracle security pack pending (Needs grants / N/A)',
        detail:
          'Búho does not yet audit Oracle logins, profiles, or PUBLIC grants. Score stays 0 with Needs grants — never a green empty pack.',
        remediation:
          'Track manually via DBA_USERS / DBA_PROFILES / DBA_TAB_PRIVS until the Oracle pack ships. Do not treat Security as verified for Oracle.',
        evidence: { pack: 'pending', engine: 'oracle' },
      },
    ],
    principals: [],
    // Not 100: zero verified checks must not look green.
    score: 0,
    verified: 0,
    total: 1,
  };
}
