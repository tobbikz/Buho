import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import type { SessionSample } from '../sessions';
import { num, str } from './types';

const SESSIONS_SQL = `
  select s.sid as pid,
         s.status as state,
         s.wait_class as wait_class,
         s.event as wait_event,
         s.username as username,
         s.schemaname as database_name,
         s.program as application,
         s.blocking_session as blocked_by,
         s.seconds_in_wait as wait_sec,
         s.last_call_et as last_call_et,
         substr(q.sql_text, 1, 900) as query_text
    from v$session s
    left join v$sql q on q.sql_id = s.sql_id and q.child_number = 0
   where s.type = 'USER'
     and s.sid <> sys_context('USERENV', 'SID')
     and (s.status = 'ACTIVE' or s.blocking_session is not null or s.seconds_in_wait > 0)
`;

const BLOCKING_SQL = `
  select w.sid as waiter_pid,
         null as waiter_query_start,
         w.seconds_in_wait as wait_seconds,
         w.username as waiter_user,
         w.program as waiter_application,
         w.schemaname as waiter_database,
         substr(wq.sql_text, 1, 900) as waiter_query,
         w.event as wait_event,
         w.event as lock_detail,
         w.row_wait_obj# as lock_object,
         b.sid as blocker_pid,
         b.status as blocker_state,
         substr(bq.sql_text, 1, 900) as blocker_query,
         b.username as blocker_user,
         b.program as blocker_application,
         null as blocker_xact_seconds
    from v$session w
    join v$session b on b.sid = w.blocking_session
    left join v$sql wq on wq.sql_id = w.sql_id and wq.child_number = 0
    left join v$sql bq on bq.sql_id = b.sql_id and bq.child_number = 0
   where w.blocking_session is not null
`;

export async function sampleOracleSessions(client: EngineClient): Promise<SessionSample[]> {
  const rows = await client.query(SESSIONS_SQL);
  return rows.map((fila) => {
    const waitClass = fila['wait_class'] == null ? null : String(fila['wait_class']);
    const waitEvent = fila['wait_event'] == null ? null : String(fila['wait_event']);
    const blockedBy = num(fila['blocked_by']);
    const waitSec = num(fila['wait_sec']);
    const lastCall = num(fila['last_call_et']);
    return {
      pid: Number(fila['pid']),
      state: str(fila['state'], 'UNKNOWN'),
      waitEventType: waitClass && waitClass !== 'Idle' ? waitClass : null,
      waitEvent: waitEvent && waitEvent !== 'null event' ? waitEvent : null,
      backendType: 'client',
      application: str(fila['application'], '(sin nombre)').slice(0, 120),
      username: str(fila['username'], '(sin rol)'),
      database: str(fila['database_name'], '(sin esquema)'),
      queryid: null,
      queryMs: (waitSec > 0 ? waitSec : lastCall) * 1000,
      xactMs: null,
      blockedBy: blockedBy > 0 ? blockedBy : null,
      query: fila['query_text'] == null ? null : String(fila['query_text']),
    };
  });
}

export async function sampleOracleBlocking(client: EngineClient): Promise<BlockedSession[]> {
  const rows = await client.query(BLOCKING_SQL);
  return rows.map((row) => {
    const blockerPid =
      row['blocker_pid'] === null || row['blocker_pid'] === undefined
        ? null
        : num(row['blocker_pid']);
    return {
      waiterPid: num(row['waiter_pid']),
      waiterQueryStart: null,
      waitSeconds: Math.max(0, num(row['wait_seconds'])),
      waiterUser: row['waiter_user'] == null ? null : String(row['waiter_user']),
      waiterApplication:
        row['waiter_application'] == null ? null : String(row['waiter_application']),
      waiterDatabase: row['waiter_database'] == null ? null : String(row['waiter_database']),
      waiterQuery:
        row['waiter_query'] == null
          ? '(sin texto de consulta)'
          : String(row['waiter_query']).slice(0, 2000),
      waitEventType: 'Lock',
      waitEvent: row['wait_event'] == null ? null : String(row['wait_event']),
      lockType: row['lock_detail'] == null ? null : String(row['lock_detail']),
      lockMode: null,
      lockObject:
        row['lock_object'] == null ? null : String(row['lock_object']),
      blockerPids: blockerPid !== null ? [blockerPid] : [],
      blockerPid,
      blockerState: row['blocker_state'] == null ? null : String(row['blocker_state']),
      blockerQuery: row['blocker_query'] == null ? null : String(row['blocker_query']),
      blockerUser: row['blocker_user'] == null ? null : String(row['blocker_user']),
      blockerApplication:
        row['blocker_application'] == null ? null : String(row['blocker_application']),
      blockerXactSeconds: null,
    };
  });
}
