import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

/**
 * Chequeos de SQL Server.
 *
 * Los clásicos que un consultor cobra por revisar, y que casi siempre están mal
 * en instalaciones que nadie afinó: el modelo de recuperación con el log
 * creciendo sin respaldo, MAXDOP y el umbral de paralelismo en sus valores de
 * 1998, autoshrink encendido, autogrowth en porcentaje, y bases sin respaldo o
 * sin verificación de página.
 *
 * Un detalle que importa para no mentir: varias de estas DMV son por base de
 * datos y la conexión está en una sola. Se usa `sys.databases` y
 * `sys.master_files`, que son del servidor completo, en vez de recorrer bases;
 * los checks que sí necesitan estar dentro de la base lo dicen en el mensaje.
 */

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

/**
 * Opciones del servidor que casi nadie revisa y que cambian el rendimiento de
 * forma medible.
 */
const configuracionServidor: ForeignCheckDefinition = {
  id: 'mssql_server_config',
  title: 'Configuración del servidor',
  description: 'MAXDOP, umbral de paralelismo, memoria máxima y opciones de riesgo',
  sql: () => `
    select c.name, cast(c.value_in_use as bigint) as valor
      from sys.configurations c
     where c.name in ('max degree of parallelism', 'cost threshold for parallelism',
                      'max server memory (MB)', 'min server memory (MB)',
                      'optimize for ad hoc workloads', 'remote admin connections',
                      'xp_cmdshell', 'Ole Automation Procedures', 'clr enabled',
                      'priority boost', 'lightweight pooling', 'backup compression default')
     union all
    select 'cpu_count', cast(cpu_count as bigint) from sys.dm_os_sys_info
     union all
    select 'physical_memory_mb', cast(physical_memory_kb / 1024 as bigint) from sys.dm_os_sys_info
     union all
    select 'numa_nodes', cast(count(distinct memory_node_id) as bigint)
      from sys.dm_os_memory_nodes where memory_node_id < 64`,
  evaluate: (rows) => {
    const mapa = new Map<string, number>();
    for (const row of rows) mapa.set(text(row['name'], ''), num(row['valor']));
    const hallazgos: Finding[] = [];

    const nucleos = mapa.get('cpu_count') ?? 0;
    const maxdop = mapa.get('max degree of parallelism') ?? 0;
    const nodos = Math.max(1, mapa.get('numa_nodes') ?? 1);

    // MAXDOP 0 = sin límite. En un servidor de 24 núcleos, una consulta puede
    // tomar los 24 y dejar al resto esperando en CXPACKET.
    if (maxdop === 0 && nucleos > 8) {
      const sugerido = Math.min(8, Math.max(1, Math.floor(nucleos / nodos)));
      hallazgos.push({
        severity: 'warning',
        object: 'max degree of parallelism',
        message: `MAXDOP está en 0 (sin límite) con ${nucleos} núcleos: una sola consulta puede tomarlos todos.`,
        remediation:
          `Ponerlo en ${sugerido}: la recomendación de Microsoft es el número de núcleos por nodo NUMA, con techo de 8. ` +
          'Se cambia con sp_configure sin reiniciar.',
        value: nucleos,
      });
    }

    // El default de 5 es de 1998, cuando un servidor tenía un núcleo: hace que
    // consultas triviales se paralelicen y compitan entre sí.
    const umbral = mapa.get('cost threshold for parallelism') ?? 5;
    if (umbral <= 5) {
      hallazgos.push({
        severity: 'warning',
        object: 'cost threshold for parallelism',
        message: `el umbral de paralelismo está en ${umbral}, el valor por omisión desde 1998.`,
        remediation:
          'Subirlo a 50 y observar. Con 5, consultas baratas se paralelizan sin necesidad y generan esperas CXPACKET ' +
          'que parecen un problema de CPU. Se cambia con sp_configure sin reiniciar.',
      });
    }

    // Memoria máxima sin tope: el motor toma todo y deja al sistema operativo
    // sin nada, que en Linux termina en el OOM killer.
    const memoriaMax = mapa.get('max server memory (MB)') ?? 0;
    const memoriaFisica = mapa.get('physical_memory_mb') ?? 0;
    if (memoriaMax >= 2_147_483_647 && memoriaFisica > 0) {
      const sugerido = Math.max(1_024, memoriaFisica - Math.max(4_096, Math.floor(memoriaFisica * 0.1)));
      hallazgos.push({
        severity: 'critical',
        object: 'max server memory',
        message: `'max server memory' está sin tope con ${formatBytes(memoriaFisica * 1024 * 1024)} de RAM física.`,
        remediation:
          `Ponerlo en ${sugerido} MB para dejar memoria al sistema operativo. Sin tope, el motor crece hasta que el sistema ` +
          'empieza a paginar; en Linux el final habitual es que el kernel mate el proceso.',
      });
    }

    for (const [opcion, mensaje] of [
      ['xp_cmdshell', 'xp_cmdshell permite ejecutar comandos del sistema operativo desde SQL.'],
      ['Ole Automation Procedures', 'los procedimientos de automatización OLE amplían la superficie de ataque.'],
    ] as const) {
      if ((mapa.get(opcion) ?? 0) === 1) {
        hallazgos.push({
          severity: 'critical',
          object: opcion,
          message: `${opcion} está habilitado: ${mensaje}`,
          remediation: `Deshabilitarlo con sp_configure '${opcion}', 0; reconfigure. Si una tarea lo necesita, ejecutarla con un proxy de Agent y no dejarlo abierto.`,
        });
      }
    }

    if ((mapa.get('optimize for ad hoc workloads') ?? 0) === 0) {
      hallazgos.push({
        severity: 'info',
        object: 'optimize for ad hoc workloads',
        message: 'la optimización para cargas ad hoc está apagada: los planes de consultas que se ejecutan una sola vez llenan la caché.',
        remediation:
          'Encenderla si la aplicación manda SQL sin parametrizar. Guarda sólo un resumen del plan la primera vez, y el plan ' +
          'completo cuando la consulta se repite.',
      });
    }

    if ((mapa.get('priority boost') ?? 0) === 1) {
      hallazgos.push({
        severity: 'warning',
        object: 'priority boost',
        message: 'priority boost está encendido: Microsoft recomienda no usarlo, puede dejar al sistema operativo sin CPU.',
        remediation: "Apagarlo con sp_configure 'priority boost', 0 y reiniciar el servicio.",
      });
    }

    return hallazgos;
  },
};

