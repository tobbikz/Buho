import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Métricas de SQL Server.
 *
 * Las DMV son mucho más ricas que `global_status` de MariaDB, y el riesgo acá es
 * el opuesto: recoger de todo y no poder explicar nada. Se eligen las que
 * contestan las cinco preguntas que un DBA de SQL Server hace primero —¿hay
 * presión de memoria?, ¿en qué esperan las sesiones?, ¿cuánto tarda el disco por
 * archivo?, ¿el log de transacciones está creciendo?, ¿la réplica está al día?—
 * y se reusa el nombre de PostgreSQL cuando la métrica es la misma cosa.
 *
 * `sys.dm_os_performance_counters` merece una advertencia: sus contadores son de
 * tres tipos y no todos son acumulados. Los que se usan acá están marcados uno
 * por uno; mezclarlos es el error clásico que produce gráficas de picos falsos.
 */

const availability: ForeignCollector = {
  id: 'mssql_availability',
  tier: 'fast',
  description: 'Uptime del servidor',
  sql: () => `
    select datediff(second, sqlserver_start_time, sysdatetime()) as uptime_seconds
      from sys.dm_os_sys_info`,
  toSamples: (rows) => [{ metric: 'uptime_seconds', value: num(rows[0]?.['uptime_seconds']) }],
};

/**
 * Sesiones y peticiones.
 *
 * `dm_exec_sessions` cuenta conexiones; `dm_exec_requests` cuenta lo que está
 * corriendo de verdad. La transacción abierta más vieja sale de
 * `dm_tran_active_transactions`, y es el equivalente de `oldest_xact_seconds`:
 * la causa de que el log no se pueda truncar.
 */
const connections: ForeignCollector = {
  id: 'mssql_connections',
  tier: 'fast',
  description: 'Sesiones, peticiones activas, bloqueos y transacción más vieja',
  sql: () => `
    select (select count(*) from sys.dm_exec_sessions where is_user_process = 1)         as total,
           (select count(*) from sys.dm_exec_requests r
              join sys.dm_exec_sessions s on s.session_id = r.session_id
             where s.is_user_process = 1 and r.session_id <> @@spid)                     as active,
           (select count(*) from sys.dm_exec_sessions
             where is_user_process = 1 and status = 'sleeping')                         as idle,
           (select count(*) from sys.dm_exec_sessions
             where is_user_process = 1 and open_transaction_count > 0
               and status = 'sleeping')                                                 as idle_in_transaction,
           (select count(*) from sys.dm_exec_requests where blocking_session_id <> 0)    as blocked,
           -- Sólo transacciones de sesiones de usuario: las internas del motor
           -- llevan abiertas desde el arranque y harían ver una transacción de
           -- seis horas donde no hay ninguna.
           (select isnull(max(datediff(second, t.transaction_begin_time, sysdatetime())), 0)
              from sys.dm_tran_active_transactions t
              join sys.dm_tran_session_transactions st on st.transaction_id = t.transaction_id
              join sys.dm_exec_sessions s on s.session_id = st.session_id
             where s.is_user_process = 1)                                               as oldest_xact_seconds,
           (select isnull(max(r.total_elapsed_time), 0) / 1000.0 from sys.dm_exec_requests r
              join sys.dm_exec_sessions s on s.session_id = r.session_id
             where s.is_user_process = 1)                                               as longest_active_query_seconds,
           (select isnull(max(wait_time), 0) / 1000.0 from sys.dm_exec_requests
             where blocking_session_id <> 0)                                            as max_blocked_seconds,
           (select cast(value_in_use as int) from sys.configurations
             where name = 'user connections')                                           as max_connections`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    const total = num(row['total']);
    // 0 en 'user connections' significa "sin límite configurado": el techo real
    // es 32767. Reportar 0 como máximo daría una saturación de infinito.
    const configurado = num(row['max_connections']);
    const max = configurado > 0 ? configurado : 32_767;

    const samples: Sample[] = [
      { metric: 'connections_max', value: max },
      { metric: 'connections_total', value: total },
      { metric: 'connections_active', value: num(row['active']) },
      { metric: 'connections_idle', value: num(row['idle']) },
      { metric: 'connections_idle_in_transaction', value: num(row['idle_in_transaction']) },
      { metric: 'connections_used_pct', value: (total / max) * 100 },
      { metric: 'oldest_xact_seconds', value: num(row['oldest_xact_seconds']) },
      { metric: 'longest_active_query_seconds', value: num(row['longest_active_query_seconds']) },
      { metric: 'blocked_sessions', value: num(row['blocked']) },
      { metric: 'max_blocked_seconds', value: num(row['max_blocked_seconds']) },
    ];
    return samples;
  },
};

