import type { ComplianceControl } from './types';

export const CIS_MSSQL_CONTROLS: ComplianceControl[] = [
  {
    id: 'cis-mssql-1.1',
    pack: 'cis-mssql',
    title: 'Ensure XP_CMDSHELL is disabled',
    description: 'Surface reduction: xp_cmdshell should be 0',
    probeSql: `select name, cast(value_in_use as int) as value_in_use
                 from sys.configurations where name = 'xp_cmdshell'`,
    evaluate: (rows) => {
      if (!rows[0]) return { verdict: 'not_verifiable', evidence: 'sys.configurations not readable' };
      const v = Number(rows[0]['value_in_use']);
      if (v === 0) return { verdict: 'pass', evidence: 'xp_cmdshell=0' };
      return {
        verdict: 'fail',
        severity: 'critical',
        evidence: `xp_cmdshell=${v}`,
        remediation: 'EXEC sp_configure \'xp_cmdshell\', 0; RECONFIGURE;',
      };
    },
  },
  {
    id: 'cis-mssql-1.2',
    pack: 'cis-mssql',
    title: 'Ensure CLR enabled is off unless required',
    description: 'clr enabled should be 0 by default',
    probeSql: `select name, cast(value_in_use as int) as value_in_use
                 from sys.configurations where name = 'clr enabled'`,
    evaluate: (rows) => {
      if (!rows[0]) return { verdict: 'not_verifiable', evidence: 'not readable' };
      const v = Number(rows[0]['value_in_use']);
      if (v === 0) return { verdict: 'pass', evidence: 'clr enabled=0' };
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `clr enabled=${v}`,
        remediation: 'Disable CLR unless an approved workload needs it.',
      };
    },
  },
  {
    id: 'cis-mssql-2.1',
    pack: 'cis-mssql',
    title: 'Ensure SA is disabled or renamed posture check',
    description: 'sysadmin members count (informational CIS-style)',
    probeSql: `select count(*) as n from sys.server_role_members m
                 join sys.server_principals r on r.principal_id = m.role_principal_id
                 join sys.server_principals p on p.principal_id = m.member_principal_id
                where r.name = 'sysadmin' and p.is_disabled = 0`,
    evaluate: (rows) => {
      const n = Number(rows[0]?.['n'] ?? NaN);
      if (!Number.isFinite(n)) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (n <= 3) return { verdict: 'pass', evidence: `${n} enabled sysadmin members` };
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `${n} enabled sysadmin members`,
        remediation: 'Reduce sysadmin membership; use least privilege roles.',
      };
    },
  },
];
