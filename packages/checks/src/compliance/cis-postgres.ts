import type { ComplianceControl } from './types';

export const CIS_POSTGRES_CONTROLS: ComplianceControl[] = [
  {
    id: 'cis-pg-1.1',
    pack: 'cis-postgres',
    title: 'Ensure password encryption is scram-sha-256',
    description: 'CIS-style: password_encryption should be scram-sha-256',
    probeSql: `select name, setting from pg_settings where name = 'password_encryption'`,
    evaluate: (rows) => {
      const setting = String(rows[0]?.['setting'] ?? '');
      if (!setting) {
        return { verdict: 'not_verifiable', evidence: 'pg_settings not readable' };
      }
      if (setting === 'scram-sha-256') {
        return { verdict: 'pass', evidence: `password_encryption=${setting}` };
      }
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `password_encryption=${setting}`,
        remediation: `alter system set password_encryption = 'scram-sha-256';`,
      };
    },
  },
  {
    id: 'cis-pg-1.2',
    pack: 'cis-postgres',
    title: 'Ensure logging collector is on',
    description: 'logging_collector should be on for durable logs',
    probeSql: `select name, setting from pg_settings where name = 'logging_collector'`,
    evaluate: (rows) => {
      const setting = String(rows[0]?.['setting'] ?? '');
      if (!setting) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (setting === 'on') return { verdict: 'pass', evidence: 'logging_collector=on' };
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `logging_collector=${setting}`,
        remediation: 'Enable logging_collector (requires restart).',
      };
    },
  },
  {
    id: 'cis-pg-1.3',
    pack: 'cis-postgres',
    title: 'Ensure SSL is enabled',
    description: 'ssl setting should be on for wire encryption',
    probeSql: `select name, setting from pg_settings where name = 'ssl'`,
    evaluate: (rows) => {
      const setting = String(rows[0]?.['setting'] ?? '');
      if (!setting) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (setting === 'on') return { verdict: 'pass', evidence: 'ssl=on' };
      return {
        verdict: 'fail',
        severity: 'critical',
        evidence: `ssl=${setting}`,
        remediation: 'Enable ssl and deploy server certificates.',
      };
    },
  },
  {
    id: 'cis-pg-2.1',
    pack: 'cis-postgres',
    title: 'Ensure superuser count is limited',
    description: 'Fewer than 5 login roles with superuser',
    probeSql: `select count(*)::int as n from pg_roles where rolsuper and rolcanlogin`,
    evaluate: (rows) => {
      const n = Number(rows[0]?.['n'] ?? NaN);
      if (!Number.isFinite(n)) return { verdict: 'not_verifiable', evidence: 'count failed' };
      if (n <= 3) return { verdict: 'pass', evidence: `${n} login superusers` };
      return {
        verdict: 'fail',
        severity: n >= 10 ? 'critical' : 'warning',
        evidence: `${n} login superusers`,
        remediation: 'Reduce rolsuper on service accounts; use finer grants.',
      };
    },
  },
  {
    id: 'cis-pg-2.2',
    pack: 'cis-postgres',
    title: 'Ensure log_connections is on',
    description: 'Auth successes should be logged',
    probeSql: `select name, setting from pg_settings where name = 'log_connections'`,
    evaluate: (rows) => {
      const setting = String(rows[0]?.['setting'] ?? '');
      if (!setting) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (setting === 'on') return { verdict: 'pass', evidence: 'log_connections=on' };
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `log_connections=${setting}`,
        remediation: `alter system set log_connections = on; select pg_reload_conf();`,
      };
    },
  },
  {
    id: 'cis-pg-2.3',
    pack: 'cis-postgres',
    title: 'Ensure log_disconnections is on',
    description: 'Session ends should be logged',
    probeSql: `select name, setting from pg_settings where name = 'log_disconnections'`,
    evaluate: (rows) => {
      const setting = String(rows[0]?.['setting'] ?? '');
      if (!setting) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (setting === 'on') return { verdict: 'pass', evidence: 'log_disconnections=on' };
      return {
        verdict: 'fail',
        severity: 'info',
        evidence: `log_disconnections=${setting}`,
        remediation: `alter system set log_disconnections = on; select pg_reload_conf();`,
      };
    },
  },
  {
    id: 'cis-pg-3.1',
    pack: 'cis-postgres',
    title: 'Ensure shared_preload_libraries includes pg_stat_statements',
    description: 'Statement stats required for DBA observability',
    probeSql: `select setting from pg_settings where name = 'shared_preload_libraries'`,
    evaluate: (rows) => {
      if (rows[0] == null) return { verdict: 'not_verifiable', evidence: 'not readable' };
      const setting = String(rows[0]['setting'] ?? '');
      if (/(^|,)\s*pg_stat_statements\s*(,|$)/i.test(setting)) {
        return { verdict: 'pass', evidence: `shared_preload_libraries=${setting}` };
      }
      return {
        verdict: 'fail',
        severity: 'warning',
        evidence: `shared_preload_libraries=${setting || '(empty)'}`,
        remediation: 'Add pg_stat_statements to shared_preload_libraries and restart.',
      };
    },
  },
  {
    id: 'cis-pg-3.2',
    pack: 'cis-postgres',
    title: 'Ensure temp_file_limit is set',
    description: 'Unbounded temp files can fill the disk',
    probeSql: `select setting from pg_settings where name = 'temp_file_limit'`,
    evaluate: (rows) => {
      const setting = String(rows[0]?.['setting'] ?? '');
      if (!rows[0]) return { verdict: 'not_verifiable', evidence: 'not readable' };
      if (setting !== '-1') return { verdict: 'pass', evidence: `temp_file_limit=${setting}` };
      return {
        verdict: 'fail',
        severity: 'info',
        evidence: 'temp_file_limit=-1 (unlimited)',
        remediation: 'Set a finite temp_file_limit appropriate for the host disk.',
      };
    },
  },
];
