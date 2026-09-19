import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Oracle Database DBA metrics (V$ / DBA views) — intent parity with MSSQL depth.
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
  description: 'Session / process pressure',
  sql: () => `
    select count(*) as total,
           sum(case when status = 'ACTIVE' then 1 else 0 end) as active,
           sum(case when status = 'INACTIVE' then 1 else 0 end) as idle,
           sum(case when blocking_session is not null then 1 else 0 end) as blocked,
           max(case when status = 'ACTIVE' then last_call_et else 0 end) as longest_active_query_seconds,
           max(case when blocking_session is not null then seconds_in_wait else 0 end) as max_blocked_seconds,
           max((select to_number(value) from v$parameter where name = 'sessions')) as max_sessions,
           max((select count(*) from v$process)) as processes,
           max((select to_number(value) from v$parameter where name = 'processes')) as max_processes
      from v$session
     where type = 'USER'`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const total = num(row['total']);
    const max = Math.max(num(row['max_sessions']), 1);
    const samples: Sample[] = [
      { metric: 'connections_total', value: total },
      { metric: 'connections_active', value: num(row['active']) },
      { metric: 'connections_idle', value: num(row['idle']) },
      { metric: 'connections_max', value: max },
      { metric: 'connections_used_pct', value: (total / max) * 100 },
      { metric: 'blocked_sessions', value: num(row['blocked']) },
      { metric: 'sessions_running', value: num(row['active']) },
      { metric: 'sessions_sleeping', value: num(row['idle']) },
      { metric: 'longest_active_query_seconds', value: num(row['longest_active_query_seconds']) },
      { metric: 'max_blocked_seconds', value: num(row['max_blocked_seconds']) },
      { metric: 'oracle_processes', value: num(row['processes']) },
      { metric: 'oracle_processes_max', value: num(row['max_processes']) },
    ];
    const maxProc = num(row['max_processes']);
    if (maxProc > 0) {
      samples.push({
        metric: 'oracle_processes_used_pct',
        value: (num(row['processes']) / maxProc) * 100,
      });
    }
    return samples;
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
      const labels = {
        wait_event_type: str(row['wait_class'], 'Other'),
        wait_event: str(row['wait_event'], 'CPU'),
      };
      samples.push({ metric: 'wait_event_sessions', value: num(row['sesiones']), labels });
      samples.push({ metric: 'wait_event_ms', value: num(row['wait_ms']), labels });
    }
    return samples;
  },
};