/**
 * Bases de datos: modelo de recuperación, respaldos, autoshrink y crecimiento.
 *
 * Es el check que más veces encuentra algo en una instalación real. El caso
 * clásico: base en FULL sin respaldo de log, con el archivo de log creciendo
 * hasta llenar el disco, y nadie se dio cuenta porque "los respaldos completos
 * corren todas las noches".
 */
const basesDeDatos: ForeignCheckDefinition = {
  id: 'mssql_databases',
  title: 'Opciones y respaldos de las bases',
  description: 'Modelo de recuperación, respaldo de log, autoshrink y verificación de página',
  sql: () => `
    select d.name                              as db,
           d.recovery_model_desc               as modelo,
           d.state_desc                        as estado,
           d.is_auto_shrink_on                 as autoshrink,
           d.is_auto_close_on                  as autoclose,
           d.page_verify_option_desc           as verificacion,
           d.log_reuse_wait_desc               as log_espera,
           d.is_read_committed_snapshot_on     as rcsi,
           d.compatibility_level               as compatibilidad,
           (select cast(serverproperty('ProductMajorVersion') as int))          as version_mayor,
           (select isnull(sum(case when mf.type = 1 then mf.size else 0 end), 0) * 8192.0
              from sys.master_files mf where mf.database_id = d.database_id)    as log_bytes,
           (select isnull(sum(case when mf.type = 0 then mf.size else 0 end), 0) * 8192.0
              from sys.master_files mf where mf.database_id = d.database_id)    as data_bytes,
           (select max(b.backup_finish_date) from msdb.dbo.backupset b
             where b.database_name = d.name and b.type = 'D')                   as ultimo_full,
           (select max(b.backup_finish_date) from msdb.dbo.backupset b
             where b.database_name = d.name and b.type = 'L')                   as ultimo_log,
           (select count(*) from sys.master_files mf
             where mf.database_id = d.database_id
               and mf.is_percent_growth = 1)                                    as archivos_pct,
           (select count(*) from sys.master_files mf
             where mf.database_id = d.database_id
               and mf.is_percent_growth = 0 and mf.growth * 8 < 65536
               and mf.type = 0)                                                 as archivos_crecimiento_chico
      from sys.databases d
     where d.database_id > 4 and d.source_database_id is null`,
  evaluate: (rows) => {
    const hallazgos: Finding[] = [];
    const ahora = Date.now();

    for (const row of rows) {
      const db = text(row['db']);
      const modelo = text(row['modelo']);
      const estado = text(row['estado']);

      if (estado !== 'ONLINE') {
        hallazgos.push({
          severity: estado === 'RESTORING' ? 'info' : 'critical',
          object: db,
          message: `la base está en estado ${estado}.`,
          remediation:
            estado === 'RESTORING'
              ? 'Es lo normal en una réplica de log shipping o en un restore en curso. Si no es ninguno de los dos, alguien dejó un restore a medias.'
              : 'Una base que no está ONLINE no atiende consultas. Revisar el log de errores del motor para ver por qué.',
        });
        // En una base que no está en línea, el resto de las preguntas no aplica.
        continue;
      }

      const ultimoFull = row['ultimo_full'] ? new Date(String(row['ultimo_full'])).getTime() : null;
      const ultimoLog = row['ultimo_log'] ? new Date(String(row['ultimo_log'])).getTime() : null;

      if (ultimoFull === null) {
        hallazgos.push({
          severity: 'critical',
          object: db,
          message: 'nunca se le hizo un respaldo completo.',
          remediation:
            'Programar un respaldo completo. Sin respaldo, la única recuperación posible es volver a crear los datos a mano.',
        });
      } else {
        const horas = (ahora - ultimoFull) / 3_600_000;
        if (horas > 24 * 8) {
          hallazgos.push({
            severity: 'critical',
            object: db,
            message: `el último respaldo completo fue hace ${formatDuration((horas * 3600))}.`,
            remediation: 'Revisar el job de respaldos: dejó de correr o está fallando en silencio.',
            value: horas,
          });
        }
      }

      // El caso clásico: FULL sin respaldo de log. El log crece para siempre.
      if (modelo === 'FULL' || modelo === 'BULK_LOGGED') {
        const esperaLog = text(row['log_espera'], 'NOTHING');
        if (ultimoLog === null) {
          hallazgos.push({
            severity: 'critical',
            object: db,
            message:
              `está en modelo ${modelo} y nunca tuvo respaldo de log: el archivo de log crece sin límite y no se puede truncar.`,
            remediation:
              'Dos caminos honestos: si se necesita recuperar a un punto en el tiempo, programar respaldos de log cada 15 ' +
              'minutos; si no se necesita, pasar la base a SIMPLE. Dejarla en FULL sin respaldo de log es lo peor de los dos mundos.',
          });
        } else {
          const horasLog = (ahora - ultimoLog) / 3_600_000;
          if (horasLog > 24) {
            hallazgos.push({
              severity: 'warning',
              object: db,
              message: `en modelo ${modelo} con el último respaldo de log hace ${formatDuration(horasLog * 3600)}.`,
              remediation:
                'Con esa frecuencia, la ventana de pérdida real es de un día entero, no de los 15 minutos que suele suponer el negocio.',
              value: horasLog,
            });
          }
        }

        if (esperaLog === 'LOG_BACKUP' && num(row['log_bytes']) > num(row['data_bytes'])) {
          hallazgos.push({
            severity: 'warning',
            object: db,
            message:
              `el log (${formatBytes(num(row['log_bytes']))}) es más grande que los datos ` +
              `(${formatBytes(num(row['data_bytes']))}) y está esperando un respaldo de log.`,
            remediation:
              'Respaldar el log para que el espacio se pueda reutilizar, y después reducir el archivo una única vez con ' +
              'DBCC SHRINKFILE. Reducirlo sin respaldar no libera nada.',
          });
        } else if (esperaLog !== 'NOTHING' && esperaLog !== '(desconocido)') {
          hallazgos.push({
            severity: 'info',
            object: db,
            message: `el log no se puede reutilizar: está esperando ${esperaLog}.`,
            remediation:
              'ACTIVE_TRANSACTION es una transacción abierta; REPLICATION es la replicación atrasada; AVAILABILITY_REPLICA ' +
              'es una réplica sin sincronizar. Mientras eso siga, el log sólo puede crecer.',
          });
        }
      }

      if (row['autoshrink'] === true || num(row['autoshrink']) === 1) {
        hallazgos.push({
          severity: 'critical',
          object: db,
          message: 'autoshrink está encendido.',
          remediation:
            'Apagarlo: ALTER DATABASE [' + db + '] SET AUTO_SHRINK OFF. Reduce el archivo, fragmenta todos los índices y ' +
            'después el archivo vuelve a crecer; es el ciclo que más CPU y disco desperdicia sin dar nada a cambio.',
        });
      }

      if (row['autoclose'] === true || num(row['autoclose']) === 1) {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: 'auto_close está encendido: la base se cierra al quedar sin conexiones y la siguiente paga el arranque.',
          remediation: `ALTER DATABASE [${db}] SET AUTO_CLOSE OFF.`,
        });
      }

      const verificacion = text(row['verificacion']);
      if (verificacion !== 'CHECKSUM') {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: `page_verify está en ${verificacion} en vez de CHECKSUM: la corrupción de una página puede pasar inadvertida.`,
          remediation:
            `ALTER DATABASE [${db}] SET PAGE_VERIFY CHECKSUM. Se aplica a las páginas que se escriban desde entonces, ` +
            'así que conviene además correr un DBCC CHECKDB completo.',
        });
      }

      if (num(row['archivos_pct']) > 0) {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: `${num(row['archivos_pct'])} archivo(s) crecen por porcentaje.`,
          remediation:
            'Cambiar el crecimiento a un tamaño fijo (256 MB para datos, 512 MB para log). Con porcentaje, cada crecimiento ' +
            'es más grande que el anterior y la pausa que provoca crece con la base.',
        });
      }

      if (num(row['archivos_crecimiento_chico']) > 0) {
        hallazgos.push({
          severity: 'info',
          object: db,
          message: `${num(row['archivos_crecimiento_chico'])} archivo(s) de datos crecen en bloques menores a 64 MB.`,
          remediation:
            'Subir el incremento a 256 MB: con bloques chicos el archivo crece cientos de veces y cada crecimiento es una ' +
            'pausa de escritura, además de fragmentar el archivo en el sistema de archivos.',
        });
      }

      // Un nivel de compatibilidad viejo mantiene el optimizador antiguo: la
      // instancia se actualizó pero la base sigue planificando como antes.
      const compat = num(row['compatibilidad']);
      const mayor = num(row['version_mayor']);
      if (mayor > 0 && compat > 0 && compat < mayor * 10) {
        hallazgos.push({
          severity: 'info',
          object: db,
          message: `nivel de compatibilidad ${compat} en un motor ${mayor}.x: el optimizador se comporta como una versión vieja.`,
          remediation:
            `Subirlo a ${mayor * 10} con Query Store encendido primero, para poder forzar el plan viejo si alguna consulta ` +
            'empeora. Es la razón por la que muchas actualizaciones no rinden lo que prometían.',
        });
      }
    }

    return hallazgos;
  },
};

