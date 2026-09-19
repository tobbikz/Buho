import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Métricas de MariaDB.
 *
 * Casi todo sale de `information_schema.global_status`, que es un montón de
 * contadores planos. La traducción a nombres de Búho es deliberada y no
 * mecánica: se eligen los que contestan una pregunta de operación y se les pone
 * el nombre que ya usa PostgreSQL cuando miden lo mismo —`connections_total`,
 * `db_deadlocks`, `db_cache_hit_pct`—, para que una pantalla de flota pueda
 * comparar dos motores sin traducir en la cabeza.
 *
 * Lo que no tiene equivalente honesto se deja con su nombre de MariaDB. Forzar
 * `wal_bytes` sobre el binlog o `xid_age` sobre nada sería mentir bonito.
 */

/** Compact PROCESSLIST state for charts (full text is unreadable in legends). */
function shortProcesslistState(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('waiting for master to send')) return 'Replica idle (IO)';
  if (lower.includes('waiting for more updates') || lower.includes('sent all binlog')) {
    return lower.includes('master has sent') || lower.includes('dump')
      ? 'Dump idle'
      : 'Replica idle (SQL)';
  }
  if (lower.includes('metadata lock')) return 'Metadata lock';
  if (lower.includes('row lock')) return 'Row lock';
  if (lower.includes('table level lock')) return 'Table lock';
  if (lower.includes('filling schema')) return 'Filling schema';
  if (lower.includes('sending data')) return 'Sending data';
  if (lower.includes('copying to tmp')) return 'Tmp table';
  if (lower.includes('creating sort')) return 'Sort index';
  if (raw.length <= 36) return raw;
  return `${raw.slice(0, 33)}…`;
}

/** `wait/io/file/innodb/innodb_data_file` → `innodb_data_file` */
function shortPsEventName(raw: string): string {
  if (raw.includes('::')) {
    const leaf = raw.split('::').pop() ?? raw;
    return leaf.length <= 40 ? leaf : `${leaf.slice(0, 37)}…`;
  }
  const parts = raw.split('/');
  const leaf = parts[parts.length - 1] || raw;
  return leaf.length <= 40 ? leaf : `${leaf.slice(0, 37)}…`;
}

/** Un contador de global_status por nombre, tal cual lo entrega el motor. */
function statusMap(rows: Record<string, unknown>[]): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const row of rows) {
    const nombre = str(row['variable_name'] ?? row['VARIABLE_NAME'], '').toUpperCase();
    if (nombre) mapa.set(nombre, num(row['variable_value'] ?? row['VARIABLE_VALUE']));
  }
  return mapa;
}

const availability: ForeignCollector = {
  id: 'mariadb_availability',
  tier: 'fast',
  description: 'Uptime del servidor',
  sql: () => `
    select variable_name, variable_value
      from information_schema.global_status
     where variable_name = 'UPTIME'`,
  toSamples: (rows) => {
    const estado = statusMap(rows);
    return [{ metric: 'uptime_seconds', value: estado.get('UPTIME') ?? 0 }];
  },
};

/**
 * Sesiones.
 *
 * MariaDB no tiene el detalle de estados de `pg_stat_activity`, pero sí tiene lo
 * que más duele: transacciones abiertas hace rato. `innodb_trx` da la edad real
 * de la transacción más vieja, que es el equivalente exacto de
 * `oldest_xact_seconds` y la causa de la mitad de los incidentes de bloqueo.
 */
const connections: ForeignCollector = {
  id: 'mariadb_connections',
  tier: 'fast',
  description: 'Sesiones, saturación y transacción abierta más vieja',
  sql: () => `
    select (select variable_value from information_schema.global_variables
             where variable_name = 'MAX_CONNECTIONS')                          as max_connections,
           (select variable_value from information_schema.global_status
             where variable_name = 'THREADS_CONNECTED')                        as connected,
           (select variable_value from information_schema.global_status
             where variable_name = 'THREADS_RUNNING')                          as running,
           (select count(*) from information_schema.processlist
             where command not in ('Sleep', 'Daemon', 'Binlog Dump'))          as active,
           (select count(*) from information_schema.processlist
             where command = 'Sleep')                                          as idle,
           (select coalesce(max(timestampdiff(second, trx_started, now())), 0)
              from information_schema.innodb_trx)                              as oldest_trx_seconds,
           (select coalesce(max(time), 0) from information_schema.processlist
             where command not in ('Sleep', 'Daemon', 'Binlog Dump'))          as longest_active_query_seconds,
           (select count(*) from information_schema.innodb_trx
             where trx_state = 'LOCK WAIT')                                    as lock_waiting`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const max = num(row['max_connections']);
    const total = num(row['connected']);
    const samples: Sample[] = [
      { metric: 'connections_max', value: max },
      { metric: 'connections_total', value: total },
      { metric: 'connections_active', value: num(row['active']) },
      { metric: 'connections_idle', value: num(row['idle']) },
      { metric: 'threads_running', value: num(row['running']) },
      { metric: 'oldest_xact_seconds', value: num(row['oldest_trx_seconds']) },
      { metric: 'longest_active_query_seconds', value: num(row['longest_active_query_seconds']) },
      { metric: 'blocked_sessions', value: num(row['lock_waiting']) },
    ];
    if (max > 0) samples.push({ metric: 'connections_used_pct', value: (total / max) * 100 });
    return samples;
  },
};

