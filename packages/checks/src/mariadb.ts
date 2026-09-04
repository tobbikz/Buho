import { formatPct } from '@buho/core';
import type { Finding } from './types';
import { MARIADB_PARITY_CHECKS } from './mariadb-parity';

export { MARIADB_PARITY_CHECKS, MARIADB_PARITY_MAP, assertMariadbParity } from './mariadb-parity';

/**
 * Chequeos de MariaDB.
 *
 * Paridad 1:1 con PostgreSQL vive en `mariadb-parity.ts`. Aquí quedan extras
 * compuestos (estado global) que no tienen un único check PG.
 */

export interface ForeignCheckDefinition {
  id: string;
  title: string;
  description: string;
  appliesTo?: (caps: import('@buho/core').ForeignCaps) => boolean;
  sql: (caps: import('@buho/core').ForeignCaps) => string | null;
  evaluate: (
    rows: Record<string, unknown>[],
    caps: import('@buho/core').ForeignCaps,
  ) => Finding[];
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
 * Extra compuesto: señales del snapshot que no tienen un único check PG
 * (deadlocks, sql_mode, file_per_table, thread cache, connection errors).
 */
const configuracion: ForeignCheckDefinition = {
  id: 'mariadb_config',
  title: 'Configuration extras',
  description: 'Composite config signals beyond the 1:1 parity checks',
  sql: () => ESTADO_SQL,
  evaluate: (rows) => {
    const mapa = estado(rows);
    if (mapa.size === 0) return [];
    const hallazgos: Finding[] = [];

    if (s(mapa, 'CONNECTION_ERRORS_MAX_CONNECTIONS') > 0) {
      hallazgos.push({
        severity: 'critical',
        object: 'connection_errors_max_connections',
        message: `${s(mapa, 'CONNECTION_ERRORS_MAX_CONNECTIONS')} connection(s) rejected for hitting max_connections.`,
        remediation: 'Review the application pool and raise max_connections as a temporary measure (hot-change).',
      });
    }

    const hilosCreados = s(mapa, 'THREADS_CREATED');
    const conexiones = s(mapa, 'CONNECTIONS');
    if (conexiones > 10_000 && hilosCreados / conexiones > 0.1) {
      hallazgos.push({
        severity: 'info',
        object: 'thread_cache_size',
        message: `a new thread was created on ${formatPct((hilosCreados / conexiones) * 100)} of connections.`,
        remediation: 'Raise thread_cache_size to at least the peak of concurrent connections (hot-change).',
      });
    }

    if (s(mapa, 'INNODB_DEADLOCKS') > 0) {
      hallazgos.push({
        severity: 'warning',
        object: 'deadlocks',
        message: `${s(mapa, 'INNODB_DEADLOCKS')} deadlock(s) since startup.`,
        remediation:
          'Details of the last one are in the error log. Usual cause: two transactions locking rows in different order.',
        value: s(mapa, 'INNODB_DEADLOCKS'),
      });
    }

    if (v(mapa, 'SLOW_QUERY_LOG').toUpperCase() !== 'ON' && v(mapa, 'SLOW_QUERY_LOG') !== '1') {
      hallazgos.push({
        severity: 'info',
        object: 'slow_query_log',
        message: 'slow query log is off: slow queries leave no trace.',
        remediation: 'Enable slow_query_log with long_query_time=1 and log_output=TABLE (hot-change).',
      });
    }

    const sqlMode = v(mapa, 'SQL_MODE').toUpperCase();
    if (!sqlMode.includes('STRICT_')) {
      hallazgos.push({
        severity: 'warning',
        object: 'sql_mode',
        message: 'sql_mode does not include STRICT_TRANS_TABLES: bad data may be truncated silently.',
        remediation: 'Add STRICT_TRANS_TABLES to sql_mode (hot-change). Test first on old apps.',
      });
    }

    if (v(mapa, 'INNODB_FILE_PER_TABLE').toUpperCase() === 'OFF') {
      hallazgos.push({
        severity: 'warning',
        object: 'innodb_file_per_table',
        message: 'innodb_file_per_table is off: everything lives in ibdata1.',
        remediation: 'Enable it and rebuild large tables with ALTER TABLE … FORCE.',
      });
    }

    const formato = v(mapa, 'BINLOG_FORMAT').toUpperCase();
    if (v(mapa, 'LOG_BIN').toUpperCase() === 'ON' && formato && formato !== 'ROW') {
      hallazgos.push({
        severity: 'warning',
        object: 'binlog_format',
        message: `binlog_format = ${formato}: statement-based replication can desync silently.`,
        remediation: 'SET GLOBAL binlog_format=ROW.',
      });
    }

    return hallazgos;
  },
};

export const MARIADB_CHECKS: ForeignCheckDefinition[] = [...MARIADB_PARITY_CHECKS, configuracion];