/**
 * En qué esperan las sesiones, ahora mismo.
 *
 * Se muestrea `dm_exec_requests` en vez de acumular `dm_os_wait_stats` a
 * propósito: los acumulados desde el arranque promedian un incidente de las
 * tres de la tarde con dos semanas de calma, y lo que hace falta ver es el
 * incidente. Se usa el mismo nombre de métrica que PostgreSQL para que la
 * pantalla de clases de espera sirva igual.
 */
const waits: ForeignCollector = {
  id: 'mssql_waits',
  tier: 'fast',
  description: 'Muestreo de esperas de las peticiones activas',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select isnull(nullif(r.wait_type, ''), 'CPU') as wait_event,
           count(*)                               as sesiones
      from sys.dm_exec_requests r
      join sys.dm_exec_sessions s on s.session_id = r.session_id
     where s.is_user_process = 1
     group by isnull(nullif(r.wait_type, ''), 'CPU')`,
  toSamples: (rows) =>
    rows.map((row) => {
      const evento = str(row['wait_event'], 'CPU');
      return {
        metric: 'wait_event_sessions',
        value: num(row['sesiones']),
        // La familia se deriva del prefijo, que es la convención de SQL Server:
        // PAGEIOLATCH_* es disco, LCK_* es bloqueo, WRITELOG es log.
        labels: { wait_event_type: waitFamily(evento), wait_event: evento },
      };
    }),
};

/** Familia de una espera de SQL Server a partir de su prefijo. */
function waitFamily(evento: string): string {
  if (evento === 'CPU') return 'CPU';
  if (evento.startsWith('PAGEIOLATCH')) return 'IO';
  if (evento.startsWith('LCK_')) return 'Lock';
  if (evento.startsWith('LATCH_') || evento.startsWith('PAGELATCH')) return 'Latch';
  if (evento === 'WRITELOG' || evento.startsWith('LOGBUFFER')) return 'WAL';
  if (evento.startsWith('RESOURCE_SEMAPHORE')) return 'Memoria';
  if (evento.startsWith('CXPACKET') || evento.startsWith('EXCHANGE')) return 'Paralelismo';
  if (evento.startsWith('ASYNC_NETWORK')) return 'Cliente';
  if (evento.startsWith('HADR') || evento.startsWith('DBMIRROR')) return 'Replicación';
  if (evento.startsWith('BACKUP')) return 'Respaldo';
  return 'Otro';
}

/**
 * Throughput y eficiencia, desde los contadores de rendimiento.
 *
 * `cntr_type = 272696576` son acumulados (van con `counter: true`);
 * `65792` son instantáneas. Es la distinción que hace que las gráficas digan la
 * verdad, y por eso el filtro va por nombre exacto y no por LIKE.
 */
const throughput: ForeignCollector = {
  id: 'mssql_throughput',
  tier: 'fast',
  description: 'Transacciones, DML, expectativa de vida de página y latch waits',
  sql: () => `
    select rtrim(counter_name) as contador, rtrim(instance_name) as instancia,
           cntr_value          as valor,
           cntr_type           as tipo
      from sys.dm_os_performance_counters
     where (object_name like '%:SQL Statistics%' and counter_name in (
             'Batch Requests/sec', 'SQL Compilations/sec', 'SQL Re-Compilations/sec'))
        or (object_name like '%:Buffer Manager%' and counter_name in (
             'Page life expectancy', 'Buffer cache hit ratio', 'Buffer cache hit ratio base',
             'Page reads/sec', 'Page writes/sec', 'Checkpoint pages/sec', 'Lazy writes/sec'))
        or (object_name like '%:General Statistics%' and counter_name in (
             'User Connections', 'Processes blocked', 'Logins/sec', 'Logouts/sec',
             'Temp Tables Creation Rate'))
        or (object_name like '%:Locks%' and instance_name = '_Total' and counter_name in (
             'Lock Waits/sec', 'Number of Deadlocks/sec', 'Lock Timeouts/sec', 'Lock Wait Time (ms)'))
        or (object_name like '%:Access Methods%' and counter_name in (
             'Full Scans/sec', 'Index Searches/sec', 'Page Splits/sec',
             'Workfiles Created/sec', 'Worktables Created/sec'))
        or (object_name like '%:Memory Manager%' and counter_name in (
             'Memory Grants Pending', 'Target Server Memory (KB)', 'Total Server Memory (KB)'))
        or (object_name like '%:Databases%' and instance_name = '_Total' and counter_name in (
             'Transactions/sec', 'Write Transactions/sec', 'Log Bytes Flushed/sec',
             'Log Flush Waits/sec', 'Log Growths', 'Log Shrinks'))`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    // Nombre de Búho por contador. Los que miden lo mismo que en PostgreSQL
    // llevan su nombre para que las pantallas comunes funcionen.
    const nombres: Record<string, string> = {
      'Batch Requests/sec': 'queries_total',
      'SQL Compilations/sec': 'sql_compilations',
      'SQL Re-Compilations/sec': 'sql_recompilations',
      'Page life expectancy': 'page_life_expectancy_seconds',
      'Page reads/sec': 'db_blks_read',
      'Page writes/sec': 'pages_written',
      'Checkpoint pages/sec': 'checkpoint_buffers_written',
      'Lazy writes/sec': 'lazy_writes',
      'User Connections': 'user_connections',
      'Processes blocked': 'processes_blocked',
      'Logins/sec': 'logins',
      'Logouts/sec': 'logouts',
      'Temp Tables Creation Rate': 'temp_tables_created',
      'Lock Waits/sec': 'lock_waits',
      'Number of Deadlocks/sec': 'db_deadlocks',
      'Lock Timeouts/sec': 'lock_timeouts',
      'Lock Wait Time (ms)': 'lock_wait_time_ms',
      'Full Scans/sec': 'full_scans',
      'Index Searches/sec': 'index_searches',
      'Page Splits/sec': 'page_splits',
      'Workfiles Created/sec': 'workfiles_created',
      'Worktables Created/sec': 'worktables_created',
      'Memory Grants Pending': 'memory_grants_pending',
      'Target Server Memory (KB)': 'target_server_memory_bytes',
      'Total Server Memory (KB)': 'total_server_memory_bytes',
      'Transactions/sec': 'db_xact_commit',
      'Write Transactions/sec': 'write_transactions',
      'Log Bytes Flushed/sec': 'wal_bytes',
      'Log Flush Waits/sec': 'log_flush_waits',
      'Log Growths': 'log_growths',
      'Log Shrinks': 'log_shrinks',
    };

    let cacheHits = 0;
    let cacheBase = 0;

    for (const row of rows) {
      const contador = str(row['contador'], '');
      const valor = num(row['valor']);
      const tipo = num(row['tipo']);

      if (contador === 'Buffer cache hit ratio') {
        cacheHits = valor;
        continue;
      }
      if (contador === 'Buffer cache hit ratio base') {
        cacheBase = valor;
        continue;
      }

      const metric = nombres[contador];
      if (!metric) continue;

      // Los KB del contador se guardan en bytes: la consola formatea bytes y no
      // tiene por qué saber en qué unidad los publica cada motor.
      const escala = contador.includes('(KB)') ? 1024 : 1;
      samples.push({
        metric,
        value: valor * escala,
        // 272696576 = contador acumulado desde el arranque. El resto son
        // instantáneas y derivarles una tasa daría ruido.
        counter: tipo === 272_696_576,
      });
    }

    // El "hit ratio" de SQL Server viene como par valor/base, no como
    // porcentaje: hay que dividir. Se publica con el nombre de PostgreSQL.
    if (cacheBase > 0) {
      samples.push({ metric: 'db_cache_hit_pct', value: (cacheHits / cacheBase) * 100 });
    }

    return samples;
  },
};

/**
 * DML aproximado vía estadísticas de índices operativos.
 * Emite los mismos nombres que PostgreSQL/Maria (`db_tup_*`) para que Overview
 * y Análisis compartan paneles sin ramas por motor.
 */
const dml: ForeignCollector = {
  id: 'mssql_dml',
  tier: 'fast',
  description: 'Inserts / updates / deletes (index operational stats, instance-wide)',
  sql: () => `
    select sum(cast(leaf_insert_count as bigint)) as inserted,
           sum(cast(leaf_update_count as bigint)) as updated,
           sum(cast(leaf_delete_count as bigint)) as deleted
      from sys.dm_db_index_operational_stats(null, null, null, null)`,
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [];
    return [
      { metric: 'db_tup_inserted', value: num(row['inserted']), counter: true },
      { metric: 'db_tup_updated', value: num(row['updated']), counter: true },
      { metric: 'db_tup_deleted', value: num(row['deleted']), counter: true },
    ];
  },
};

/**
 * Memoria del sistema operativo y del proceso.
 *
 * Es lo más cercano a las métricas de host que Búho recoge por SSH en
 * PostgreSQL, con la ventaja de que acá no hace falta acceso al servidor: SQL
 * Server publica la memoria física de la máquina y su propio consumo.
 */
const memory: ForeignCollector = {
  id: 'mssql_memory',
  tier: 'normal',
  description: 'Memoria física de la máquina y consumo del motor',
  sql: () => `
    select m.total_physical_memory_kb     * 1024 as total_bytes,
           m.available_physical_memory_kb * 1024 as available_bytes,
           m.total_page_file_kb           * 1024 as page_file_bytes,
           m.available_page_file_kb       * 1024 as page_file_available_bytes,
           case when m.system_low_memory_signal_state = 1 then 1 else 0 end as low_memory_signal,
           p.physical_memory_in_use_kb    * 1024 as process_bytes,
           p.memory_utilization_percentage       as process_memory_pct,
           i.cpu_count                           as cpu_count
      from sys.dm_os_sys_memory m
     cross join sys.dm_os_process_memory p
     cross join sys.dm_os_sys_info i`,
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const total = num(row['total_bytes']);
    const disponible = num(row['available_bytes']);

    const samples: Sample[] = [
      // Mismos nombres que las métricas de host de PostgreSQL: la pantalla de
      // memoria del resumen no necesita saber de dónde vino el número.
      { metric: 'host_mem_total_bytes', value: total },
      { metric: 'host_mem_available_bytes', value: disponible },
      { metric: 'mssql_process_memory_bytes', value: num(row['process_bytes']) },
      { metric: 'mssql_low_memory_signal', value: num(row['low_memory_signal']) },
    ];
    if (total > 0) {
      samples.push({ metric: 'host_mem_used_pct', value: ((total - disponible) / total) * 100 });
    }
    return samples;
  },
};

/**
 * CPU consumida por el motor.
 *
 * La fuente clásica es el anillo `RING_BUFFER_SCHEDULER_MONITOR`, y en Linux
 * **no sirve**: publica ProcessUtilization y SystemIdle en cero, así que un
 * `100 - idle` daría un 100 % de CPU permanente y falso. Se usan en su lugar los
 * milisegundos de CPU acumulados del proceso, que existen en las dos
 * plataformas; el porcentaje lo deriva el DeltaEngine contra el tiempo
 * transcurrido y la cantidad de núcleos.
 *
 * Lo que esto **no** mide es la CPU del resto de la máquina. Un SQL Server que
 * comparte servidor con otra cosa se ve al 30 % acá y la máquina puede estar al
 * 95 %; para eso siguen estando las métricas de host por SSH.
 */
const cpu: ForeignCollector = {
  id: 'mssql_cpu',
  tier: 'normal',
  description: 'CPU consumida por el motor',
  sql: () => `
    select process_kernel_time_ms + process_user_time_ms as cpu_ms,
           process_kernel_time_ms                        as cpu_kernel_ms,
           process_user_time_ms                          as cpu_user_ms,
           cpu_count                                     as nucleos
      from sys.dm_os_sys_info`,
  toSamples: (rows) => {
    const row = rows[0];
    if (!row) return [];
    return [
      // Acumulados: el delta por segundo dividido por 10 y por los núcleos da el
      // porcentaje. Se publica el crudo y la consola hace la cuenta, para no
      // guardar un porcentaje calculado sobre un intervalo que quizá se perdió.
      { metric: 'mssql_cpu_ms', value: num(row['cpu_ms']), counter: true },
      { metric: 'mssql_cpu_kernel_ms', value: num(row['cpu_kernel_ms']), counter: true },
      { metric: 'host_cpu_count', value: num(row['nucleos']) },
    ];
  },
};

/**
 * Latencia de disco por archivo de base de datos.
 *
 * Esto es lo que SQL Server tiene y PostgreSQL no: milisegundos reales de
 * espera por lectura y por escritura, archivo por archivo. Es la respuesta
 * directa a "¿el disco es el problema?" y la razón por la que vale la pena
 * tener un colector propio para este motor en vez de un molde común.
 */
const fileIo: ForeignCollector = {
  id: 'mssql_file_io',
  tier: 'normal',
  description: 'Latencia y volumen de I/O por archivo',
  sql: () => `
    select db_name(f.database_id)                as db,
           case when mf.type = 1 then 'log' else 'datos' end as tipo,
           sum(f.num_of_reads)                   as lecturas,
           sum(f.num_of_writes)                  as escrituras,
           sum(f.num_of_bytes_read)              as bytes_leidos,
           sum(f.num_of_bytes_written)           as bytes_escritos,
           sum(f.io_stall_read_ms)               as stall_lectura_ms,
           sum(f.io_stall_write_ms)              as stall_escritura_ms
      from sys.dm_io_virtual_file_stats(null, null) f
      join sys.master_files mf
        on mf.database_id = f.database_id and mf.file_id = f.file_id
     where db_name(f.database_id) is not null
     group by db_name(f.database_id), case when mf.type = 1 then 'log' else 'datos' end`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { database: str(row['db']), file_type: str(row['tipo']) };
      // Todos acumulados desde el arranque: el DeltaEngine deriva la tasa, y de
      // ahí sale la latencia media del intervalo dividiendo stall entre ops.
      for (const [metric, columna] of [
        ['file_reads', 'lecturas'],
        ['file_writes', 'escrituras'],
        ['file_bytes_read', 'bytes_leidos'],
        ['file_bytes_written', 'bytes_escritos'],
        ['file_read_stall_ms', 'stall_lectura_ms'],
        ['file_write_stall_ms', 'stall_escritura_ms'],
      ] as const) {
        samples.push({ metric, value: num(row[columna]), labels, counter: true });
      }

      // La latencia media acumulada también se guarda directa: es la que un DBA
      // compara contra el umbral de 20 ms sin tener que mirar una derivada.
      const lecturas = num(row['lecturas']);
      const escrituras = num(row['escrituras']);
      if (lecturas > 0) {
        samples.push({ metric: 'file_read_latency_ms', value: num(row['stall_lectura_ms']) / lecturas, labels });
      }
      if (escrituras > 0) {
        samples.push({ metric: 'file_write_latency_ms', value: num(row['stall_escritura_ms']) / escrituras, labels });
      }
    }
    return samples;
  },
};

const databaseSizes: ForeignCollector = {
  id: 'mssql_database_sizes',
  tier: 'slow',
  description: 'Tamaño de datos y de log por base, y uso del log',
  sql: () => `
    select db_name(mf.database_id)                                     as db,
           sum(case when mf.type = 1 then 0 else mf.size end) * 8192.0  as data_bytes,
           sum(case when mf.type = 1 then mf.size else 0 end) * 8192.0  as log_bytes,
           max(d.recovery_model_desc)                                   as recovery_model,
           max(d.state_desc)                                            as estado,
           max(case when d.log_reuse_wait_desc = 'NOTHING' then 0 else 1 end) as log_bloqueado
      from sys.master_files mf
      join sys.databases d on d.database_id = mf.database_id
     where mf.database_id > 4
     group by db_name(mf.database_id)`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { database: str(row['db']) };
      const datos = num(row['data_bytes']);
      const log = num(row['log_bytes']);
      samples.push({ metric: 'database_size_bytes', value: datos + log, labels });
      samples.push({ metric: 'database_data_bytes', value: datos, labels });
      samples.push({ metric: 'database_log_bytes', value: log, labels });
      // Un log que no se puede reutilizar es el camino más corto a un disco
      // lleno, y el motivo (una transacción abierta, una réplica atrasada, un
      // backup pendiente) aparece en el inventario.
      samples.push({ metric: 'database_log_reuse_blocked', value: num(row['log_bloqueado']), labels });
      samples.push({ metric: 'database_online', value: str(row['estado']) === 'ONLINE' ? 1 : 0, labels });
    }
    return samples;
  },
};

const tableSizes: ForeignCollector = {
  id: 'mssql_table_sizes',
  tier: 'slow',
  description: 'Tablas más grandes de la base conectada',
  sql: () => `
    select top 20
           s.name  as esquema,
           t.name  as tabla,
           sum(case when i.index_id <= 1 then a.total_pages else 0 end) * 8192.0 as data_bytes,
           sum(case when i.index_id  > 1 then a.total_pages else 0 end) * 8192.0 as index_bytes,
           sum(a.total_pages - a.used_pages) * 8192.0                            as free_bytes,
           max(p.filas)                                                          as filas
      from sys.tables t
      join sys.schemas s      on s.schema_id = t.schema_id
      join sys.indexes i      on i.object_id = t.object_id
      join sys.partitions pa  on pa.object_id = i.object_id and pa.index_id = i.index_id
      join sys.allocation_units a on a.container_id = pa.partition_id
      outer apply (
        select sum(rows) as filas from sys.partitions
         where object_id = t.object_id and index_id <= 1
      ) p
     group by s.name, t.name
     order by sum(a.total_pages) desc`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const labels = { schema: str(row['esquema']), table: str(row['tabla']) };
      const datos = num(row['data_bytes']);
      const indices = num(row['index_bytes']);
      samples.push({ metric: 'table_total_bytes', value: datos + indices, labels });
      samples.push({ metric: 'table_index_bytes', value: indices, labels });
      samples.push({ metric: 'table_free_bytes', value: num(row['free_bytes']), labels });
      samples.push({ metric: 'table_live_tuples', value: num(row['filas']), labels });
    }
    return samples;
  },
};

/**
 * Always On: retraso de las réplicas.
 *
 * `redo_queue_size` y `log_send_queue_size` en KB son lo que importa cuando el
 * retraso en segundos se queda corto —una réplica sincrónica tiene cero
 * segundos de retraso y puede tener una cola de redo de gigas—.
 */
const alwaysOn: ForeignCollector = {
  id: 'mssql_always_on',
  tier: 'normal',
  description: 'Retraso y estado de las réplicas de Always On',
  appliesTo: (caps) => caps.features.alwaysOn,
  sql: () => `
    select ar.replica_server_name                     as replica,
           db_name(drs.database_id)                   as db,
           drs.synchronization_state_desc             as estado,
           drs.synchronization_health_desc            as salud,
           isnull(drs.log_send_queue_size, 0) * 1024  as envio_pendiente_bytes,
           isnull(drs.redo_queue_size, 0)     * 1024  as redo_pendiente_bytes,
           isnull(drs.secondary_lag_seconds, 0)       as lag_seconds,
           case when drs.is_local = 1 then 1 else 0 end as local
      from sys.dm_hadr_database_replica_states drs
      join sys.availability_replicas ar on ar.replica_id = drs.replica_id`,
  toSamples: (rows) => {
    const samples: Sample[] = [{ metric: 'replication_standbys', value: rows.filter((r) => num(r['local']) === 0).length }];
    for (const row of rows) {
      if (num(row['local']) === 1) continue;
      const labels = {
        standby: str(row['replica']),
        database: str(row['db']),
        state: str(row['estado']),
      };
      samples.push({ metric: 'replication_replay_lag_seconds', value: num(row['lag_seconds']), labels });
      samples.push({ metric: 'replication_send_queue_bytes', value: num(row['envio_pendiente_bytes']), labels });
      samples.push({ metric: 'replication_redo_queue_bytes', value: num(row['redo_pendiente_bytes']), labels });
      samples.push({
        metric: 'replication_healthy',
        value: str(row['salud']) === 'HEALTHY' ? 1 : 0,
        labels,
      });
    }
    return samples;
  },
};

export const MSSQL_COLLECTORS: ForeignCollector[] = [
  availability,
  connections,
  waits,
  throughput,
  dml,
  memory,
  cpu,
  fileIo,
  databaseSizes,
  tableSizes,
  alwaysOn,
];
