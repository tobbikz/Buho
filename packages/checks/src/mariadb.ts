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

function text(value: unknown, fallback = '(desconocido)'): string {
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
  title: 'Configuración y durabilidad',
  description: 'Durabilidad, buffer pool, binlog, timeouts y modo estricto',
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
        message: `innodb_flush_log_at_trx_commit = ${flush}: un corte de energía pierde hasta un segundo de transacciones ya confirmadas.`,
        remediation:
          'Poner innodb_flush_log_at_trx_commit=1 (se cambia en caliente con SET GLOBAL). ' +
          'El valor 2 sólo es defendible en réplicas de lectura o en un entorno de pruebas, y conviene dejarlo escrito.',
      });
    }

    const syncBinlog = v(mapa, 'SYNC_BINLOG');
    if (v(mapa, 'LOG_BIN').toUpperCase() === 'ON' && syncBinlog !== '1') {
      hallazgos.push({
        severity: 'warning',
        object: 'sync_binlog',
        message: `sync_binlog = ${syncBinlog} con binlog encendido: tras un corte, el binlog y los datos pueden quedar desalineados y la réplica sale corrupta.`,
        remediation: 'Poner sync_binlog=1. Con almacenamiento moderno el costo es pequeño y es el requisito para que una réplica sea confiable.',
      });
    }

    if (v(mapa, 'LOG_BIN').toUpperCase() !== 'ON') {
      hallazgos.push({
        severity: 'warning',
        object: 'log_bin',
        message: 'el binlog está apagado: no se puede recuperar a un punto en el tiempo ni agregar una réplica.',
        remediation:
          'Encender log_bin en my.cnf (requiere reinicio). Sin binlog el único respaldo posible es el volcado completo, ' +
          'y se pierde todo lo ocurrido desde el último volcado.',
      });
    }

    const formato = v(mapa, 'BINLOG_FORMAT').toUpperCase();
    if (formato && formato !== 'ROW') {
      hallazgos.push({
        severity: 'warning',
        object: 'binlog_format',
        message: `binlog_format = ${formato}: las sentencias no deterministas se replican distinto en la réplica y la desincronizan en silencio.`,
        remediation: 'Poner binlog_format=ROW (se cambia en caliente con SET GLOBAL binlog_format=ROW).',
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
            `el buffer pool acierta ${formatPct(aciertos)} de las lecturas y está en ` +
            `${formatBytes(num(v(mapa, 'INNODB_BUFFER_POOL_SIZE')))}: el motor está yendo a disco de forma sostenida.`,
          remediation:
            'Subir innodb_buffer_pool_size hasta que el conjunto de datos activo entre en memoria; en un servidor dedicado, ' +
            'entre 60 % y 75 % de la RAM. Se puede cambiar en caliente en MariaDB 10.2+ y el motor redimensiona por bloques.',
          value: aciertos,
        });
      }
    }

    if (s(mapa, 'INNODB_BUFFER_POOL_WAIT_FREE') > 100) {
      hallazgos.push({
        severity: 'warning',
        object: 'innodb_buffer_pool_wait_free',
        message: `${s(mapa, 'INNODB_BUFFER_POOL_WAIT_FREE')} esperas por página libre en el buffer pool: las escrituras no alcanzan a vaciarse.`,
        remediation:
          'Subir innodb_io_capacity e innodb_io_capacity_max al rango real del disco (en SSD, 2000 y 4000 son puntos de partida razonables).',
      });
    }

    // ------------------------------------------------------------ conexiones
    const maxConn = num(v(mapa, 'MAX_CONNECTIONS'));
    const usadas = s(mapa, 'MAX_USED_CONNECTIONS');
    if (maxConn > 0 && usadas / maxConn > 0.8) {
      hallazgos.push({
        severity: usadas / maxConn > 0.95 ? 'critical' : 'warning',
        object: 'max_connections',
        message: `el pico de conexiones llegó a ${usadas} de ${maxConn} (${formatPct((usadas / maxConn) * 100)}).`,
        remediation:
          'Poner un pool en la aplicación antes de subir max_connections: cada conexión reserva buffers de sesión ' +
          '(sort_buffer_size, join_buffer_size) y mil conexiones ociosas pueden costar gigas de RAM.',
        value: (usadas / maxConn) * 100,
      });
    }

    if (s(mapa, 'CONNECTION_ERRORS_MAX_CONNECTIONS') > 0) {
      hallazgos.push({
        severity: 'critical',
        object: 'connection_errors_max_connections',
        message: `${s(mapa, 'CONNECTION_ERRORS_MAX_CONNECTIONS')} conexión(es) rechazada(s) por llegar a max_connections: la aplicación ya vio errores.`,
        remediation: 'Revisar el pool de la aplicación y subir max_connections como medida temporal (se cambia en caliente).',
      });
    }

    const hilosCreados = s(mapa, 'THREADS_CREATED');
    const conexiones = s(mapa, 'CONNECTIONS');
    if (conexiones > 10_000 && hilosCreados / conexiones > 0.1) {
      hallazgos.push({
        severity: 'info',
        object: 'thread_cache_size',
        message: `se creó un hilo nuevo en ${formatPct((hilosCreados / conexiones) * 100)} de las conexiones: la caché de hilos no alcanza.`,
        remediation: 'Subir thread_cache_size a por lo menos el pico de conexiones concurrentes (se cambia en caliente).',
      });
    }

    // ------------------------------------------------------------- temporales
    const tmp = s(mapa, 'CREATED_TMP_TABLES');
    const tmpDisco = s(mapa, 'CREATED_TMP_DISK_TABLES');
    if (tmp > 1_000 && tmpDisco / tmp > 0.25) {
      hallazgos.push({
        severity: tmpDisco / tmp > 0.5 ? 'warning' : 'info',
        object: 'tmp_table_size',
        message: `${formatPct((tmpDisco / tmp) * 100)} de las tablas temporales terminan en disco (${tmpDisco} de ${tmp}).`,
        remediation:
          'Subir tmp_table_size y max_heap_table_size juntos (el límite efectivo es el menor de los dos). ' +
          'Si no baja, casi siempre hay un GROUP BY sobre una columna TEXT o BLOB, que va a disco sin importar el tamaño.',
        value: (tmpDisco / tmp) * 100,
      });
    }

    // ------------------------------------------------------------- bloqueos
    if (s(mapa, 'INNODB_DEADLOCKS') > 0) {
      hallazgos.push({
        severity: 'warning',
        object: 'deadlocks',
        message: `${s(mapa, 'INNODB_DEADLOCKS')} deadlock(s) desde el arranque.`,
        remediation:
          'El detalle del último está en la pantalla de log: InnoDB guarda el grafo completo con las dos consultas. ' +
          'La causa habitual es que dos transacciones toman las mismas filas en orden distinto.',
        value: s(mapa, 'INNODB_DEADLOCKS'),
      });
    }

    const esperaMedia = s(mapa, 'INNODB_ROW_LOCK_TIME_AVG');
    if (esperaMedia > 1_000) {
      hallazgos.push({
        severity: esperaMedia > 5_000 ? 'critical' : 'warning',
        object: 'innodb_row_lock_time_avg',
        message: `cada espera por lock de fila dura ${formatDuration(esperaMedia / 1000)} en promedio.`,
        remediation:
          'Buscar transacciones largas que tocan muchas filas. Un innodb_lock_wait_timeout más corto convierte una espera ' +
          'infinita en un error que la aplicación puede reintentar, pero no arregla la causa.',
        value: esperaMedia,
      });
    }

    // -------------------------------------------------------------- timeouts
    if (num(v(mapa, 'MAX_STATEMENT_TIME')) === 0) {
      hallazgos.push({
        severity: 'warning',
        object: 'max_statement_time',
        message: 'max_statement_time = 0: una consulta mal escrita puede correr para siempre y arrastrar al servidor.',
        remediation:
          'Poner max_statement_time con un techo generoso (por ejemplo 300 segundos) en el servidor, y ajustarlo por sesión ' +
          'para los procesos que de verdad necesitan más. Se cambia en caliente.',
      });
    }

    const esperaLock = num(v(mapa, 'INNODB_LOCK_WAIT_TIMEOUT'));
    if (esperaLock >= 300) {
      hallazgos.push({
        severity: 'info',
        object: 'innodb_lock_wait_timeout',
        message: `innodb_lock_wait_timeout = ${esperaLock}s: una sesión bloqueada espera cinco minutos antes de rendirse.`,
        remediation: 'Bajarlo a 10–50 segundos para que la aplicación reciba un error accionable en vez de quedarse colgada.',
      });
    }

    // ---------------------------------------------------------- observabilidad
    if (v(mapa, 'PERFORMANCE_SCHEMA').toUpperCase() !== 'ON' && v(mapa, 'PERFORMANCE_SCHEMA') !== '1') {
      hallazgos.push({
        severity: 'warning',
        object: 'performance_schema',
        message: 'performance_schema está apagado: no hay analítica de consultas, así que no se puede saber qué consulta consume el tiempo.',
        remediation:
          'Poner performance_schema=ON en my.cnf y reiniciar. El costo típico es de un 5 % de CPU y es lo que habilita ' +
          'la pantalla de consultas.',
      });
    }

    if (v(mapa, 'SLOW_QUERY_LOG').toUpperCase() !== 'ON' && v(mapa, 'SLOW_QUERY_LOG') !== '1') {
      hallazgos.push({
        severity: 'info',
        object: 'slow_query_log',
        message: 'el slow log está apagado: las consultas lentas no dejan rastro.',
        remediation:
          'Encender slow_query_log con long_query_time=1 y log_output=TABLE (todo en caliente); así Búho lo lee sin ' +
          'necesitar acceso al servidor.',
      });
    }

    // -------------------------------------------------------- modo estricto
    const sqlMode = v(mapa, 'SQL_MODE').toUpperCase();
    if (!sqlMode.includes('STRICT_')) {
      hallazgos.push({
        severity: 'warning',
        object: 'sql_mode',
        message: 'sql_mode no incluye STRICT_TRANS_TABLES: los datos que no caben se truncan en silencio en vez de dar error.',
        remediation:
          'Agregar STRICT_TRANS_TABLES a sql_mode (se cambia en caliente). Conviene probarlo primero: una aplicación vieja ' +
          'puede estar dependiendo del truncado.',
      });
    }

    if (v(mapa, 'INNODB_FILE_PER_TABLE').toUpperCase() === 'OFF') {
      hallazgos.push({
        severity: 'warning',
        object: 'innodb_file_per_table',
        message: 'innodb_file_per_table está apagado: todo vive en ibdata1, que nunca devuelve espacio al sistema de archivos.',
        remediation:
          'Encenderlo (en caliente) y reconstruir las tablas grandes con ALTER TABLE … FORCE para sacarlas del tablespace ' +
          'compartido. Es la única forma de recuperar disco al borrar datos.',
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
  title: 'Tablas sin clave primaria',
  description: 'Tablas InnoDB sin PK, que degradan la replicación por filas',
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
      message: `sin clave primaria, ${formatBytes(num(row['bytes']))} y ~${num(row['filas'])} filas.`,
      remediation:
        'Agregar una clave primaria. Con binlog_format=ROW, cada UPDATE o DELETE en la réplica recorre la tabla completa ' +
        'por cada fila cambiada, así que una tabla grande sin PK basta para dejar la réplica permanentemente atrasada.',
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
  title: 'Espacio reclamable en tablas',
  description: 'Tablas con mucho data_free, que ocupan disco sin usarlo',
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
        message: `${formatBytes(libre)} reclamables (${formatPct(pct)} del tamaño de la tabla).`,
        remediation:
          'OPTIMIZE TABLE la reconstruye y devuelve el espacio, pero bloquea escrituras en MariaDB sin ALGORITHM=INPLACE. ' +
          'La alternativa sin bloqueo es ALTER TABLE … FORCE, ALGORITHM=INPLACE, LOCK=NONE.',
        value: libre,
      };
    }),
};

