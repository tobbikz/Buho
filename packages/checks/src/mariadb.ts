import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { ForeignCaps } from '@buho/core';
import type { Finding } from './types';

/**
 * Chequeos de MariaDB.
 *
 * El criterio es el mismo que en PostgreSQL: cada hallazgo tiene que ser algo
 * que alguien pueda arreglar, con la instrucción concreta de cómo. Nada de
 * "considere revisar la configuración".
 *
 * Los umbrales son los que se usan en la práctica, no los del manual: un
 * `innodb_buffer_pool_size` del 25 % de la RAM es el default y es casi siempre
 * poco, pero avisar de eso en un servidor compartido sería ruido. Se avisa
 * cuando el pool es chico **y** el motor está leyendo de disco de verdad.
 */

export interface ForeignCheckDefinition {
  id: string;
  title: string;
  description: string;
  appliesTo?: (caps: ForeignCaps) => boolean;
  sql: (caps: ForeignCaps) => string | null;
  evaluate: (rows: Record<string, unknown>[], caps: ForeignCaps) => Finding[];
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown, fallback = '(unknown)'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

/** Variables y contadores en una sola consulta, para no ir cinco veces. */
const ESTADO_SQL = `
  select 'v' as origen, variable_name as nombre, variable_value as valor
    from information_schema.global_variables
   where variable_name in (
     'MAX_CONNECTIONS', 'INNODB_BUFFER_POOL_SIZE', 'INNODB_FLUSH_LOG_AT_TRX_COMMIT',
     'SYNC_BINLOG', 'LOG_BIN', 'BINLOG_FORMAT', 'INNODB_FILE_PER_TABLE',
     'MAX_ALLOWED_PACKET', 'TABLE_OPEN_CACHE', 'THREAD_CACHE_SIZE',
     'INNODB_LOG_FILE_SIZE', 'INNODB_IO_CAPACITY', 'SLOW_QUERY_LOG',
     'LONG_QUERY_TIME', 'PERFORMANCE_SCHEMA', 'EXPIRE_LOGS_DAYS',
     'INNODB_LOCK_WAIT_TIMEOUT', 'WAIT_TIMEOUT', 'INTERACTIVE_TIMEOUT',
     'MAX_STATEMENT_TIME', 'INNODB_STRICT_MODE', 'SQL_MODE',
     'INNODB_BUFFER_POOL_INSTANCES', 'TMP_TABLE_SIZE', 'MAX_HEAP_TABLE_SIZE',
     'INNODB_ADAPTIVE_HASH_INDEX', 'INNODB_FLUSH_METHOD', 'READ_ONLY')
  union all
  select 's', variable_name, variable_value
    from information_schema.global_status
   where variable_name in (
     'UPTIME', 'THREADS_CONNECTED', 'MAX_USED_CONNECTIONS', 'ABORTED_CONNECTS',
     'INNODB_BUFFER_POOL_READ_REQUESTS', 'INNODB_BUFFER_POOL_READS',
     'INNODB_BUFFER_POOL_PAGES_TOTAL', 'INNODB_BUFFER_POOL_PAGES_FREE',
     'INNODB_ROW_LOCK_WAITS', 'INNODB_ROW_LOCK_TIME_AVG', 'INNODB_DEADLOCKS',
     'CREATED_TMP_DISK_TABLES', 'CREATED_TMP_TABLES', 'SELECT_FULL_JOIN',
     'SLOW_QUERIES', 'QUESTIONS', 'THREADS_CREATED', 'CONNECTIONS',
     'TABLE_OPEN_CACHE_OVERFLOWS', 'OPENED_TABLES', 'INNODB_LOG_WAITS',
     'BINLOG_CACHE_DISK_USE', 'BINLOG_CACHE_USE', 'INNODB_BUFFER_POOL_WAIT_FREE',
     'CONNECTION_ERRORS_MAX_CONNECTIONS')`;

/** Mapa de nombre a valor a partir de la consulta de estado. */
function estado(rows: Record<string, unknown>[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const row of rows) {
    const origen = text(row['origen'], '');
    const nombre = text(row['nombre'], '').toUpperCase();
    if (nombre) mapa.set(`${origen}:${nombre}`, text(row['valor'], ''));
  }
  return mapa;
}

const v = (mapa: Map<string, string>, nombre: string): string => mapa.get(`v:${nombre}`) ?? '';
const s = (mapa: Map<string, string>, nombre: string): number => num(mapa.get(`s:${nombre}`));

/**
 * Un único check que lee el estado global y saca varias conclusiones.
 *
 * Se agrupan a propósito: son quince preguntas sobre las mismas dos vistas, y
 * hacerlas en quince consultas separadas multiplica por quince el costo en el
 * servidor del cliente sin ganar nada. Cada hallazgo lleva su propio `object`
 * para que la consola los muestre por separado.
 */
const configuracion: ForeignCheckDefinition = {
  id: 'mariadb_config',
  title: 'Configuration and durability',
  description: 'Durability, buffer pool, binlog, timeouts, and strict mode',
  sql: () => ESTADO_SQL,
  evaluate: (rows) => {
    const mapa = estado(rows);
    if (mapa.size === 0) return [];
    const hallazgos: Finding[] = [];

    // ---------------------------------------------------------- durabilidad
    const flush = v(mapa, 'INNODB_FLUSH_LOG_AT_TRX_COMMIT');
    if (flush !== '1') {
      hallazgos.push({
        severity: 'critical',
        object: 'innodb_flush_log_at_trx_commit',
        message: `innodb_flush_log_at_trx_commit = ${flush}: a power loss can lose up to one second of already committed transactions.`,
        remediation:
          'Set innodb_flush_log_at_trx_commit=1 (hot-change with SET GLOBAL). ' +
          'Value 2 is only defensible on read replicas or in a test environment, and it should be documented.',
      });
    }

    const syncBinlog = v(mapa, 'SYNC_BINLOG');
    if (v(mapa, 'LOG_BIN').toUpperCase() === 'ON' && syncBinlog !== '1') {
      hallazgos.push({
        severity: 'warning',
        object: 'sync_binlog',
        message: `sync_binlog = ${syncBinlog} with binlog on: after a crash, binlog and data can be misaligned and the replica comes up corrupt.`,
        remediation: 'Set sync_binlog=1. With modern storage the cost is small and it is required for a reliable replica.',
      });
    }

    if (v(mapa, 'LOG_BIN').toUpperCase() !== 'ON') {
      hallazgos.push({
        severity: 'warning',
        object: 'log_bin',
        message: 'binlog is off: point-in-time recovery and adding a replica are not possible.',
        remediation:
          'Enable log_bin in my.cnf (requires restart). Without binlog the only backup option is a full dump, ' +
          'and everything since the last dump is lost.',
      });
    }

    const formato = v(mapa, 'BINLOG_FORMAT').toUpperCase();
    if (formato && formato !== 'ROW') {
      hallazgos.push({
        severity: 'warning',
        object: 'binlog_format',
        message: `binlog_format = ${formato}: non-deterministic statements replicate differently on the replica and desync it silently.`,
        remediation: 'Set binlog_format=ROW (hot-change with SET GLOBAL binlog_format=ROW).',
      });
    }

    // --------------------------------------------------------- buffer pool
    const lecturas = s(mapa, 'INNODB_BUFFER_POOL_READ_REQUESTS');
    const discos = s(mapa, 'INNODB_BUFFER_POOL_READS');
    const uptime = s(mapa, 'UPTIME');
    if (lecturas > 1_000_000 && uptime > 3_600) {
      const aciertos = ((lecturas - discos) / lecturas) * 100;
      if (aciertos < 99) {
        hallazgos.push({
          severity: aciertos < 95 ? 'critical' : 'warning',
          object: 'innodb_buffer_pool_size',
          message:
            `buffer pool hit rate is ${formatPct(aciertos)} and it is set to ` +
            `${formatBytes(num(v(mapa, 'INNODB_BUFFER_POOL_SIZE')))}: the engine is going to disk steadily.`,
          remediation:
            'Raise innodb_buffer_pool_size until the active working set fits in memory; on a dedicated server, ' +
            'between 60% and 75% of RAM. It can be changed hot in MariaDB 10.2+ and the engine resizes in chunks.',
          value: aciertos,
        });
      }
    }

    if (s(mapa, 'INNODB_BUFFER_POOL_WAIT_FREE') > 100) {
      hallazgos.push({
        severity: 'warning',
        object: 'innodb_buffer_pool_wait_free',
        message: `${s(mapa, 'INNODB_BUFFER_POOL_WAIT_FREE')} waits for a free page in the buffer pool: writes cannot flush fast enough.`,
        remediation:
          'Raise innodb_io_capacity and innodb_io_capacity_max to the real disk range (on SSD, 2000 and 4000 are reasonable starting points).',
      });
    }

    // ------------------------------------------------------------ conexiones
    const maxConn = num(v(mapa, 'MAX_CONNECTIONS'));
    const usadas = s(mapa, 'MAX_USED_CONNECTIONS');
    if (maxConn > 0 && usadas / maxConn > 0.8) {
      hallazgos.push({
        severity: usadas / maxConn > 0.95 ? 'critical' : 'warning',
        object: 'max_connections',
        message: `connection peak reached ${usadas} of ${maxConn} (${formatPct((usadas / maxConn) * 100)}).`,
        remediation:
          'Put a pool in the application before raising max_connections: each connection reserves session buffers ' +
          '(sort_buffer_size, join_buffer_size) and a thousand idle connections can cost gigabytes of RAM.',
        value: (usadas / maxConn) * 100,
      });
    }

    if (s(mapa, 'CONNECTION_ERRORS_MAX_CONNECTIONS') > 0) {
      hallazgos.push({
        severity: 'critical',
        object: 'connection_errors_max_connections',
        message: `${s(mapa, 'CONNECTION_ERRORS_MAX_CONNECTIONS')} connection(s) rejected for hitting max_connections: the application already saw errors.`,
        remediation: 'Review the application pool and raise max_connections as a temporary measure (hot-change).',
      });
    }

    const hilosCreados = s(mapa, 'THREADS_CREATED');
    const conexiones = s(mapa, 'CONNECTIONS');
    if (conexiones > 10_000 && hilosCreados / conexiones > 0.1) {
      hallazgos.push({
        severity: 'info',
        object: 'thread_cache_size',
        message: `a new thread was created on ${formatPct((hilosCreados / conexiones) * 100)} of connections: the thread cache is too small.`,
        remediation: 'Raise thread_cache_size to at least the peak of concurrent connections (hot-change).',
      });
    }

    // ------------------------------------------------------------- temporales
    const tmp = s(mapa, 'CREATED_TMP_TABLES');
    const tmpDisco = s(mapa, 'CREATED_TMP_DISK_TABLES');
    if (tmp > 1_000 && tmpDisco / tmp > 0.25) {
      hallazgos.push({
        severity: tmpDisco / tmp > 0.5 ? 'warning' : 'info',
        object: 'tmp_table_size',
        message: `${formatPct((tmpDisco / tmp) * 100)} of temp tables end up on disk (${tmpDisco} of ${tmp}).`,
        remediation:
          'Raise tmp_table_size and max_heap_table_size together (the effective limit is the lower of the two). ' +
          'If it does not drop, there is usually a GROUP BY on a TEXT or BLOB column, which goes to disk regardless of size.',
        value: (tmpDisco / tmp) * 100,
      });
    }

    // ------------------------------------------------------------- bloqueos
    if (s(mapa, 'INNODB_DEADLOCKS') > 0) {
      hallazgos.push({
        severity: 'warning',
        object: 'deadlocks',
        message: `${s(mapa, 'INNODB_DEADLOCKS')} deadlock(s) since startup.`,
        remediation:
          'Details of the last one are in the error log: InnoDB stores the full graph with both queries. ' +
          'The usual cause is two transactions locking the same rows in different order.',
        value: s(mapa, 'INNODB_DEADLOCKS'),
      });
    }

    const esperaMedia = s(mapa, 'INNODB_ROW_LOCK_TIME_AVG');
    if (esperaMedia > 1_000) {
      hallazgos.push({
        severity: esperaMedia > 5_000 ? 'critical' : 'warning',
        object: 'innodb_row_lock_time_avg',
        message: `each row lock wait lasts ${formatDuration(esperaMedia / 1000)} on average.`,
        remediation:
          'Look for long transactions touching many rows. A shorter innodb_lock_wait_timeout turns infinite waits into errors the application can retry, but it does not fix the cause.',
        value: esperaMedia,
      });
    }

    // -------------------------------------------------------------- timeouts
    if (num(v(mapa, 'MAX_STATEMENT_TIME')) === 0) {
      hallazgos.push({
        severity: 'warning',
        object: 'max_statement_time',
        message: 'max_statement_time = 0: a badly written query can run forever and drag down the server.',
        remediation:
          'Set max_statement_time with a generous ceiling (for example 300 seconds) on the server, and tune per session ' +
          'for processes that truly need more. Hot-change.',
      });
    }

    const esperaLock = num(v(mapa, 'INNODB_LOCK_WAIT_TIMEOUT'));
    if (esperaLock >= 300) {
      hallazgos.push({
        severity: 'info',
        object: 'innodb_lock_wait_timeout',
        message: `innodb_lock_wait_timeout = ${esperaLock}s: a blocked session waits five minutes before giving up.`,
        remediation: 'Lower it to 10–50 seconds so the application gets an actionable error instead of hanging.',
      });
    }

    // ---------------------------------------------------------- observabilidad
    if (v(mapa, 'PERFORMANCE_SCHEMA').toUpperCase() !== 'ON' && v(mapa, 'PERFORMANCE_SCHEMA') !== '1') {
      hallazgos.push({
        severity: 'warning',
        object: 'performance_schema',
        message: 'performance_schema is off: there is no query analytics, so you cannot tell which query consumes the time.',
        remediation:
          'Set performance_schema=ON in my.cnf and restart. Typical cost is about 5% CPU and it enables ' +
          'the query dashboard.',
      });
    }

    if (v(mapa, 'SLOW_QUERY_LOG').toUpperCase() !== 'ON' && v(mapa, 'SLOW_QUERY_LOG') !== '1') {
      hallazgos.push({
        severity: 'info',
        object: 'slow_query_log',
        message: 'slow query log is off: slow queries leave no trace.',
        remediation:
          'Enable slow_query_log with long_query_time=1 and log_output=TABLE (all hot-change); Buho reads it without ' +
          'needing server access.',
      });
    }

    // -------------------------------------------------------- modo estricto
    const sqlMode = v(mapa, 'SQL_MODE').toUpperCase();
    if (!sqlMode.includes('STRICT_')) {
      hallazgos.push({
        severity: 'warning',
        object: 'sql_mode',
        message: 'sql_mode does not include STRICT_TRANS_TABLES: data that does not fit is silently truncated instead of raising an error.',
        remediation:
          'Add STRICT_TRANS_TABLES to sql_mode (hot-change). Test first: an old application ' +
          'may depend on truncation.',
      });
    }

    if (v(mapa, 'INNODB_FILE_PER_TABLE').toUpperCase() === 'OFF') {
      hallazgos.push({
        severity: 'warning',
        object: 'innodb_file_per_table',
        message: 'innodb_file_per_table is off: everything lives in ibdata1, which never returns space to the filesystem.',
        remediation:
          'Enable it (hot-change) and rebuild large tables with ALTER TABLE … FORCE to move them out of the shared ' +
          'tablespace. It is the only way to reclaim disk after deleting data.',
      });
    }

    return hallazgos;
  },
};

/**
 * Tablas sin clave primaria.
 *
 * En InnoDB toda tabla tiene una clave primaria: si no se declara, el motor crea
 * una oculta de 6 bytes. El problema es la replicación por filas, que sin clave
 * primaria tiene que buscar la fila entera para cada cambio y convierte una
 * réplica en un cuello de botella silencioso.
 */
const sinClavePrimaria: ForeignCheckDefinition = {
  id: 'mariadb_no_primary_key',
  title: 'Tables without primary key',
  description: 'InnoDB tables without a PK, which degrade row-based replication',
  sql: () => `
    select t.table_schema as db, t.table_name as tabla,
           t.data_length + t.index_length as bytes, t.table_rows as filas
      from information_schema.tables t
     where t.table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and t.table_type = 'BASE TABLE'
       and not exists (
         select 1 from information_schema.statistics st
          where st.table_schema = t.table_schema
            and st.table_name   = t.table_name
            and st.index_name   = 'PRIMARY')
     order by t.data_length + t.index_length desc
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: num(row['bytes']) > 1_073_741_824 ? 'warning' : 'info',
      object: `${text(row['db'])}.${text(row['tabla'])}`,
      message: `no primary key, ${formatBytes(num(row['bytes']))} and ~${num(row['filas'])} rows.`,
      remediation:
        'Add a primary key. With binlog_format=ROW, each UPDATE or DELETE on the replica scans the full table ' +
        'for every changed row, so one large table without a PK is enough to leave the replica permanently behind.',
      value: num(row['bytes']),
    })),
};

/**
 * Espacio reclamable.
 *
 * `data_free` en InnoDB con file_per_table es espacio que la tabla reservó y ya
 * no usa. Es el equivalente honesto del bloat de PostgreSQL, con la misma
 * advertencia: una tabla con escrituras constantes siempre tiene algo, y sólo
 * vale intervenir cuando es mucho en términos absolutos y relativos.
 */
const espacioReclamable: ForeignCheckDefinition = {
  id: 'mariadb_reclaimable_space',
  title: 'Reclaimable table space',
  description: 'Tables with large data_free that occupy disk without using it',
  sql: () => `
    select table_schema as db, table_name as tabla,
           data_length + index_length as bytes,
           data_free                  as libre
      from information_schema.tables
     where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and table_type = 'BASE TABLE'
       and data_free > 1073741824
       and data_free > (data_length + index_length) * 0.2
     order by data_free desc
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const libre = num(row['libre']);
      const total = num(row['bytes']);
      const pct = total > 0 ? (libre / total) * 100 : 0;
      return {
        severity: libre > 10_737_418_240 ? 'warning' : 'info',
        object: `${text(row['db'])}.${text(row['tabla'])}`,
        message: `${formatBytes(libre)} reclaimable (${formatPct(pct)} of table size).`,
        remediation:
          'OPTIMIZE TABLE rebuilds the table and returns space, but blocks writes in MariaDB without ALGORITHM=INPLACE. ' +
          'The non-blocking alternative is ALTER TABLE … FORCE, ALGORITHM=INPLACE, LOCK=NONE.',
        value: libre,
      };
    }),
};

