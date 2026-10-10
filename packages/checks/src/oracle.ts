import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';
import { ORACLE_PARITY_CHECKS } from './oracle-parity';

export { ORACLE_PARITY_CHECKS, ORACLE_PARITY_MAP, assertOracleParity } from './oracle-parity';

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Extra Oracle checks beyond the PostgreSQL 1:1 parity set. */
const processUsage: ForeignCheckDefinition = {
  id: 'oracle_processes',
  title: 'Process usage',
  description: 'v$process vs processes parameter',
  sql: () => `
    select (select count(*) from v$process) as used,
           (select to_number(value) from v$parameter where name = 'processes') as max_proc
      from dual`,
  evaluate: (rows) => {
    const used = num(rows[0]?.['used']);
    const max = num(rows[0]?.['max_proc']);
    if (max <= 0) return [];
    const pct = (used / max) * 100;
    if (pct < 80) return [];
    return [
      {
        severity: pct >= 95 ? 'critical' : 'warning',
        object: 'processes',
        message: `Processes at ${pct.toFixed(0)}% (${used}/${max}).`,
        remediation: 'Raise PROCESSES or investigate session leaks.',
        value: pct,
      } satisfies Finding,
    ];
  },
};

const tablespaceFree: ForeignCheckDefinition = {
  id: 'oracle_tablespace',
  title: 'Tablespace free space',
  description: 'Data files nearly full',
  sql: () => `
    select df.tablespace_name as name,
           round((1 - nvl(fs.free_bytes, 0) / nullif(df.size_bytes, 0)) * 100, 1) as used_pct
      from (
        select tablespace_name, sum(bytes) as size_bytes
          from dba_data_files
         group by tablespace_name
      ) df
      left join (
        select tablespace_name, sum(bytes) as free_bytes
          from dba_free_space
         group by tablespace_name
      ) fs on fs.tablespace_name = df.tablespace_name`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const pct = num(row['used_pct']);
      if (pct < 85) continue;
      const name = String(row['name'] ?? 'tablespace');
      // SYSTEM/SYSAUX on Oracle Free often sit high — warn, do not page as critical.
      const systemish = name === 'SYSTEM' || name === 'SYSAUX';
      findings.push({
        severity: !systemish && pct >= 95 ? 'critical' : 'warning',
        object: name,
        message: `Tablespace ${name} at ${pct}% used.`,
        remediation: 'Add a datafile or enable autoextend; purge obsolete segments.',
        value: pct,
      });
    }
    return findings;
  },
};

export const ORACLE_CHECKS: ForeignCheckDefinition[] = [
  ...ORACLE_PARITY_CHECKS,
  processUsage,
  tablespaceFree,
];
