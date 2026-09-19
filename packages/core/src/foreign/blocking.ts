import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import { sampleMongoBlocking } from './mongodb-ops';
import { sampleRedisBlocking } from './redis-ops';
import { sampleOracleBlocking } from './oracle-ops';
import type { ForeignCaps } from './types';
import { num, str } from './types';

/**
 * Captura de bloqueos en MariaDB y SQL Server.
 *
 * Un bloqueo es un evento con dos consultas y una duración, no una serie
 * numérica; por eso va a la misma tabla de episodios que PostgreSQL y no al
 * pipeline de métricas. La consola de bloqueos y el informe semanal ya saben
 * leerla, así que el trabajo acá es traducir, no inventar una pantalla nueva.
 *
 * MariaDB tiene una limitación honesta: `innodb_trx` sabe quién espera y a quién
 * espera, pero la consulta del bloqueador es la que está corriendo *ahora*, que
 * a menudo no es la que tomó el lock. Se guarda igual porque es lo único que
 * hay, y la consola lo dice.
 */

const MARIADB_SQL = `
  select esperando.trx_mysql_thread_id                                     as waiter_pid,
         timestampdiff(second, esperando.trx_wait_started, now())          as wait_seconds,
         esperando.trx_wait_started                                        as waiter_query_start,
         esperando.trx_query                                               as waiter_query,
         esperando.trx_operation_state                                     as wait_event,
         esperando.trx_tables_locked                                       as tablas_bloqueadas,
         esperando.trx_rows_locked                                         as filas_bloqueadas,
         hilo_esperando.user                                               as waiter_user,
         hilo_esperando.db                                                 as waiter_database,
         bloqueando.trx_mysql_thread_id                                    as blocker_pid,
         bloqueando.trx_query                                              as blocker_query,
         bloqueando.trx_state                                              as blocker_state,
         timestampdiff(second, bloqueando.trx_started, now())              as blocker_xact_seconds,
         hilo_bloqueando.user                                              as blocker_user
    from information_schema.innodb_lock_waits w
    join information_schema.innodb_trx esperando
      on esperando.trx_id = w.requesting_trx_id
    left join information_schema.innodb_trx bloqueando
      on bloqueando.trx_id = w.blocking_trx_id
    left join information_schema.processlist hilo_esperando
      on hilo_esperando.id = esperando.trx_mysql_thread_id
    left join information_schema.processlist hilo_bloqueando
      on hilo_bloqueando.id = bloqueando.trx_mysql_thread_id`;

/**
 * En SQL Server la cadena de bloqueo está en `dm_exec_requests`, y el detalle
 * del recurso en `dm_tran_locks`. Se toma el recurso del lock que la sesión está
 * esperando (`request_status = 'WAIT'`), que es el objeto que hay que nombrar
 * para que alguien pueda actuar.
 */
const MSSQL_SQL = `
  select r.session_id                                            as waiter_pid,
         r.wait_time / 1000.0                                    as wait_seconds,
         r.start_time                                            as waiter_query_start,
         substring(texto_esperando.text,
                   (r.statement_start_offset / 2) + 1,
                   ((case r.statement_end_offset
                       when -1 then datalength(texto_esperando.text)
                       else r.statement_end_offset end - r.statement_start_offset) / 2) + 1) as waiter_query,
         r.wait_type                                             as wait_event,
         r.wait_resource                                         as lock_object,
         s.login_name                                            as waiter_user,
         s.program_name                                          as waiter_application,
         db_name(r.database_id)                                  as waiter_database,
         r.blocking_session_id                                   as blocker_pid,
         bloqueador.login_name                                   as blocker_user,
         bloqueador.program_name                                 as blocker_application,
         bloqueador.status                                        as blocker_state,
         datediff(second, isnull(tx.transaction_begin_time, bloqueador.last_request_start_time), sysdatetime())
                                                                  as blocker_xact_seconds,
         texto_bloqueador.text                                    as blocker_query,
         (select top 1 l.resource_type + ' ' + l.request_mode
            from sys.dm_tran_locks l
           where l.request_session_id = r.session_id
             and l.request_status = 'WAIT') as lock_detail
    from sys.dm_exec_requests r
    join sys.dm_exec_sessions s on s.session_id = r.session_id
   cross apply sys.dm_exec_sql_text(r.sql_handle) texto_esperando
    left join sys.dm_exec_sessions bloqueador on bloqueador.session_id = r.blocking_session_id
    left join sys.dm_exec_connections conexion on conexion.session_id = r.blocking_session_id
   outer apply sys.dm_exec_sql_text(conexion.most_recent_sql_handle) texto_bloqueador
    left join sys.dm_tran_active_transactions tx on tx.transaction_id = r.transaction_id
   where r.blocking_session_id <> 0`;

function fecha(valor: unknown): Date | null {
  if (!valor) return null;
  if (valor instanceof Date) return valor;
  const parsed = new Date(String(valor));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function texto(valor: unknown): string | null {
  const limpio = valor === null || valor === undefined ? '' : String(valor).trim();
  return limpio === '' ? null : limpio.slice(0, 2000);
}

export async function sampleForeignBlocking(
  client: EngineClient,
  caps: ForeignCaps,
): Promise<BlockedSession[]> {
  if (caps.engine === 'mongodb') {
    return sampleMongoBlocking(client);
  }
  if (caps.engine === 'redis') {
    return sampleRedisBlocking(client);
  }
  if (caps.engine === 'oracle') {
    if (!caps.features.lockWaits) return [];
    return sampleOracleBlocking(client);
  }
  if (!caps.features.lockWaits) return [];

  const rows = await client.query(caps.engine === 'mariadb' ? MARIADB_SQL : MSSQL_SQL);

  return rows.map((row) => {
    const blockerPid = row['blocker_pid'] === null || row['blocker_pid'] === undefined
      ? null
      : num(row['blocker_pid']);

    return {
      waiterPid: num(row['waiter_pid']),
      waiterQueryStart: fecha(row['waiter_query_start']),
      waitSeconds: Math.max(0, num(row['wait_seconds'])),
      waiterUser: texto(row['waiter_user']),
      waiterApplication: texto(row['waiter_application']),
      waiterDatabase: texto(row['waiter_database']),
      waiterQuery: texto(row['waiter_query']) ?? '(sin texto de consulta)',
      // MariaDB no clasifica la espera en familias; en SQL Server el tipo de
      // espera ya viene y se aprovecha tal cual.
      waitEventType: caps.engine === 'mssql' ? 'Lock' : 'InnoDB',
      waitEvent: texto(row['wait_event']),
      lockType: texto(row['lock_detail']),
      lockMode: null,
      lockObject: texto(row['lock_object']) ?? texto(row['lock_detail']),
      blockerPids: blockerPid !== null ? [blockerPid] : [],
      blockerPid,
      blockerState: texto(row['blocker_state']),
      blockerQuery: texto(row['blocker_query']),
      blockerUser: texto(row['blocker_user']),
      blockerApplication: texto(row['blocker_application']),
      blockerXactSeconds:
        row['blocker_xact_seconds'] === null || row['blocker_xact_seconds'] === undefined
          ? null
          : num(row['blocker_xact_seconds']),
    };
  });
}
