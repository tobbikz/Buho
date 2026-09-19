import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Oracle Database metrics (Thin mode / V$ views).
 * Prefer shared metric names; prefix oracle_* for engine-only gauges.
 */

const availability: ForeignCollector = {
  id: 'oracle_availability',
  tier: 'fast',
  description: 'Instance uptime',
  sql: () => `
    select (sysdate - startup_time) * 86400 as uptime_seconds
      from v$instance`,
  toSamples: (rows) => [{ metric: 'uptime_seconds', value: num(rows[0]?.['uptime_seconds']) }],
};

const connections: ForeignCollector = {
  id: 'oracle_connections',
  tier: 'fast',
  description: 'Session counts from v$session',
  sql: () => `
    select count(*) as total,
           sum(case when status = 'ACTIVE' then 1 else 0 end) as active,
           sum(case when status = 'INACTIVE' then 1 else 0 end) as idle,
           sum(case when blocking_session is not null then 1 else 0 end) as blocked,
           max((select to_number(value) from v$parameter where name = 'sessions')) as max_sessions
      from v$session
     where type = 'USER'`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const total = num(row['total']);
    const max = Math.max(num(row['max_sessions']), 1);
    return [
      { metric: 'connections_total', value: total },
      { metric: 'connections_active', value: num(row['active']) },
      { metric: 'connections_idle', value: num(row['idle']) },
      { metric: 'connections_max', value: max },
      { metric: 'connections_used_pct', value: (total / max) * 100 },
      { metric: 'blocked_sessions', value: num(row['blocked']) },
      { metric: 'sessions_running', value: num(row['active']) },
      { metric: 'sessions_sleeping', value: num(row['idle']) },
    ];
  },
};

const waits: ForeignCollector = {
  id: 'oracle_waits',
  tier: 'fast',
  description: 'Current wait events from active sessions',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select nvl(nullif(event, 'null event'), 'CPU') as wait_event,
           wait_class,
           count(*) as sesiones,
           sum(seconds_in_wait) * 1000 as wait_ms
      from v$session
     where type = 'USER'
       and status = 'ACTIVE'
     group by nvl(nullif(event, 'null event'), 'CPU'), wait_class`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const evento = str(row['wait_event'], 'CPU');
      const family = str(row['wait_class'], 'Other');
      const labels = { wait_event_type: family, wait_event: evento };
      samples.push({ metric: 'wait_event_sessions', value: num(row['sesiones']), labels });
      samples.push({ metric: 'wait_event_ms', value: num(row['wait_ms']), labels });
    }
    return samples;
  },
};

const sysstat: ForeignCollector = {
  id: 'oracle_sysstat',
  tier: 'fast',
  description: 'Key v$sysstat counters',
  sql: () => `
    select name, value
      from v$sysstat
     where name in (
       'user commits', 'user rollbacks',
       'execute count', 'parse count (total)',
       'physical reads', 'physical writes',
       'redo size', 'session logical reads',
       'bytes sent via SQL*Net to client',
       'bytes received via SQL*Net from client'
     )`,
  toSamples: (rows) => {
    const byName = new Map(rows.map((r) => [str(r['name']), num(r['value'])]));
    const samples: Sample[] = [
      { metric: 'oracle_user_commits', value: byName.get('user commits') ?? 0, counter: true },
      { metric: 'oracle_user_rollbacks', value: byName.get('user rollbacks') ?? 0, counter: true },
      { metric: 'oracle_execute_count', value: byName.get('execute count') ?? 0, counter: true },
      { metric: 'oracle_parse_count', value: byName.get('parse count (total)') ?? 0, counter: true },
      { metric: 'oracle_physical_reads', value: byName.get('physical reads') ?? 0, counter: true },
      { metric: 'oracle_physical_writes', value: byName.get('physical writes') ?? 0, counter: true },
      { metric: 'oracle_redo_size', value: byName.get('redo size') ?? 0, counter: true },
      {
        metric: 'oracle_logical_reads',
        value: byName.get('session logical reads') ?? 0,
        counter: true,
      },
      {
        metric: 'oracle_net_sent_bytes',
        value: byName.get('bytes sent via SQL*Net to client') ?? 0,
        counter: true,
      },
      {
        metric: 'oracle_net_recv_bytes',
        value: byName.get('bytes received via SQL*Net from client') ?? 0,
        counter: true,
      },
    ];
    const logical = byName.get('session logical reads') ?? 0;
    const phys = byName.get('physical reads') ?? 0;
    if (logical > 0) {
      samples.push({
        metric: 'db_cache_hit_pct',
        value: Math.max(0, Math.min(100, (1 - phys / logical) * 100)),
      });
    }
    return samples;
  },
};

const memory: ForeignCollector = {
  id: 'oracle_memory',
  tier: 'fast',
  description: 'SGA / PGA memory',
  sql: () => `
    select (select sum(value) from v$sga) as sga_bytes,
           (select value from v$pgastat where name = 'total PGA allocated') as pga_bytes,
           (select value from v$pgastat where name = 'aggregate PGA target parameter') as pga_target`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const samples: Sample[] = [
      { metric: 'oracle_sga_bytes', value: num(row['sga_bytes']) },
      { metric: 'oracle_pga_bytes', value: num(row['pga_bytes']) },
    ];
    const target = num(row['pga_target']);
    if (target > 0) {
      samples.push({ metric: 'oracle_pga_target_bytes', value: target });
      samples.push({
        metric: 'oracle_pga_used_pct',
        value: (num(row['pga_bytes']) / target) * 100,
      });
    }
    return samples;
  },
};

const tablespaces: ForeignCollector = {
  id: 'oracle_tablespaces',
  tier: 'slow',
  description: 'Tablespace sizes',
  sql: () => `
    select df.tablespace_name as name,
           sum(df.bytes) as size_bytes,
           sum(df.bytes) - nvl(sum(fs.bytes), 0) as used_bytes
      from dba_data_files df
      left join (
        select tablespace_name, sum(bytes) as bytes
          from dba_free_space
         group by tablespace_name
      ) fs on fs.tablespace_name = df.tablespace_name
     group by df.tablespace_name`,
  toSamples: (rows) =>
    rows.map((row) => ({
      metric: 'database_size_bytes',
      value: num(row['used_bytes']) || num(row['size_bytes']),
      labels: { database: str(row['name'], '(ts)') },
    })),
};

const dataguard: ForeignCollector = {
  id: 'oracle_dataguard',
  tier: 'normal',
  description: 'Data Guard apply lag when configured',
  appliesTo: (caps) => caps.features.alwaysOn,
  sql: () => `
    select name, value, unit
      from v$dataguard_stats
     where name in ('apply lag', 'transport lag')`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const name = str(row['name']);
      const raw = str(row['value'], '');
      // +00 00:00:12 style → seconds
      const m = /(?:\+(\d+)\s+)?(\d+):(\d+):(\d+)/.exec(raw);
      let seconds = 0;
      if (m) {
        seconds =
          Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
      }
      if (name === 'apply lag') {
        samples.push({ metric: 'replication_lag_seconds', value: seconds });
        samples.push({ metric: 'oracle_apply_lag_seconds', value: seconds });
      } else {
        samples.push({ metric: 'oracle_transport_lag_seconds', value: seconds });
      }
    }
    return samples;
  },
};

export const ORACLE_COLLECTORS: ForeignCollector[] = [
  availability,
  connections,
  waits,
  sysstat,
  memory,
  tablespaces,
  dataguard,
];