/**
 * Bloqueos, con la espera en segundos.
 *
 * `blocked_sessions` ya viene del colector de sesiones; acá interesa cuánto
 * lleva esperando el peor, que es lo que decide si alguien tiene que
 * intervenir.
 */
const lockWaits: ForeignCollector = {
  id: 'mariadb_lock_waits',
  tier: 'fast',
  description: 'Espera del bloqueo más largo',
  appliesTo: (caps) => caps.features.lockWaits,
  sql: () => `
    select coalesce(max(timestampdiff(second, trx_wait_started, now())), 0) as max_blocked_seconds,
           coalesce(count(*), 0)                                            as waiting
      from information_schema.innodb_trx
     where trx_state = 'LOCK WAIT'`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    return [{ metric: 'max_blocked_seconds', value: num(row['max_blocked_seconds']) }];
  },
};

/**
 * Throughput y eficiencia del buffer pool.
 *
 * Los `Com_*` son el equivalente directo de `tup_inserted`/`updated`/`deleted`
 * de PostgreSQL, así que llevan los mismos nombres y las pantallas de DML
 * funcionan igual para los dos motores. La tasa por segundo la deriva el
 * DeltaEngine, como en PostgreSQL: acá sólo se marca `counter: true`.
 */
const throughput: ForeignCollector = {
  id: 'mariadb_throughput',
  tier: 'fast',
  description: 'Consultas, DML, commits y aciertos del buffer pool',
  sql: () => `
    select variable_name, variable_value
      from information_schema.global_status
     where variable_name in (
       'QUESTIONS', 'COM_SELECT', 'COM_INSERT', 'COM_UPDATE', 'COM_DELETE',
       'COM_COMMIT', 'COM_ROLLBACK', 'SLOW_QUERIES', 'ABORTED_CONNECTS',
       'ABORTED_CLIENTS', 'CONNECTION_ERRORS_MAX_CONNECTIONS',
       'CREATED_TMP_TABLES', 'CREATED_TMP_DISK_TABLES',
       'SELECT_FULL_JOIN', 'SELECT_SCAN', 'SORT_MERGE_PASSES',
       'INNODB_BUFFER_POOL_READ_REQUESTS', 'INNODB_BUFFER_POOL_READS',
       'INNODB_ROW_LOCK_WAITS', 'INNODB_ROW_LOCK_TIME', 'INNODB_ROW_LOCK_CURRENT_WAITS',
       'INNODB_DEADLOCKS', 'INNODB_DATA_READS', 'INNODB_DATA_WRITES',
       'INNODB_DATA_READ', 'INNODB_DATA_WRITTEN', 'INNODB_OS_LOG_WRITTEN',
       'INNODB_LOG_WAITS', 'INNODB_BUFFER_POOL_WAIT_FREE',
       'INNODB_BUFFER_POOL_PAGES_DIRTY', 'INNODB_BUFFER_POOL_PAGES_TOTAL',
       'INNODB_BUFFER_POOL_PAGES_FREE', 'INNODB_BUFFER_POOL_BYTES_DATA',
       'INNODB_HISTORY_LIST_LENGTH',
       'MEMORY_USED', 'MEMORY_USED_INITIAL',
       'BINLOG_CACHE_DISK_USE', 'BINLOG_CACHE_USE',
       'OPEN_TABLES', 'TABLE_OPEN_CACHE_OVERFLOWS',
       'KEY_READ_REQUESTS', 'KEY_READS',
       'HANDLER_READ_RND_NEXT', 'HANDLER_READ_KEY',
       'THREADS_CREATED', 'THREADS_RUNNING', 'MAX_USED_CONNECTIONS')`,
  toSamples: (rows) => {
    const estado = statusMap(rows);
    const samples: Sample[] = [];

    const contadores: Record<string, string> = {
      // Nombres compartidos con PostgreSQL donde miden lo mismo: así una
      // pantalla de DML o de deadlocks sirve para los dos motores.
      db_tup_inserted: 'COM_INSERT',
      db_tup_updated: 'COM_UPDATE',
      db_tup_deleted: 'COM_DELETE',
      db_xact_commit: 'COM_COMMIT',
      db_xact_rollback: 'COM_ROLLBACK',
      db_deadlocks: 'INNODB_DEADLOCKS',
      db_temp_files: 'CREATED_TMP_DISK_TABLES',
      // Propios de MariaDB: no hay equivalente honesto en PostgreSQL.
      queries_total: 'QUESTIONS',
      com_select: 'COM_SELECT',
      slow_queries: 'SLOW_QUERIES',
      aborted_connects: 'ABORTED_CONNECTS',
      aborted_clients: 'ABORTED_CLIENTS',
      connection_errors_max_connections: 'CONNECTION_ERRORS_MAX_CONNECTIONS',
      tmp_tables_created: 'CREATED_TMP_TABLES',
      select_full_join: 'SELECT_FULL_JOIN',
      select_scan: 'SELECT_SCAN',
      sort_merge_passes: 'SORT_MERGE_PASSES',
      innodb_row_lock_waits: 'INNODB_ROW_LOCK_WAITS',
      innodb_row_lock_time_ms: 'INNODB_ROW_LOCK_TIME',
      innodb_data_reads: 'INNODB_DATA_READS',
      innodb_data_writes: 'INNODB_DATA_WRITES',
      innodb_bytes_read: 'INNODB_DATA_READ',
      innodb_bytes_written: 'INNODB_DATA_WRITTEN',
      innodb_log_bytes_written: 'INNODB_OS_LOG_WRITTEN',
      innodb_log_waits: 'INNODB_LOG_WAITS',
      innodb_buffer_pool_wait_free: 'INNODB_BUFFER_POOL_WAIT_FREE',
      binlog_cache_disk_use: 'BINLOG_CACHE_DISK_USE',
      table_open_cache_overflows: 'TABLE_OPEN_CACHE_OVERFLOWS',
      key_read_requests: 'KEY_READ_REQUESTS',
      key_reads: 'KEY_READS',
      handler_read_rnd_next: 'HANDLER_READ_RND_NEXT',
      handler_read_key: 'HANDLER_READ_KEY',
      threads_created: 'THREADS_CREATED',
    };

    for (const [metric, clave] of Object.entries(contadores)) {
      const valor = estado.get(clave);
      if (valor === undefined) continue;
      samples.push({ metric, value: valor, counter: true });
    }

    // Instantáneas, no contadores.
    const lecturas = estado.get('INNODB_BUFFER_POOL_READ_REQUESTS') ?? 0;
    const discos = estado.get('INNODB_BUFFER_POOL_READS') ?? 0;
    if (lecturas > 0) {
      samples.push({ metric: 'db_cache_hit_pct', value: ((lecturas - discos) / lecturas) * 100 });
    }

    const paginas = estado.get('INNODB_BUFFER_POOL_PAGES_TOTAL') ?? 0;
    const sucias = estado.get('INNODB_BUFFER_POOL_PAGES_DIRTY') ?? 0;
    if (paginas > 0) {
      samples.push({ metric: 'buffer_pool_dirty_pct', value: (sucias / paginas) * 100 });
      samples.push({
        metric: 'buffer_pool_free_pct',
        value: ((estado.get('INNODB_BUFFER_POOL_PAGES_FREE') ?? 0) / paginas) * 100,
      });
    }
    samples.push({ metric: 'innodb_row_lock_current_waits', value: estado.get('INNODB_ROW_LOCK_CURRENT_WAITS') ?? 0 });
    samples.push({ metric: 'open_tables', value: estado.get('OPEN_TABLES') ?? 0 });
    samples.push({ metric: 'max_used_connections', value: estado.get('MAX_USED_CONNECTIONS') ?? 0 });
    samples.push({
      metric: 'innodb_history_list_length',
      value: estado.get('INNODB_HISTORY_LIST_LENGTH') ?? 0,
    });
    samples.push({ metric: 'threads_running', value: estado.get('THREADS_RUNNING') ?? 0 });

    const memUsed = estado.get('MEMORY_USED');
    if (memUsed !== undefined) {
      samples.push({ metric: 'mariadb_memory_used_bytes', value: memUsed });
      const memInitial = estado.get('MEMORY_USED_INITIAL') ?? 0;
      if (memInitial > 0) {
        samples.push({
          metric: 'mariadb_memory_growth_bytes',
          value: Math.max(0, memUsed - memInitial),
        });
      }
    }
    const poolData = estado.get('INNODB_BUFFER_POOL_BYTES_DATA');
    if (poolData !== undefined) {
      samples.push({ metric: 'buffer_pool_data_bytes', value: poolData });
    }
    const poolDirty = estado.get('INNODB_BUFFER_POOL_BYTES_DIRTY');
    if (poolDirty !== undefined) {
      samples.push({ metric: 'buffer_pool_dirty_bytes', value: poolDirty });
    }

    const clave = estado.get('KEY_READ_REQUESTS') ?? 0;
    if (clave > 0) {
      samples.push({
        metric: 'key_cache_hit_pct',
        value: ((clave - (estado.get('KEY_READS') ?? 0)) / clave) * 100,
      });
    }

    return samples;
  },
};

