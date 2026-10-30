import type { SecurityPrincipal } from '@buho/core';
import type { Finding } from './types';

export const PRIVILEGE_SUPERUSER_SPRAWL = 'privilege_superuser_sprawl';
export const PRIVILEGE_NOLOGIN_MISSING = 'privilege_nologin_missing';
export const PRIVILEGE_WILDCARD_HOST = 'privilege_wildcard_host';

const ELEVATED_PRIVILEGES = new Set([
  'SUPERUSER',
  'SUPER',
  'CREATEROLE',
  'CREATEDB',
  'REPLICATION',
  'BYPASSRLS',
  'FILE',
  'PROCESS',
  'SHUTDOWN',
  'CREATE USER',
  'GRANT OPTION',
  'sysadmin',
  'securityadmin',
]);

export interface SecuritySnapshot {
  principals: SecurityPrincipal[];
}

function principalLabel(principal: SecurityPrincipal): string {
  if (principal.host && principal.host !== '') {
    return `'${principal.name}'@'${principal.host}'`;
  }
  return principal.name;
}

/**
 * Privilege sprawl findings from a security audit snapshot (same shapes as
 * {@link auditSecurity} / `buho.security_principals`), without re-querying the engine.
 */
export function findingsFromSecuritySnapshot(snapshot: SecuritySnapshot): Finding[] {
  const active = snapshot.principals.filter((principal) => !principal.disabled);
  const findings: Finding[] = [];

  /** SQL Server install defaults — not "sprawl" the way extra human logins are. */
  const MSSQL_SERVICE_SUPERUSERS = new Set([
    String.raw`BUILTIN\Administrators`,
    String.raw`NT AUTHORITY\SYSTEM`,
    String.raw`NT AUTHORITY\NETWORK SERVICE`,
    String.raw`NT SERVICE\MSSQLSERVER`,
    String.raw`NT SERVICE\SQLSERVERAGENT`,
  ]);
  const superLogins = active.filter(
    (principal) =>
      principal.isSuperuser &&
      principal.canLogin &&
      !MSSQL_SERVICE_SUPERUSERS.has(principal.name),
  );
  if (superLogins.length > 2) {
    findings.push({
      severity: 'warning',
      object: 'superuser',
      message: `${superLogins.length} login principals are superusers: ${superLogins.map(principalLabel).join(', ')}.`,
      remediation:
        'Keep superuser only where required. Prefer pg_monitor / pg_read_all_data / scoped roles instead of widening superuser.',
      value: superLogins.length,
    });
  }

  const groupRolesWithLogin = active.filter(
    (principal) =>
      principal.canLogin &&
      (principal.kind === 'role' || principal.kind === 'rol') &&
      !principal.isSuperuser,
  );
  if (groupRolesWithLogin.length > 0) {
    findings.push({
      severity: 'info',
      object: 'nologin',
      message: `${groupRolesWithLogin.length} group role(s) still allow LOGIN: ${groupRolesWithLogin.map(principalLabel).join(', ')}.`,
      remediation:
        'Group roles should be NOLOGIN; grant them to login roles instead: ALTER ROLE … NOLOGIN.',
      value: groupRolesWithLogin.length,
    });
  }

  const elevatedLogins = active.filter(
    (principal) =>
      principal.canLogin &&
      !principal.isSuperuser &&
      principal.privileges.some((privilege) => ELEVATED_PRIVILEGES.has(privilege)),
  );
  if (elevatedLogins.length > 0) {
    findings.push({
      severity: 'warning',
      object: 'elevated_login',
      message: `${elevatedLogins.length} non-superuser login(s) carry elevated global privileges: ${elevatedLogins
        .map((principal) => `${principalLabel(principal)} (${principal.privileges.join(', ')})`)
        .join('; ')}.`,
      remediation:
        'Use NOLOGIN group roles for elevated privileges and grant membership to fewer login accounts.',
      value: elevatedLogins.length,
    });
  }

  const wildcardHosts = active.filter(
    (principal) => principal.canLogin && (principal.host === '%' || principal.host === '0.0.0.0/0'),
  );
  if (wildcardHosts.length > 0) {
    const critical = wildcardHosts.filter((principal) => principal.isSuperuser);
    findings.push({
      severity: critical.length > 0 ? 'critical' : 'warning',
      object: 'host_wildcard',
      message: `${wildcardHosts.length} login account(s) accept any host (${wildcardHosts.map(principalLabel).join(', ')}).`,
      remediation:
        "Restrict host to required networks (MariaDB: RENAME USER …; PostgreSQL: pg_hba.conf + role host rules).",
      value: wildcardHosts.length,
    });
  }

  return findings;
}

export function securityPrivilegeCheckResults(principals: SecurityPrincipal[]) {
  const catalog: Record<string, string> = {
    superuser: PRIVILEGE_SUPERUSER_SPRAWL,
    nologin: PRIVILEGE_NOLOGIN_MISSING,
    elevated_login: PRIVILEGE_SUPERUSER_SPRAWL,
    host_wildcard: PRIVILEGE_WILDCARD_HOST,
  };
  const titles: Record<string, string> = {
    superuser: 'Superuser sprawl',
    nologin: 'Group role allows LOGIN',
    elevated_login: 'Elevated privileges on login roles',
    host_wildcard: 'Wildcard host login',
  };

  return findingsFromSecuritySnapshot({ principals }).map((finding) => ({
    ...finding,
    checkId: catalog[finding.object ?? ''] ?? PRIVILEGE_SUPERUSER_SPRAWL,
    title: titles[finding.object ?? ''] ?? 'Privilege sprawl',
  }));
}