const waitClassCumulative: ForeignCollector = {
  id: 'oracle_wait_class',
  tier: 'fast',
  description: 'Cumulative wait class time (v$system_wait_class)',
  sql: () => `
    select wait_class, time_waited, total_waits
      from v$system_wait_class
     where wait_class <> 'Idle'`,
  toSamples: (rows) =>
    rows.map((row) => ({
      metric: 'oracle_wait_class_time_cs',
      value: num(row['time_waited']),
      labels: { wait_event_type: str(row['wait_class'], 'Other') },
      counter: true,
    })),
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
       'execute count', 'parse count (total)', 'parse count (hard)',
       'physical reads', 'physical writes',
       'redo size', 'redo entries', 'logons cumulative',
       'session logical reads',
       'bytes sent via SQL*Net to client',
       'bytes received via SQL*Net from client',
       'sorts (memory)', 'sorts (disk)',
       'table scans (long tables)', 'table fetch continued row',
       'db block gets', 'consistent gets'
     )`,
  toSamples: (rows) => {
    const byName = new Map(rows.map((r) => [str(r['name']), num(r['value'])]));
    const samples: Sample[] = [
      { metric: 'oracle_user_commits', value: byName.get('user commits') ?? 0, counter: true },
      { metric: 'oracle_user_rollbacks', value: byName.get('user rollbacks') ?? 0, counter: true },
      { metric: 'oracle_execute_count', value: byName.get('execute count') ?? 0, counter: true },
      { metric: 'oracle_parse_count', value: byName.get('parse count (total)') ?? 0, counter: true },
      { metric: 'oracle_hard_parse_count', value: byName.get('parse count (hard)') ?? 0, counter: true },
      { metric: 'oracle_physical_reads', value: byName.get('physical reads') ?? 0, counter: true },
      { metric: 'oracle_physical_writes', value: byName.get('physical writes') ?? 0, counter: true },
      { metric: 'oracle_redo_size', value: byName.get('redo size') ?? 0, counter: true },
      { metric: 'oracle_redo_entries', value: byName.get('redo entries') ?? 0, counter: true },
      { metric: 'oracle_logons', value: byName.get('logons cumulative') ?? 0, counter: true },
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
      { metric: 'oracle_sorts_memory', value: byName.get('sorts (memory)') ?? 0, counter: true },
      { metric: 'oracle_sorts_disk', value: byName.get('sorts (disk)') ?? 0, counter: true },
      {
        metric: 'oracle_table_scans_long',
        value: byName.get('table scans (long tables)') ?? 0,
        counter: true,
      },
    ];
    const logical =
      (byName.get('db block gets') ?? 0) + (byName.get('consistent gets') ?? 0) ||
      (byName.get('session logical reads') ?? 0);
    const phys = byName.get('physical reads') ?? 0;
    if (logical > 0) {
      samples.push({
        metric: 'db_cache_hit_pct',
        value: Math.max(0, Math.min(100, (1 - phys / logical) * 100)),
      });
    }
    const parses = byName.get('parse count (total)') ?? 0;
    const hard = byName.get('parse count (hard)') ?? 0;
    if (parses > 0) {
      samples.push({ metric: 'oracle_hard_parse_pct', value: (hard / parses) * 100 });
    }
    const sortsMem = byName.get('sorts (memory)') ?? 0;
    const sortsDisk = byName.get('sorts (disk)') ?? 0;
    const sorts = sortsMem + sortsDisk;
    if (sorts > 0) {
      samples.push({ metric: 'oracle_sort_disk_pct', value: (sortsDisk / sorts) * 100 });
    }
    return samples;
  },
};

const memory: ForeignCollector = {
  id: 'oracle_memory',
  tier: 'fast',
  description: 'SGA / PGA / shared pool',
  sql: () => `
    select (select sum(value) from v$sga) as sga_bytes,
           (select value from v$pgastat where name = 'total PGA allocated') as pga_bytes,
           (select value from v$pgastat where name = 'aggregate PGA target parameter') as pga_target,
           (select bytes from v$sgainfo where name = 'Buffer Cache Size') as buffer_cache,
           (select bytes from v$sgainfo where name = 'Shared Pool Size') as shared_pool,
           (select bytes from v$sgainfo where name = 'Redo Buffers') as redo_buffers`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const samples: Sample[] = [
      { metric: 'oracle_sga_bytes', value: num(row['sga_bytes']) },
      { metric: 'oracle_pga_bytes', value: num(row['pga_bytes']) },
      { metric: 'oracle_buffer_cache_bytes', value: num(row['buffer_cache']) },
      { metric: 'oracle_shared_pool_bytes', value: num(row['shared_pool']) },
      { metric: 'oracle_redo_buffers_bytes', value: num(row['redo_buffers']) },
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

const libraryCache: ForeignCollector = {
  id: 'oracle_library_cache',
  tier: 'normal',
  description: 'Library cache hit ratio',
  sql: () => `
    select sum(pins) as pins, sum(pinhits) as pinhits, sum(reloads) as reloads
      from v$librarycache`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const pins = num(row['pins']);
    const hits = num(row['pinhits']);
    const samples: Sample[] = [
      { metric: 'oracle_library_pins', value: pins, counter: true },
      { metric: 'oracle_library_reloads', value: num(row['reloads']), counter: true },
    ];
    if (pins > 0) {
      samples.push({ metric: 'oracle_library_hit_pct', value: (hits / pins) * 100 });
    }
    return samples;
  },
};

const fileIo: ForeignCollector = {
  id: 'oracle_file_io',
  tier: 'normal',
  description: 'Datafile I/O from v$filestat',
  sql: () => `
    select df.name as file_name,
           fs.phyrds as reads,
           fs.phywrts as writes,
           fs.readtim as read_ticks,
           fs.writetim as write_ticks
      from v$filestat fs
      join v$datafile df on df.file# = fs.file#
     where fs.phyrds + fs.phywrts > 0
     order by fs.phyrds + fs.phywrts desc
     fetch first 20 rows only`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const name = str(row['file_name'], 'file');
      const short = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
      const labels = { file: short.slice(0, 80) };
      samples.push({ metric: 'oracle_file_reads', value: num(row['reads']), labels, counter: true });
      samples.push({ metric: 'oracle_file_writes', value: num(row['writes']), labels, counter: true });
      const reads = num(row['reads']);
      if (reads > 0) {
        // readtim is in centiseconds
        samples.push({
          metric: 'oracle_file_avg_read_ms',
          value: (num(row['read_ticks']) * 10) / reads,
          labels,
        });
      }
    }
    return samples;
  },
};

const undoTemp: ForeignCollector = {
  id: 'oracle_undo_temp',
  tier: 'normal',
  description: 'Undo and temp tablespace pressure',
  sql: () => `
    select
      (select nvl(sum(bytes),0) from dba_data_files where tablespace_name like 'UNDOTBS%') as undo_size,
      (select nvl(sum(bytes),0) from dba_undo_extents where status = 'ACTIVE') as undo_active,
      (select nvl(sum(bytes),0) from dba_temp_files) as temp_size,
      (select nvl(sum(bytes_used),0) from v$temp_extent_pool) as temp_used
    from dual`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const samples: Sample[] = [
      { metric: 'oracle_undo_size_bytes', value: num(row['undo_size']) },
      { metric: 'oracle_undo_active_bytes', value: num(row['undo_active']) },
      { metric: 'oracle_temp_size_bytes', value: num(row['temp_size']) },
      { metric: 'oracle_temp_used_bytes', value: num(row['temp_used']) },
    ];
    const undoSize = num(row['undo_size']);
    if (undoSize > 0) {
      samples.push({
        metric: 'oracle_undo_used_pct',
        value: (num(row['undo_active']) / undoSize) * 100,
      });
    }
    const tempSize = num(row['temp_size']);
    if (tempSize > 0) {
      samples.push({
        metric: 'oracle_temp_used_pct',
        value: (num(row['temp_used']) / tempSize) * 100,
      });
    }
    return samples;
  },
};

const redoLog: ForeignCollector = {
  id: 'oracle_redo',
  tier: 'normal',
  description: 'Log switch rate and redo generation',
  sql: () => `
    select (select count(*) from v$log_history
             where first_time > sysdate - 1/24) as switches_1h,
           (select count(*) from v$log) as redo_groups,
           (select count(*) from v$log where status = 'CURRENT') as current_logs
      from dual`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    return [
      { metric: 'oracle_log_switches_1h', value: num(row['switches_1h']) },
      { metric: 'oracle_redo_groups', value: num(row['redo_groups']) },
    ];
  },
};

const tablespaces: ForeignCollector = {
  id: 'oracle_tablespaces',
  tier: 'slow',
  description: 'Tablespace size and used %',
  sql: () => `
    select df.tablespace_name as name,
           df.size_bytes,
           df.size_bytes - nvl(fs.free_bytes, 0) as used_bytes,
           round((1 - nvl(fs.free_bytes, 0) / nullif(df.size_bytes, 0)) * 100, 2) as used_pct
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
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const name = str(row['name'], '(ts)');
      samples.push({
        metric: 'database_size_bytes',
        value: num(row['used_bytes']) || num(row['size_bytes']),
        labels: { database: name },
      });
      samples.push({
        metric: 'oracle_tablespace_used_pct',
        value: num(row['used_pct']),
        labels: { database: name },
      });
      samples.push({
        metric: 'oracle_tablespace_size_bytes',
        value: num(row['size_bytes']),
        labels: { database: name },
      });
    }
    return samples;
  },
};

const topSqlGauge: ForeignCollector = {
  id: 'oracle_top_sql_gauge',
  tier: 'fast',
  description: 'Live slow SQL count from v$sql (≥1s elapsed)',
  sql: () => `
    select count(*) as slow_sql,
           nvl(max(elapsed_time / 1e6), 0) as worst_elapsed_sec
      from v$sql
     where elapsed_time / nullif(executions, 0) / 1e6 >= 1
       and executions > 0
       and parsing_schema_name not in ('SYS', 'SYSTEM')`,
  toSamples: (rows) => [
    { metric: 'oracle_slow_sql_count', value: num(rows[0]?.['slow_sql']) },
    { metric: 'oracle_worst_sql_elapsed_sec', value: num(rows[0]?.['worst_elapsed_sec']) },
    { metric: 'slow_digest_count', value: num(rows[0]?.['slow_sql']) },
  ],
};

const dataguard: ForeignCollector = {
  id: 'oracle_dataguard',
  tier: 'normal',
  description: 'Data Guard apply / transport lag',
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
  waitClassCumulative,
  sysstat,
  memory,
  libraryCache,
  fileIo,
  undoTemp,
  redoLog,
  tablespaces,
  topSqlGauge,
  dataguard,
];