/**
 * En qué están esperando las sesiones activas.
 *
 * No es un muestreo de wait events como el de PostgreSQL —MariaDB no tiene ese
 * catálogo sin performance_schema—, pero el estado del comando en
 * `processlist` contesta la misma pregunta con menos resolución: cuántas
 * sesiones están copiando a tabla temporal, esperando un lock o enviando datos.
 */
const sessionStates: ForeignCollector = {
  id: 'mariadb_session_states',
  tier: 'fast',
  description: 'Sesiones activas agrupadas por lo que están haciendo',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select coalesce(nullif(state, ''), command) as estado,
           count(*) as sesiones,
           coalesce(sum(time), 0) * 1000 as wait_ms
      from information_schema.processlist
     where command not in (
             'Sleep', 'Daemon',
             'Binlog Dump', 'Binlog Dump GTID',
             'Slave_IO', 'Slave_SQL', 'Slave IO', 'Slave SQL'
           )
       -- Idle replica IO/SQL and dump threads accumulate TIME forever and drown Wait time.
       and coalesce(state, '') not like '%waiting for more updates%'
       and coalesce(state, '') not like '%Waiting for master to send event%'
       and coalesce(state, '') not like '%has sent all binlog%'
       and coalesce(state, '') not like '%Waiting for semi-sync ACK%'
     group by 1`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const evento = shortProcesslistState(str(row['estado'], 'ejecutando'));
      const labels = { wait_event_type: 'estado', wait_event: evento };
      samples.push({
        metric: 'wait_event_sessions',
        value: num(row['sesiones']),
        labels,
      });
      samples.push({
        metric: 'wait_event_ms',
        value: num(row['wait_ms']),
        labels,
      });
    }
    return samples;
  },
};

const databaseSizes: ForeignCollector = {
  id: 'mariadb_database_sizes',
  tier: 'slow',
  description: 'Tamaño de cada base de datos',
  sql: () => `
    select table_schema as db,
           sum(data_length + index_length) as bytes,
           sum(data_free)                  as free_bytes,
           sum(index_length)               as index_bytes,
           count(*)                        as tablas
      from information_schema.tables
     where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and table_type = 'BASE TABLE'
     group by table_schema`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { database: str(row['db']) };
      samples.push({ metric: 'database_size_bytes', value: num(row['bytes']), labels });
      samples.push({ metric: 'database_index_bytes', value: num(row['index_bytes']), labels });
      samples.push({ metric: 'database_tables', value: num(row['tablas']), labels });
      // `data_free` en InnoDB con file_per_table es espacio reservado que la
      // tabla ya no usa: es el equivalente honesto del bloat de PostgreSQL.
      samples.push({ metric: 'database_free_bytes', value: num(row['free_bytes']), labels });
    }
    return samples;
  },
};

const tableSizes: ForeignCollector = {
  id: 'mariadb_table_sizes',
  tier: 'slow',
  description: 'Tablas más grandes y su espacio reclamable',
  sql: () => `
    select table_schema as db, table_name as tabla,
           data_length + index_length as total_bytes,
           index_length               as index_bytes,
           data_free                  as free_bytes,
           table_rows                 as filas
      from information_schema.tables
     where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       and table_type = 'BASE TABLE'
     order by data_length + index_length desc
     limit 20`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { schema: str(row['db']), table: str(row['tabla']) };
      samples.push({ metric: 'table_total_bytes', value: num(row['total_bytes']), labels });
      samples.push({ metric: 'table_index_bytes', value: num(row['index_bytes']), labels });
      samples.push({ metric: 'table_free_bytes', value: num(row['free_bytes']), labels });
      samples.push({ metric: 'table_live_tuples', value: num(row['filas']), labels });

      const total = num(row['total_bytes']);
      const libre = num(row['free_bytes']);
      if (total > 0 && libre > 0) {
        samples.push({ metric: 'table_bloat_pct', value: (libre / total) * 100, labels });
      }
    }
    return samples;
  },
};

/**
 * Replicación vista desde la réplica.
 *
 * `SHOW REPLICA STATUS` es la única fuente y devuelve una fila con cuarenta
 * columnas. `Seconds_Behind_Master` es la que todo el mundo mira y la que más
 * miente: se pone en NULL cuando el hilo de SQL está caído, que es justo cuando
 * más importa. Por eso se guardan también los dos hilos por separado.
 */
const replicaStatus: ForeignCollector = {
  id: 'mariadb_replica_status',
  tier: 'normal',
  description: 'Retraso y estado de los hilos de replicación',
  sql: () => 'show replica status',
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [{ metric: 'replication_configured', value: 0 }];

    const campo = (nombre: string): unknown =>
      row[nombre] ?? row[nombre.toLowerCase()] ?? row[nombre.toUpperCase()];

    const retraso = campo('Seconds_Behind_Master');
    const ioCorriendo = String(campo('Slave_IO_Running') ?? '').toLowerCase() === 'yes';
    const sqlCorriendo = String(campo('Slave_SQL_Running') ?? '').toLowerCase() === 'yes';

    const samples: Sample[] = [
      { metric: 'replication_configured', value: 1 },
      { metric: 'replica_io_running', value: ioCorriendo ? 1 : 0 },
      { metric: 'replica_sql_running', value: sqlCorriendo ? 1 : 0 },
      { metric: 'replica_last_errno', value: num(campo('Last_Errno')) },
    ];

    // NULL no es cero: un retraso desconocido con el hilo caído es el peor
    // escenario, y guardarlo como 0 lo pintaría como una réplica al día.
    if (retraso !== null && retraso !== undefined) {
      samples.push({ metric: 'replication_replay_lag_seconds', value: num(retraso) });
    }

    return samples;
  },
};

/**
 * Estado del binlog en el primario.
 *
 * No hay un equivalente de `pg_stat_replication` con el lag por réplica: el
 * primario sabe qué réplicas están conectadas y hasta dónde leyeron, y eso es
 * todo. Con los bytes generados en el binlog se puede ver el volumen de cambio,
 * que es la parte útil para dimensionar.
 */
const binlog: ForeignCollector = {
  id: 'mariadb_binlog',
  tier: 'normal',
  description: 'Réplicas conectadas y tamaño del binlog',
  appliesTo: (caps) => caps.features.binlog,
  sql: () => `
    select (select count(*) from information_schema.processlist
             where command = 'Binlog Dump')                                    as replicas,
           (select variable_value from information_schema.global_variables
             where variable_name = 'LOG_BIN')                                  as log_bin`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    return [
      { metric: 'replication_standbys', value: num(row['replicas']) },
      { metric: 'binlog_enabled', value: String(row['log_bin']).toUpperCase() === 'ON' ? 1 : 0 },
    ];
  },
};

/**
 * Tamaño real de los binlogs, que es la causa clásica de disco lleno.
 *
 * `SHOW BINARY LOGS` es la fuente fiable —`information_schema.files` no lista
 * binlogs en MariaDB— y hay que sumar a mano porque devuelve una fila por
 * archivo.
 */
const binlogSize: ForeignCollector = {
  id: 'mariadb_binlog_size',
  tier: 'slow',
  description: 'Espacio ocupado por los binlogs',
  appliesTo: (caps) => caps.features.binlog,
  sql: () => 'show binary logs',
  toSamples: (rows) => {
    if (rows.length === 0) return [];
    let total = 0;
    for (const row of rows) {
      total += num(row['File_size'] ?? row['file_size'] ?? row['FILE_SIZE']);
    }
    return [
      { metric: 'binlog_total_bytes', value: total },
      { metric: 'binlog_files', value: rows.length },
    ];
  },
};

/** Sesiones abiertas por usuario (processlist) — complemento a aborted_connects. */
const connectionsByUser: ForeignCollector = {
  id: 'mariadb_connections_by_user',
  tier: 'normal',
  description: 'Conexiones abiertas agrupadas por usuario',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select coalesce(nullif(user, ''), '(unknown)') as usr, count(*) as sesiones
      from information_schema.processlist
     group by 1
     order by 2 desc
     limit 20`,
  toSamples: (rows) =>
    rows.map((row) => ({
      metric: 'connections_by_user',
      value: num(row['sesiones']),
      labels: { user: str(row['usr'], '(unknown)') },
    })),
};

