import type { EngineClient } from '../engine';
import type { SessionSample } from '../sessions';
import { sampleMongoSessions } from './mongodb-ops';
import { sampleRedisSessions } from './redis-ops';
import { sampleOracleSessions } from './oracle-ops';
import { sampleCassandraSessions } from './cassandra-ops';
import { sampleElasticsearchSessions } from './elasticsearch-ops';
import type { ForeignCaps } from './types';
import { num, str } from './types';

/**
 * Foto de sesiones y esperas en MariaDB y SQL Server.
 *
 * Misma forma de salida que PostgreSQL (`SessionSample`), porque el store y la
 * pantalla de Sesiones ya saben leerla. Lo que cambia es de dónde sale cada
 * dato, y eso sí es distinto en cada motor:
 *
 * - MariaDB: `information_schema.PROCESSLIST`. El `State` es un texto libre
 *   ("Sending data", "Waiting for table metadata lock", …) y no una taxonomía
 *   cerrada como `wait_event_type`. Se clasifica a mano y con honestidad: lo
 *   que no se reconoce queda como `Other`, no como `CPU`.
 * - SQL Server: `sys.dm_exec_requests` + `sys.dm_exec_sessions`. Ahí sí hay
 *   `wait_type` tipado y `blocking_session_id`, que es exactamente el equivalente
 *   de `wait_event` + `pg_blocking_pids`.
 *
 * Las dos consultas excluyen la sesión del propio monitor y las idle, por la
 * misma razón que en PostgreSQL: no aportan a "qué estaba corriendo" ni a
 * "en qué se espera", y multiplicarían el volumen por el pool de la aplicación.
 */

/**
 * Clasifica el texto de `State` de MariaDB en las mismas familias que
 * PostgreSQL, para que el gráfico de perfil de espera se lea igual en los tres.
 *
 * Es una heurística: el State de MariaDB no está documentado como enumeración
 * estable y cambia entre versiones. Por eso se mira el prefijo y se cae a
 * `Other` cuando no se reconoce, en vez de inventar un `CPU` falso.
 */
export function classifyMariaState(state: string | null, command: string | null): {
  waitType: string | null;
  waitEvent: string | null;
} {
  const texto = (state ?? '').toLowerCase();
  const comando = (command ?? '').toLowerCase();

  if (!texto && (comando === 'query' || comando === 'execute')) {
    return { waitType: null, waitEvent: null }; // CPU / ejecutando
  }
  if (texto.includes('lock') || texto.includes('waiting for table')) {
    return { waitType: 'Lock', waitEvent: state };
  }
  if (
    texto.includes('sending data') ||
    texto.includes('reading from net') ||
    texto.includes('writing to net') ||
    texto.includes('waiting for handler commit')
  ) {
    return { waitType: 'Client', waitEvent: state };
  }
  if (
    texto.includes('copying to tmp') ||
    texto.includes('creating tmp') ||
    texto.includes('sorting') ||
    texto.includes('statistics') ||
    texto.includes('optimizing') ||
    texto.includes('preparing') ||
    texto.includes('executing') ||
    texto.includes('updating') ||
    texto === 'query'
  ) {
    return { waitType: null, waitEvent: null };
  }
  if (texto.includes('waiting') || texto.includes('sleep')) {
    return { waitType: 'Timeout', waitEvent: state };
  }
  if (texto) return { waitType: 'Other', waitEvent: state };
  return { waitType: null, waitEvent: null };
}

/**
 * Prefijos de `wait_type` de SQL Server → familia.
 *
 * La lista completa tiene cientos de valores; estos prefijos cubren lo que un
 * DBA actúa: bloqueos, disco, CPU/scheduler, red del cliente y latches ligeros.
 * El resto queda como `Other` con el nombre original, que es lo que se necesita
 * para investigar y no para un gráfico bonito.
 */
export function classifyMssqlWait(waitType: string | null): {
  waitType: string | null;
  waitEvent: string | null;
} {
  if (!waitType) return { waitType: null, waitEvent: null };
  const upper = waitType.toUpperCase();

  if (upper.startsWith('LCK_')) return { waitType: 'Lock', waitEvent: waitType };
  if (
    upper.startsWith('PAGEIOLATCH_') ||
    upper.startsWith('WRITELOG') ||
    upper.startsWith('IO_COMPLETION') ||
    upper.startsWith('ASYNC_IO_COMPLETION') ||
    upper.startsWith('BACKUPIO')
  ) {
    return { waitType: 'IO', waitEvent: waitType };
  }
  if (upper === 'ASYNC_NETWORK_IO' || upper === 'NETWORK_IO') {
    return { waitType: 'Client', waitEvent: waitType };
  }
  if (
    upper === 'SOS_SCHEDULER_YIELD' ||
    upper.startsWith('CXPACKET') ||
    upper.startsWith('CXCONSUMER') ||
    upper === 'THREADPOOL'
  ) {
    // En SQL Server "CPU" no es wait_type nulo: el scheduler yield y el paralelismo
    // son esperas de CPU. Se etiquetan como CPU para que el gráfico diga lo mismo
    // que en PostgreSQL ("está gastando CPU"), no "está esperando algo raro".
    return { waitType: 'CPU', waitEvent: waitType };
  }
  if (upper.startsWith('LATCH_') || upper.startsWith('PAGELATCH_')) {
    return { waitType: 'LWLock', waitEvent: waitType };
  }
  if (upper.includes('SLEEP') || upper === 'WAITFOR') {
    return { waitType: 'Timeout', waitEvent: waitType };
  }
  return { waitType: 'Other', waitEvent: waitType };
}

