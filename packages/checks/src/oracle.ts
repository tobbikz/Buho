import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

/**
 * Oracle DBA checks — sessions, tablespace, blocking, parse, temp/undo, library cache.
 */

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const ORACLE_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'oracle_sessions',
    title: 'Session usage',
    description: 'USER sessions vs sessions parameter',
    sql: () => `
      select (select count(*) from v$session where type = 'USER') as used,
             (select value from v$parameter where name = 'sessions') as max_sessions
        from dual`,
    evaluate: (rows) => {
      const used = num(rows[0]?.['used']);
      const max = num(rows[0]?.['max_sessions']);
      if (max <= 0) return [];
      const pct = (used / max) * 100;
      if (pct < 80) return [];
      return [
        {
          severity: pct >= 95 ? 'critical' : 'warning',
          object: 'sessions',
          message: `Sessions at ${pct.toFixed(0)}% (${used}/${max}).`,
          remediation: 'Kill idle sessions or raise SESSIONS / PROCESSES.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
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
  },
  {
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
        findings.push({
          severity: pct >= 95 ? 'critical' : 'warning',
          object: String(row['name'] ?? 'tablespace'),
          message: `Tablespace ${row['name']} at ${pct}% used.`,
          remediation: 'Add a datafile or enable autoextend; purge obsolete segments.',
          value: pct,
        });
      }
      return findings;
    },
  },
  {
    id: 'oracle_blocking',
    title: 'Blocking sessions',
    description: 'Sessions with blocking_session set',
    sql: () => `
      select count(*) as blocked
        from v$session
       where blocking_session is not null`,
    evaluate: (rows) => {
      const blocked = num(rows[0]?.['blocked']);
      if (blocked < 1) return [];
      return [
        {
          severity: blocked >= 5 ? 'critical' : 'warning',
          object: 'blocking',
          message: `${blocked} session(s) waiting on a blocker.`,
          remediation: 'Open Locks tab; kill or commit the blocker if safe.',
          value: blocked,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'oracle_temp',
    title: 'Temp tablespace pressure',
    description: 'v$temp_extent_pool vs temp files',
    sql: () => `
      select nvl((select sum(bytes) from dba_temp_files), 0) as temp_size,
             nvl((select sum(bytes_used) from v$temp_extent_pool), 0) as temp_used
        from dual`,
    evaluate: (rows) => {
      const size = num(rows[0]?.['temp_size']);
      const used = num(rows[0]?.['temp_used']);
      if (size <= 0) return [];
      const pct = (used / size) * 100;
      if (pct < 80) return [];
      return [
        {
          severity: pct >= 95 ? 'critical' : 'warning',
          object: 'temp',
          message: `Temp at ${pct.toFixed(0)}% (${Math.round(used / 1e6)}MB / ${Math.round(size / 1e6)}MB).`,
          remediation: 'Find large sorts/hashes; raise TEMP or tune PGA.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'oracle_hard_parse',
    title: 'Hard parse ratio',
    description: 'Hard parses vs total parses',
    sql: () => `
      select
        (select value from v$sysstat where name = 'parse count (hard)') as hard,
        (select value from v$sysstat where name = 'parse count (total)') as total
      from dual`,
    evaluate: (rows) => {
      const hard = num(rows[0]?.['hard']);
      const total = num(rows[0]?.['total']);
      if (total < 1000) return [];
      const pct = (hard / total) * 100;
      if (pct < 20) return [];
      return [
        {
          severity: pct >= 40 ? 'warning' : 'info',
          object: 'parse',
          message: `Hard parse ratio ${pct.toFixed(0)}%.`,
          remediation: 'Use bind variables; review shared pool / cursor sharing.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'oracle_library_cache',
    title: 'Library cache hit ratio',
    description: 'v$librarycache pins/pinhits',
    sql: () => `
      select sum(pins) as pins, sum(pinhits) as hits
        from v$librarycache`,
    evaluate: (rows) => {
      const pins = num(rows[0]?.['pins']);
      const hits = num(rows[0]?.['hits']);
      if (pins < 1000) return [];
      const pct = (hits / pins) * 100;
      if (pct >= 95) return [];
      return [
        {
          severity: pct < 90 ? 'warning' : 'info',
          object: 'library_cache',
          message: `Library cache hit ${pct.toFixed(1)}%.`,
          remediation: 'Increase SHARED_POOL_SIZE or reduce hard parses.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'oracle_apply_lag',
    title: 'Data Guard apply lag',
    description: 'Apply lag from v$dataguard_stats',
    appliesTo: (caps) => caps.features.alwaysOn,
    sql: () => `
      select value from v$dataguard_stats where name = 'apply lag'`,
    evaluate: (rows) => {
      const raw = String(rows[0]?.['value'] ?? '');
      const m = /(?:\+(\d+)\s+)?(\d+):(\d+):(\d+)/.exec(raw);
      if (!m) return [];
      const lag =
        Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
      if (lag < 30) return [];
      return [
        {
          severity: lag >= 300 ? 'critical' : 'warning',
          object: 'dataguard',
          message: `Apply lag ${lag}s.`,
          remediation: 'Check standby apply, network, and redo transport.',
          value: lag,
        } satisfies Finding,
      ];
    },
  },
];
