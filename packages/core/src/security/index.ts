import type { EngineClient } from '../engine';
import { auditMariadb } from './mariadb';
import { auditMssql } from './mssql';
import { auditPostgres } from './postgres';
import type { SecurityAudit } from './types';

export * from './types';

export async function auditSecurity(client: EngineClient): Promise<SecurityAudit> {
  if (client.kind === 'postgres') return auditPostgres(client);
  if (client.kind === 'mariadb') return auditMariadb(client);
  if (client.kind === 'mssql') return auditMssql(client);
  // Non-SQL / NoSQL engines: no account-audit pack yet.
  return {
    engine: client.kind,
    findings: [],
    principals: [],
    score: 100,
    verified: 0,
    total: 0,
  };
}