const MARIADB_SQL = `
  select id                                                    as pid,
         command                                               as command,
         state                                                 as state,
         user                                                  as username,
         coalesce(nullif(db, ''), '(sin base)')                as database_name,
         time                                                  as time_sec,
         time_ms                                               as time_ms,
         left(info, 900)                                       as query_text
    from information_schema.processlist
   where id <> connection_id()
     and command not in ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID', 'Connect')
     and (command in ('Query', 'Execute', 'Prepare')
          or state is not null and state <> '')`;

const MSSQL_SQL = `
  select r.session_id                                          as pid,
         r.status                                              as state,
         r.wait_type                                           as wait_type,
         r.blocking_session_id                                 as blocked_by,
         s.login_name                                          as username,
         coalesce(nullif(s.program_name, N''), N'(unnamed)') as application,
         coalesce(db_name(r.database_id), N'(sin base)')       as database_name,
         r.total_elapsed_time                                  as query_ms,
         -- No hay un start_time fiable de la transacción abierta en todas las
         -- ediciones: se usa last_request_start_time cuando hay transacción
         -- abierta, que es una cota inferior y se presenta como tal.
         case when s.open_transaction_count > 0
              then datediff(millisecond, s.last_request_start_time, sysdatetime())
              else null end                                    as xact_ms_raw,
         s.open_transaction_count                              as open_tran,
         left(substring(t.text,
                        (r.statement_start_offset / 2) + 1,
                        ((case r.statement_end_offset
                            when -1 then datalength(t.text)
                            else r.statement_end_offset end
                          - r.statement_start_offset) / 2) + 1), 900) as query_text
    from sys.dm_exec_requests r
    join sys.dm_exec_sessions s on s.session_id = r.session_id
    outer apply sys.dm_exec_sql_text(r.sql_handle) t
   where r.session_id <> @@spid
     and s.is_user_process = 1
     and r.status in (N'running', N'runnable', N'suspended', N'rollback')`;

export async function sampleForeignSessions(
  client: EngineClient,
  caps: ForeignCaps,
): Promise<SessionSample[]> {
  if (caps.engine === 'mariadb') {
    const rows = await client.query(MARIADB_SQL);
    return rows.map((fila) => {
      const command = fila['command'] == null ? null : String(fila['command']);
      const state = fila['state'] == null || fila['state'] === '' ? null : String(fila['state']);
      const { waitType, waitEvent } = classifyMariaState(state, command);
      const timeMs = fila['time_ms'] == null ? null : num(fila['time_ms']);
      const timeSec = fila['time_sec'] == null ? null : num(fila['time_sec']);
      const queryText = fila['query_text'] == null ? null : String(fila['query_text']);
      return {
        pid: Number(fila['pid']),
        state: command ?? state ?? 'desconocido',
        waitEventType: waitType,
        waitEvent,
        backendType: 'client',
        // PROCESSLIST no expone application_name: no se inventa.
        application: '(unnamed)',
        username: str(fila['username'], '(sin rol)'),
        database: str(fila['database_name'], '(sin base)'),
        queryid: null,
        queryMs: timeMs ?? (timeSec !== null ? timeSec * 1000 : null),
        xactMs: null,
        // El bloqueador concreto vive en la pantalla de Bloqueos
        // (innodb_lock_waits); aquí sólo se clasifica la espera.
        blockedBy: null,
        query: queryText,
      };
    });
  }

  if (caps.engine === 'mssql') {
    const rows = await client.query(MSSQL_SQL);
    return rows.map((fila) => {
      const waitRaw =
        fila['wait_type'] == null || fila['wait_type'] === '' ? null : String(fila['wait_type']);
      const { waitType, waitEvent } = classifyMssqlWait(waitRaw);
      const blockedBy = num(fila['blocked_by']);
      const openTran = num(fila['open_tran']);
      const xactRaw = fila['xact_ms_raw'] == null ? null : num(fila['xact_ms_raw']);
      const queryText = fila['query_text'] == null ? null : String(fila['query_text']);
      return {
        pid: Number(fila['pid']),
        state: str(fila['state'], 'desconocido'),
        waitEventType: waitType,
        waitEvent,
        backendType: 'client',
        application: str(fila['application'], '(unnamed)'),
        username: str(fila['username'], '(sin rol)'),
        database: str(fila['database_name'], '(sin base)'),
        queryid: null,
        queryMs: fila['query_ms'] == null ? null : num(fila['query_ms']),
        xactMs: openTran > 0 ? xactRaw : null,
        blockedBy: blockedBy > 0 ? blockedBy : null,
        query: queryText,
      };
    });
  }

  if (caps.engine === 'mongodb') {
    return sampleMongoSessions(client);
  }

  if (caps.engine === 'redis') {
    return sampleRedisSessions(client);
  }

  if (caps.engine === 'oracle') {
    return sampleOracleSessions(client);
  }

  if (caps.engine === 'cassandra') {
    return sampleCassandraSessions(client);
  }

  if (caps.engine === 'elasticsearch') {
    return sampleElasticsearchSessions(client);
  }

  return [];
}
