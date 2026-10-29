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
  {
    id: 'cis-mssql-2.2',
    pack: 'cis-mssql',
    title: 'Ensure remote admin connections are off',
    description: 'remote admin connections should be 0',
    probeSql: `select name, cast(value_in_use as int) as value_in_use
                 from sys.configurations where name = 'remote admin connections'`,
    evaluate: (rows) => {
      if (!rows[0]) return { verdict: 'not_verifiable', evidence: 'not readable' };
      const v = Number(rows[0]['value_in_use']);
      if (v === 0) return { verdict: 'pass', evidence: 'remote admin connections=0' };
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `remote admin connections=${v}`,
        remediation: 'Disable remote admin connections unless DAC over network is required.',
      };
    },
  },
  {
    id: 'cis-mssql-3.1',
    pack: 'cis-mssql',
    title: 'Ensure Query Store is on for user databases',
    description: 'At least one user DB should have Query Store enabled',
    probeSql: `select count(*) as n from sys.databases
                where database_id > 4 and is_query_store_on = 1 and state_desc = 'ONLINE'`,
    evaluate: (rows) => {
      const n = Number(rows[0]?.['n'] ?? NaN);
      if (!Number.isFinite(n)) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (n >= 1) return { verdict: 'pass', evidence: `${n} user DB(s) with Query Store on` };
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: 'No online user database has Query Store enabled',
        remediation: 'ALTER DATABASE [db] SET QUERY_STORE = ON (READ_WRITE);',
      };
    },
  },
  {
    id: 'cis-mssql-3.2',
    pack: 'cis-mssql',
    title: 'Ensure max degree of parallelism is bounded',
    description: 'max degree of parallelism should not be 0 on busy hosts',
    probeSql: `select name, cast(value_in_use as int) as value_in_use
                 from sys.configurations where name = 'max degree of parallelism'`,
    evaluate: (rows) => {
      if (!rows[0]) return { verdict: 'not_verifiable', evidence: 'not readable' };
      const v = Number(rows[0]['value_in_use']);
      if (v > 0 && v <= 8) return { verdict: 'pass', evidence: `maxdop=${v}` };
      if (v === 0) {
        return {
          verdict: 'fail',
          severity: 'info',
          evidence: 'maxdop=0 (scheduler decides)',
          remediation: 'Set MAXDOP to a value aligned with vCPU / NUMA guidance.',
        };
      }
      return {
        verdict: 'fail',
        severity: 'info',
        evidence: `maxdop=${v}`,
        remediation: 'Review MAXDOP against workload; values above 8 are uncommon for OLTP.',
      };
    },
  },
];