/** Transacciones abiertas hace mucho: la causa raíz de la mitad de los bloqueos. */
const transaccionesViejas: ForeignCheckDefinition = {
  id: 'mariadb_long_transactions',
  title: 'Long-open transactions',
  description: 'Transactions that hold locks and grow the undo history',
  appliesTo: (caps) => caps.features.lockWaits,
  sql: () => `
    select trx_id, trx_mysql_thread_id as hilo, trx_state as estado,
           timestampdiff(second, trx_started, now()) as segundos,
           trx_rows_locked as filas_bloqueadas,
           left(coalesce(trx_query, ''), 200) as consulta
      from information_schema.innodb_trx
     where trx_started < now() - interval 5 minute
     order by trx_started
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const segundos = num(row['segundos']);
      return {
        severity: segundos > 3_600 ? 'critical' : 'warning',
        object: `thread ${text(row['hilo'])}`,
        message:
          `transaction open for ${formatDuration(segundos)} in state ${text(row['estado'])}, ` +
          `${num(row['filas_bloqueadas'])} row(s) locked` +
          (text(row['consulta'], '') ? `: ${text(row['consulta'])}` : ' with no active query'),
        remediation:
          'An open transaction prevents purging undo history and blocks other sessions. If there is no active query, ' +
          'the application opened BEGIN and never closed it: review pool transaction handling before killing the thread with KILL.',
        value: segundos,
      };
    }),
};

/** Réplica caída o atrasada, visto desde la réplica. */
const replicacion: ForeignCheckDefinition = {
  id: 'mariadb_replication',
  title: 'Replication health',
  description: 'Replication threads and lag versus the primary',
  appliesTo: (caps) => caps.role === 'replica',
  sql: () => 'show replica status',
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const campo = (nombre: string): unknown => row[nombre] ?? row[nombre.toLowerCase()];
    const hallazgos: Finding[] = [];

    const io = String(campo('Slave_IO_Running') ?? '').toLowerCase() === 'yes';
    const sql = String(campo('Slave_SQL_Running') ?? '').toLowerCase() === 'yes';
    const errno = num(campo('Last_Errno'));

    if (!io || !sql) {
      hallazgos.push({
        severity: 'critical',
        object: !io ? 'IO thread' : 'SQL thread',
        message:
          `${!io ? 'IO' : 'SQL'} thread is stopped` +
          (errno > 0 ? `: error ${errno} — ${text(campo('Last_Error'), 'no details')}` : '.'),
        remediation:
          'The replica stopped applying changes and is falling behind from this point. Review the error and resume with ' +
          'START REPLICA; if it is a data conflict, skip it with GTID instead of sql_slave_skip_counter.',
      });
    }

    const retraso = campo('Seconds_Behind_Master');
    if (retraso === null || retraso === undefined) {
      if (io && sql) {
        hallazgos.push({
          severity: 'warning',
          object: 'Seconds_Behind_Master',
          message: 'lag reports NULL with both threads running: the replica does not know how far behind it is.',
          remediation: 'This often happens right after starting the replica. If it persists, check the connection to the primary.',
        });
      }
    } else if (num(retraso) > 60) {
      hallazgos.push({
        severity: num(retraso) > 600 ? 'critical' : 'warning',
        object: 'lag',
        message: `replica is ${formatDuration(num(retraso))} behind the primary.`,
        remediation:
          'The usual cause is a single apply thread against a parallel primary: raise slave_parallel_threads ' +
          'and use slave_parallel_mode=optimistic. The other classic cause is a large table without a primary key.',
        value: num(retraso),
      });
    }

    return hallazgos;
  },
};

export const MARIADB_CHECKS: ForeignCheckDefinition[] = [
  configuracion,
  sinClavePrimaria,
  espacioReclamable,
  transaccionesViejas,
  replicacion,
];
