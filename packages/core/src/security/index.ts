import type { EngineClient } from '../engine';
import { auditMariadb } from './mariadb';
import { auditMssql } from './mssql';
import { auditOracle } from './oracle';
import { auditPostgres } from './postgres';
import type { SecurityAudit } from './types';

export * from './types';

export async function auditSecurity(client: EngineClient): Promise<SecurityAudit> {
  if (client.kind === 'postgres') return auditPostgres(client);
  if (client.kind === 'mariadb') return auditMariadb(client);
  if (client.kind === 'mssql') return auditMssql(client);
  if (client.kind === 'oracle') return auditOracle(client);
  // Out-of-scope / non-SQL engines: no account-audit pack — do not fake score 100.
  return {
    engine: client.kind,
    findings: [
      {
        checkId: `${client.kind}_security_pack`,
        category: 'privilegios',
        severity: 'no_verificable',
        title: `Security audit not available for ${client.kind}`,
        detail: `No security pack for engine “${client.kind}”. Empty/green would be a false confident score.`,
        remediation: 'Use an in-scope SQL engine (PostgreSQL, MSSQL, MariaDB, Oracle) or review accounts outside Búho.',
        evidence: { pack: 'none', engine: client.kind },
      },
    ],
    principals: [],
    score: 0,
    verified: 0,
    total: 1,
  };
}