/**
 * Esperas acumuladas, filtrando las benignas.
 *
 * La lista de esperas ignorables no es opinión: son las de procesos internos
 * que esperan siempre (el hilo del checkpoint, los hilos de espera de tareas
 * ociosas) y que ocupan los primeros lugares en cualquier servidor sano. Sin
 * filtrarlas, el check informa siempre lo mismo y no sirve para nada.
 */
const esperas: ForeignCheckDefinition = {
  id: 'mssql_waits',
  title: 'Esperas dominantes',
  description: 'A qué se le va el tiempo el motor, sin contar las esperas ociosas',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    with utiles as (
      select wait_type, wait_time_ms, waiting_tasks_count,
             signal_wait_time_ms
        from sys.dm_os_wait_stats
       where waiting_tasks_count > 0
         and wait_type not in (
           'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK',
           'SLEEP_SYSTEMTASK','SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE',
           'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT',
           'BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
           'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT',
           'XE_DISPATCHER_JOIN','SQLTRACE_INCREMENTAL_FLUSH_SLEEP','ONDEMAND_TASK_QUEUE',
           'BROKER_EVENTHANDLER','SLEEP_BPOOL_FLUSH','SLEEP_DBSTARTUP','SLEEP_DCOMSTARTUP',
           'HADR_FILESTREAM_IOMGR_IOCOMPLETION','DIRTY_PAGE_POLL','SP_SERVER_DIAGNOSTICS_SLEEP',
           'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE','QDS_SHUTDOWN_QUEUE',
           'HADR_WORK_QUEUE','HADR_TIMER_TASK','HADR_CLUSAPI_CALL','PREEMPTIVE_XE_GETTARGETSTATE',
           'PWAIT_ALL_COMPONENTS_INITIALIZED','PARALLEL_REDO_WORKER_WAIT_WORK',
           'PARALLEL_REDO_DRAIN_WORKER','PARALLEL_REDO_LOG_CACHE','PARALLEL_REDO_TRAN_LIST',
           'PARALLEL_REDO_WORKER_SYNC','SOS_WORK_DISPATCHER','VDI_CLIENT_OTHER',
           'BROKER_RECEIVE_WAITFOR','SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY',
           'SLEEP_MASTERUPGRADED','MSSQL_XP','WAIT_XTP_HOST_WAIT','WAIT_XTP_OFFLINE_CKPT_NEW_LOG',
           'WAIT_XTP_CKPT_CLOSE','PREEMPTIVE_OS_FLUSHFILEBUFFERS','PREEMPTIVE_OS_WRITEFILEGATHER',
           -- Tareas de fondo que esperan por diseño. PWAIT_EXTENSIBILITY_CLEANUP_TASK
           -- domina la lista en cualquier instancia recién arrancada, con esperas
           -- de cinco minutos por vuelta, y no significa nada.
           'PWAIT_EXTENSIBILITY_CLEANUP_TASK','PWAIT_DIRECTLOGCONSUMER_GETNEXT',
           'STARTUP_DEPENDENCY_MANAGER','QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP',
           'QDS_DB_FLUSH_TASK_MAIN_LOOP_SLEEP','SLEEP_TEMPDBSTARTUP','BROKER_TRANSMITTER',
           'SERVER_IDLE_CHECK','FT_IFTSHC_MUTEX','PREEMPTIVE_XE_CALLBACKEXECUTE',
           'PREEMPTIVE_HADR_LEASE_MECHANISM','HADR_NOTIFICATION_DEQUEUE')
    )
    select top 5 wait_type, wait_time_ms, waiting_tasks_count,
           wait_time_ms * 100.0 / nullif((select sum(wait_time_ms) from utiles), 0) as pct,
           (select datediff(second, sqlserver_start_time, sysdatetime()) from sys.dm_os_sys_info) as uptime
      from utiles
     order by wait_time_ms desc`,
  evaluate: (rows) => {
    // Con poco tiempo desde el arranque, los acumulados no dicen nada: un
    // respaldo inicial puede dominar la lista durante horas.
    if (num(rows[0]?.['uptime']) < 7_200) return [];

    const hallazgos: Finding[] = [];
    // Qué significa cada espera y qué hacer, para las que de verdad aparecen.
    const guia: Record<string, { que: string; hacer: string }> = {
      PAGEIOLATCH_SH: {
        que: 'el motor espera a que el disco traiga páginas de datos para leer',
        hacer:
          'Es memoria o índices, no disco: con el buffer pool chico o un plan que hace scans, todo se lee de disco. ' +
          'Revisar las consultas con más lecturas lógicas antes de comprar discos.',
      },
      WRITELOG: {
        que: 'el motor espera a que se escriba el log de transacciones',
        hacer:
          'El log está en un disco lento o compartido con los datos. Moverlo a su propio volumen con la mejor latencia de ' +
          'escritura disponible; es la escritura más sensible de todo el motor.',
      },
      CXPACKET: {
        que: 'las ramas de una consulta paralela se esperan entre sí',
        hacer:
          'Casi siempre es el umbral de paralelismo en 5 y MAXDOP sin límite: consultas baratas se paralelizan sin ' +
          'necesidad. Subir el umbral a 50 antes de tocar nada más.',
      },
      RESOURCE_SEMAPHORE: {
        que: 'las consultas esperan una concesión de memoria para ordenar o hacer hash',
        hacer:
          'Hay consultas pidiendo memoria de más, normalmente por estimaciones malas. Es presión de memoria real: revisar ' +
          'las estadísticas y los planes con concesiones grandes.',
      },
      SOS_SCHEDULER_YIELD: {
        que: 'los hilos ceden el turno de CPU porque hay más trabajo que núcleos',
        hacer: 'Es presión de CPU. Buscar las consultas con más tiempo de CPU en la pantalla de consultas.',
      },
      LCK_M_X: { que: 'sesiones esperando un lock exclusivo', hacer: 'Ver la pantalla de bloqueos: hay contención de escritura.' },
      LCK_M_S: { que: 'sesiones esperando un lock compartido', hacer: 'Una escritura larga está bloqueando lecturas. Considerar READ_COMMITTED_SNAPSHOT.' },
      ASYNC_NETWORK_IO: {
        que: 'el motor espera a que el cliente reciba los datos que ya produjo',
        hacer:
          'No es el servidor: es la aplicación leyendo fila por fila, o la red. Traer menos filas o consumirlas más rápido.',
      },
      THREADPOOL: {
        que: 'no hay hilos de trabajo libres para atender peticiones',
        hacer:
          'Es grave: con esto el servidor deja de aceptar consultas nuevas. Suele venir de un bloqueo masivo que consume ' +
          'todos los hilos, no de falta de hilos.',
      },
    };

    for (const row of rows) {
      const tipo = text(row['wait_type']);
      const pct = num(row['pct']);
      if (pct < 20) continue;

      const conocida = guia[tipo];
      const esperas = num(row['waiting_tasks_count']);
      const mediaMs = esperas > 0 ? num(row['wait_time_ms']) / esperas : 0;

      // La lista de esperas ignorables nunca está completa: cada versión trae
      // tareas de fondo nuevas (AZURE_IMDS_VERSIONS apareció con SQL 2022) y
      // una sola espera de un minuto se lleva el 70 % del porcentaje en un
      // servidor tranquilo. El filtro estructural es la cantidad: lo que afecta
      // a las consultas de la aplicación se espera miles de veces, no una.
      if (esperas < 100) continue;

      hallazgos.push({
        severity: tipo === 'THREADPOOL' ? 'critical' : pct >= 50 ? 'warning' : 'info',
        object: tipo,
        message:
          `${formatPct(pct)} del tiempo de espera del servidor` +
          (conocida ? `: ${conocida.que}` : '') +
          ` (${esperas} esperas, ${mediaMs.toFixed(1)} ms de media).`,
        remediation:
          conocida?.hacer ??
          'Buscar el tipo de espera en la documentación de Microsoft: sin saber qué significa, cualquier cambio es a ciegas.',
        value: pct,
      });
    }

    return hallazgos;
  },
};

/**
 * Índices que sobran y que faltan.
 *
 * Los que faltan salen de `dm_db_missing_index_details`, que es una sugerencia
 * del optimizador y no un mandato: se reporta sólo cuando el beneficio estimado
 * es grande, y el mensaje dice explícitamente que hay que validarlo. Los que
 * sobran son los que sólo reciben escrituras, que es un costo puro.
 */
const indices: ForeignCheckDefinition = {
  id: 'mssql_indexes',
  title: 'Índices sin uso y faltantes',
  description: 'Índices que sólo cuestan escrituras, e índices que el optimizador pide',
  appliesTo: (caps) => caps.features.seesAllSessions,
  sql: () => `
    select 'sin_uso' as clase,
           quotename(s.name) + '.' + quotename(t.name) + ' / ' + i.name as objeto,
           us.user_updates                                              as escrituras,
           us.user_seeks + us.user_scans + us.user_lookups              as lecturas,
           null                                                          as beneficio,
           (select datediff(second, sqlserver_start_time, sysdatetime()) from sys.dm_os_sys_info) as uptime
      from sys.dm_db_index_usage_stats us
      join sys.indexes i on i.object_id = us.object_id and i.index_id = us.index_id
      join sys.tables  t on t.object_id = i.object_id
      join sys.schemas s on s.schema_id = t.schema_id
     where us.database_id = db_id()
       and i.is_primary_key = 0 and i.is_unique_constraint = 0 and i.type_desc <> 'CLUSTERED'
       and us.user_seeks + us.user_scans + us.user_lookups = 0
       and us.user_updates > 1000
    union all
    select top 5 'falta',
           quotename(object_schema_name(id.object_id)) + '.' + quotename(object_name(id.object_id)) +
             ' (' + isnull(id.equality_columns, '') +
             case when id.inequality_columns is null then '' else ', ' + id.inequality_columns end + ')',
           null, null,
           cast(gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans) as bigint),
           (select datediff(second, sqlserver_start_time, sysdatetime()) from sys.dm_os_sys_info)
      from sys.dm_db_missing_index_groups g
      join sys.dm_db_missing_index_group_stats gs on gs.group_handle = g.index_group_handle
      join sys.dm_db_missing_index_details id on id.index_handle = g.index_handle
     where id.database_id = db_id()
     order by 5 desc`,
  evaluate: (rows) => {
    // Los contadores de uso se vacían al reiniciar: con pocas horas de vida, un
    // índice "sin uso" puede ser sólo un índice que todavía no se usó.
    if (num(rows[0]?.['uptime']) < 86_400) return [];

    return rows.flatMap((row): Finding[] => {
      const objeto = text(row['objeto']);
      if (text(row['clase']) === 'sin_uso') {
        return [
          {
            severity: 'info',
            object: objeto,
            message: `${num(row['escrituras'])} escrituras y ninguna lectura desde el último reinicio.`,
            remediation:
              'Un índice así sólo cuesta: espacio, escrituras y tiempo de respaldo. Antes de borrarlo, confirmar que no lo ' +
              'use un proceso de fin de mes; deshabilitarlo (ALTER INDEX … DISABLE) permite volver atrás sin recrearlo.',
            value: num(row['escrituras']),
          },
        ];
      }
      return [
        {
          severity: 'info',
          object: objeto,
          message: `el optimizador estima un beneficio de ${num(row['beneficio']).toLocaleString('es')} si existiera este índice.`,
          remediation:
            'Es una sugerencia, no una receta: SQL Server propone un índice por consulta y sin mirar los que ya existen. ' +
            'Revisar si un índice existente se puede extender con esas columnas antes de crear uno nuevo.',
          value: num(row['beneficio']),
        },
      ];
    });
  },
};

/** Trabajos del Agent que fallan o que nadie mira. */
const jobs: ForeignCheckDefinition = {
  id: 'mssql_agent_jobs',
  title: 'Trabajos del Agent',
  description: 'Jobs deshabilitados, fallando o sin correr',
  sql: () => `
    select j.name                            as job,
           j.enabled                          as habilitado,
           h.run_status                       as estado,
           h.run_date                         as fecha,
           h.run_time                         as hora,
           h.message                          as mensaje,
           act.corriendo_desde                as corriendo_desde,
           act.ultimo_paso                    as ultimo_paso
      from msdb.dbo.sysjobs j
      outer apply (
        select top 1 hi.run_status, hi.run_date, hi.run_time, hi.message
          from msdb.dbo.sysjobhistory hi
         where hi.job_id = j.job_id and hi.step_id = 0
         order by hi.run_date desc, hi.run_time desc
      ) h
      outer apply (
        -- Un job que sigue corriendo todavía no escribió su fila de resumen en
        -- el historial: sin esto, los jobs de captura de CDC —que corren de
        -- forma continua— se reportaban como "nunca se ejecutó".
        select max(a.start_execution_date) as corriendo_desde,
               max(a.last_executed_step_date) as ultimo_paso
          from msdb.dbo.sysjobactivity a
         where a.job_id = j.job_id
      ) act`,
  evaluate: (rows) =>
    rows.flatMap((row): Finding[] => {
      const job = text(row['job']);
      const habilitado = row['habilitado'] === true || num(row['habilitado']) === 1;
      const estado = row['estado'] === null || row['estado'] === undefined ? null : num(row['estado']);

      if (!habilitado) {
        return [
          {
            severity: 'info',
            object: job,
            message: 'el trabajo está deshabilitado.',
            remediation:
              'Si ya no se necesita, borrarlo: un job deshabilitado que nadie recuerda es una tarea de mantenimiento que ' +
              'alguien cree que corre.',
          },
        ];
      }
      // run_status 0 = falló, 1 = éxito, 2 = reintento, 3 = cancelado.
      if (estado === 0) {
        return [
          {
            severity: 'critical',
            object: job,
            message: `la última ejecución falló: ${text(row['mensaje'], 'sin mensaje').slice(0, 300)}`,
            remediation: 'Revisar el historial del job en el Agent. Un job de respaldo que falla deja al servidor sin red de seguridad.',
          },
        ];
      }
      if (estado === null) {
        // Un job en marcha no tiene fila de resumen todavía. Eso no es un
        // problema, es un job trabajando.
        if (row['corriendo_desde'] || row['ultimo_paso']) return [];
        return [
          {
            severity: 'info',
            object: job,
            message: 'el trabajo está habilitado pero nunca se ejecutó.',
            remediation: 'Revisar que tenga una programación asignada: un job sin schedule sólo corre si alguien lo lanza a mano.',
          },
        ];
      }
      return [];
    }),
};

export const MSSQL_CHECKS: ForeignCheckDefinition[] = [
  configuracionServidor,
  basesDeDatos,
  esperas,
  indices,
  jobs,
];