/**
 * Wait instruments from performance_schema (only when P_S is on).
 *
 * PROCESSLIST `state` still feeds Overview without P_S. With digests enabled we
 * also expose instrumented wait time so the same Wait-time chart can show
 * mutex/IO/socket classes that processlist never names.
 */
const psWaitEvents: ForeignCollector = {
  id: 'mariadb_ps_wait_events',
  tier: 'fast',
  description: 'Top wait instruments from performance_schema',
  appliesTo: (caps) => caps.features.statementDigests,
  sql: () => `
    select event_name,
           count_star,
           sum_timer_wait / 1e9 as wait_ms
      from performance_schema.events_waits_summary_global_by_event_name
     where sum_timer_wait > 0
       and event_name not like 'idle%'
       -- Cond/timer noise dominates charts; keep IO / lock / table instruments.
       and event_name not like 'wait/synch/cond/%'
       and event_name not like 'wait/synch/mutex/%'
     order by sum_timer_wait desc
     limit 15`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const event = shortPsEventName(str(row['event_name'], 'unknown'));
      const labels = { wait_event_type: 'ps', wait_event: event };
      samples.push({
        metric: 'ps_wait_ms',
        value: num(row['wait_ms']),
        labels,
        counter: true,
      });
      samples.push({
        metric: 'ps_wait_count',
        value: num(row['count_star']),
        labels,
        counter: true,
      });
    }
    return samples;
  },
};