/** Transacciones abiertas hace mucho: la causa raíz de la mitad de los bloqueos. */
const transaccionesViejas: ForeignCheckDefinition = {
  id: 'mariadb_long_transactions',
  title: 'Transacciones abiertas hace mucho',
  description: 'Transacciones que retienen locks y crecen el historial de undo',
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
        object: `hilo ${text(row['hilo'])}`,
        message:
          `transacción abierta hace ${formatDuration(segundos)} en estado ${text(row['estado'])}, ` +
          `${num(row['filas_bloqueadas'])} fila(s) bloqueada(s)` +
          (text(row['consulta'], '') ? `: ${text(row['consulta'])}` : ' sin consulta activa'),
        remediation:
          'Una transacción abierta impide purgar el historial de undo y bloquea a otras sesiones. Si no tiene consulta activa, ' +
          'es la aplicación que abrió BEGIN y no cerró: revisar el manejo de transacciones del pool antes de matar el hilo con KILL.',
        value: segundos,
      };
    }),
};

/** Réplica caída o atrasada, visto desde la réplica. */
const replicacion: ForeignCheckDefinition = {
  id: 'mariadb_replication',
  title: 'Salud de la replicación',
  description: 'Hilos de replicación y retraso frente al primario',
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
        object: !io ? 'hilo de IO' : 'hilo de SQL',
        message:
          `el hilo de ${!io ? 'IO' : 'SQL'} está detenido` +
          (errno > 0 ? `: error ${errno} — ${text(campo('Last_Error'), 'sin detalle')}` : '.'),
        remediation:
          'La réplica dejó de aplicar cambios y se atrasa desde este momento. Revisar el error y reanudar con ' +
          'START REPLICA; si el error es un conflicto de datos, saltarlo con GTID en vez de sql_slave_skip_counter.',
      });
    }

    const retraso = campo('Seconds_Behind_Master');
    if (retraso === null || retraso === undefined) {
      if (io && sql) {
        hallazgos.push({
          severity: 'warning',
          object: 'Seconds_Behind_Master',
          message: 'el retraso llega en NULL con los dos hilos corriendo: la réplica no sabe cuánto le falta.',
          remediation: 'Suele pasar justo después de arrancar la réplica. Si persiste, revisar la conexión con el primario.',
        });
      }
    } else if (num(retraso) > 60) {
      hallazgos.push({
        severity: num(retraso) > 600 ? 'critical' : 'warning',
        object: 'retraso',
        message: `la réplica está ${formatDuration(num(retraso))} atrás del primario.`,
        remediation:
          'La causa habitual es un solo hilo de aplicación contra un primario paralelo: subir slave_parallel_threads ' +
          'y usar slave_parallel_mode=optimistic. La otra causa clásica es una tabla grande sin clave primaria.',
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