/** Table I/O from P_S — hot tables by fetch/insert/update/delete latency. */
const psTableIo: ForeignCollector = {
  id: 'mariadb_ps_table_io',
  tier: 'normal',
  description: 'Hot tables by performance_schema table I/O waits',
  appliesTo: (caps) => caps.features.statementDigests,
  sql: () => `
    select object_schema as db,
           object_name as tabla,
           count_fetch + count_insert + count_update + count_delete as ops,
           (sum_timer_fetch + sum_timer_insert + sum_timer_update + sum_timer_delete) / 1e9 as wait_ms
      from performance_schema.table_io_waits_summary_by_table
     where object_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
       and (count_fetch + count_insert + count_update + count_delete) > 0
     order by wait_ms desc
     limit 20`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { schema: str(row['db']), table: str(row['tabla']) };
      samples.push({
        metric: 'ps_table_io_ops',
        value: num(row['ops']),
        labels,
        counter: true,
      });
      samples.push({
        metric: 'ps_table_io_ms',
        value: num(row['wait_ms']),
        labels,
        counter: true,
      });
    }
    return samples;
  },
};

/** Statement stages (Sending data, Creating tmp, …) when P_S consumers are on. */
const psStages: ForeignCollector = {
  id: 'mariadb_ps_stages',
  tier: 'normal',
  description: 'Statement stages from performance_schema',
  appliesTo: (caps) => caps.features.statementDigests,
  sql: () => `
    select event_name,
           count_star,
           sum_timer_wait / 1e9 as wait_ms
      from performance_schema.events_stages_summary_global_by_event_name
     where sum_timer_wait > 0
     order by sum_timer_wait desc
     limit 20`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const event = str(row['event_name'], 'unknown').replace(/^stage\//, '');
      const labels = { stage: event };
      samples.push({
        metric: 'ps_stage_ms',
        value: num(row['wait_ms']),
        labels,
        counter: true,
      });
      samples.push({
        metric: 'ps_stage_count',
        value: num(row['count_star']),
        labels,
        counter: true,
      });
    }
    return samples;
  },
};

export const MARIADB_COLLECTORS: ForeignCollector[] = [
  availability,
  connections,
  lockWaits,
  throughput,
  sessionStates,
  connectionsByUser,
  psWaitEvents,
  psTableIo,
  psStages,
  databaseSizes,
  tableSizes,
  replicaStatus,
  binlog,
  binlogSize,
];
