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

function text(value: unknown, fallback = '(unknown)'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

/**
 * Opciones del servidor que casi nadie revisa y que cambian el rendimiento de
 * forma medible.
 */
const configuracionServidor: ForeignCheckDefinition = {
  id: 'mssql_server_config',
  title: 'Server configuration',
  description: 'MAXDOP, parallelism threshold, max memory, and risky options',
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
        message: `MAXDOP is 0 (unlimited) with ${nucleos} cores: a single query can take them all.`,
        remediation:
          `Set it to ${sugerido}: Microsoft's recommendation is cores per NUMA node, capped at 8. ` +
          'Change with sp_configure without restart.',
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
        message: `parallelism cost threshold is ${umbral}, the default since 1998.`,
        remediation:
          'Raise it to 50 and observe. At 5, cheap queries parallelize unnecessarily and create CXPACKET waits ' +
          'that look like a CPU problem. Change with sp_configure without restart.',
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
        message: `'max server memory' is uncapped with ${formatBytes(memoriaFisica * 1024 * 1024)} of physical RAM.`,
        remediation:
          `Set it to ${sugerido} MB to leave memory for the OS. Uncapped, the engine grows until the system ` +
          'starts paging; on Linux the usual end is the kernel killing the process.',
      });
    }

    for (const [opcion, mensaje] of [
      ['xp_cmdshell', 'xp_cmdshell allows running OS commands from SQL.'],
      ['Ole Automation Procedures', 'OLE automation procedures expand the attack surface.'],
    ] as const) {
      if ((mapa.get(opcion) ?? 0) === 1) {
        hallazgos.push({
          severity: 'critical',
          object: opcion,
          message: `${opcion} is enabled: ${mensaje}`,
          remediation: `Disable with sp_configure '${opcion}', 0; reconfigure. If a job needs it, run it through an Agent proxy and do not leave it open.`,
        });
      }
    }

    if ((mapa.get('optimize for ad hoc workloads') ?? 0) === 0) {
      hallazgos.push({
        severity: 'info',
        object: 'optimize for ad hoc workloads',
        message: 'optimize for ad hoc workloads is off: plans for one-off queries fill the cache.',
        remediation:
          'Enable it if the application sends unparameterized SQL. It stores only a plan stub the first time, and the full ' +
          'plan when the query repeats.',
      });
    }

    if ((mapa.get('priority boost') ?? 0) === 1) {
      hallazgos.push({
        severity: 'warning',
        object: 'priority boost',
        message: 'priority boost is on: Microsoft recommends against it; it can starve the OS of CPU.',
        remediation: "Turn it off with sp_configure 'priority boost', 0 and restart the service.",
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
  title: 'Database options and backups',
  description: 'Recovery model, log backups, autoshrink, and page verification',
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
          message: `database is in state ${estado}.`,
          remediation:
            estado === 'RESTORING'
              ? 'Normal during log shipping or an in-progress restore. If neither applies, someone left a restore unfinished.'
              : 'A database that is not ONLINE does not serve queries. Check the engine error log for why.',
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
          message: 'no full backup has ever been taken.',
          remediation:
            'Schedule a full backup. Without a backup, the only recovery option is to recreate the data by hand.',
        });
      } else {
        const horas = (ahora - ultimoFull) / 3_600_000;
        if (horas > 24 * 8) {
          hallazgos.push({
            severity: 'critical',
            object: db,
            message: `last full backup was ${formatDuration((horas * 3600))} ago.`,
            remediation: 'Review the backup job: it stopped running or is failing silently.',
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
              `recovery model is ${modelo} and it has never had a log backup: the log file grows without limit and cannot be truncated.`,
            remediation:
              'Two honest paths: if point-in-time recovery is needed, schedule log backups every 15 ' +
              'minutes; if not, switch the database to SIMPLE. Leaving it in FULL without log backups is the worst of both worlds.',
          });
        } else {
          const horasLog = (ahora - ultimoLog) / 3_600_000;
          if (horasLog > 24) {
            hallazgos.push({
              severity: 'warning',
              object: db,
              message: `recovery model ${modelo} with last log backup ${formatDuration(horasLog * 3600)} ago.`,
              remediation:
                'At that frequency, the real loss window is a full day, not the 15 minutes the business usually assumes.',
              value: horasLog,
            });
          }
        }

        if (esperaLog === 'LOG_BACKUP' && num(row['log_bytes']) > num(row['data_bytes'])) {
          hallazgos.push({
            severity: 'warning',
            object: db,
            message:
              `log (${formatBytes(num(row['log_bytes']))}) is larger than data ` +
              `(${formatBytes(num(row['data_bytes']))}) and is waiting for a log backup.`,
            remediation:
              'Back up the log so space can be reused, then shrink the file once with ' +
              'DBCC SHRINKFILE. Shrinking without a backup frees nothing.',
          });
        } else if (esperaLog !== 'NOTHING' && esperaLog !== '(unknown)') {
          hallazgos.push({
            severity: 'info',
            object: db,
            message: `log cannot be reused: waiting for ${esperaLog}.`,
            remediation:
              'ACTIVE_TRANSACTION is an open transaction; REPLICATION is lagging replication; AVAILABILITY_REPLICA ' +
              'is an unsynchronized replica. While that persists, the log can only grow.',
          });
        }
      }

      if (row['autoshrink'] === true || num(row['autoshrink']) === 1) {
        hallazgos.push({
          severity: 'critical',
          object: db,
          message: 'autoshrink is on.',
          remediation:
            'Turn it off: ALTER DATABASE [' + db + '] SET AUTO_SHRINK OFF. It shrinks the file, fragments every index, ' +
            'and then the file grows again; it is the cycle that wastes the most CPU and disk for no benefit.',
        });
      }

      if (row['autoclose'] === true || num(row['autoclose']) === 1) {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: 'auto_close is on: the database closes when idle and the next connection pays startup cost.',
          remediation: `ALTER DATABASE [${db}] SET AUTO_CLOSE OFF.`,
        });
      }

      const verificacion = text(row['verificacion']);
      if (verificacion !== 'CHECKSUM') {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: `page_verify is ${verificacion} instead of CHECKSUM: page corruption can go unnoticed.`,
          remediation:
            `ALTER DATABASE [${db}] SET PAGE_VERIFY CHECKSUM. It applies to pages written from then on, ` +
            'so also run a full DBCC CHECKDB.',
        });
      }

      if (num(row['archivos_pct']) > 0) {
        hallazgos.push({
          severity: 'warning',
          object: db,
          message: `${num(row['archivos_pct'])} file(s) grow by percentage.`,
          remediation:
            'Change growth to a fixed size (256 MB for data, 512 MB for log). With percentage growth, each growth ' +
            'is larger than the previous one and the pause it causes grows with the database.',
        });
      }

      if (num(row['archivos_crecimiento_chico']) > 0) {
        hallazgos.push({
          severity: 'info',
          object: db,
          message: `${num(row['archivos_crecimiento_chico'])} data file(s) grow in blocks smaller than 64 MB.`,
          remediation:
            'Raise the increment to 256 MB: with small blocks the file grows hundreds of times and each growth is a ' +
            'write pause, plus filesystem fragmentation.',
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
          message: `compatibility level ${compat} on a ${mayor}.x engine: the optimizer behaves like an older version.`,
          remediation:
            `Raise it to ${mayor * 10} with Query Store on first, so you can force the old plan if a query ` +
            'gets worse. That is why many upgrades do not deliver the promised gains.',
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
  title: 'Dominant waits',
  description: 'Where the engine spends time, excluding idle waits',
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
        que: 'the engine waits for disk to bring data pages to read',
        hacer:
          'It is memory or indexes, not disk: with a small buffer pool or a plan that scans, everything is read from disk. ' +
          'Review queries with the most logical reads before buying disks.',
      },
      WRITELOG: {
        que: 'the engine waits for the transaction log to be written',
        hacer:
          'The log is on a slow disk or shared with data. Move it to its own volume with the best available write ' +
          'latency; it is the most sensitive write in the entire engine.',
      },
      CXPACKET: {
        que: 'branches of a parallel query wait on each other',
        hacer:
          'It is usually parallelism threshold at 5 and unlimited MAXDOP: cheap queries parallelize unnecessarily. ' +
          'Raise the threshold to 50 before changing anything else.',
      },
      RESOURCE_SEMAPHORE: {
        que: 'queries wait for a memory grant to sort or hash',
        hacer:
          'Queries are asking for too much memory, usually from bad estimates. This is real memory pressure: review ' +
          'statistics and plans with large grants.',
      },
      SOS_SCHEDULER_YIELD: {
        que: 'threads yield CPU time because there is more work than cores',
        hacer: 'This is CPU pressure. Find the queries with the most CPU time in the query dashboard.',
      },
      LCK_M_X: { que: 'sessions waiting for an exclusive lock', hacer: 'See the blocking dashboard: there is write contention.' },
      LCK_M_S: { que: 'sessions waiting for a shared lock', hacer: 'A long write is blocking reads. Consider READ_COMMITTED_SNAPSHOT.' },
      ASYNC_NETWORK_IO: {
        que: 'the engine waits for the client to receive the data it already produced',
        hacer:
          'It is not the server: the application reads row by row, or the network. Fetch fewer rows or consume them faster.',
      },
      THREADPOOL: {
        que: 'no worker threads are free to serve requests',
        hacer:
          'This is severe: the server stops accepting new queries. It usually comes from massive blocking that consumes ' +
          'all threads, not a lack of threads.',
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
          `${formatPct(pct)} of server wait time` +
          (conocida ? `: ${conocida.que}` : '') +
          ` (${esperas} waits, ${mediaMs.toFixed(1)} ms average).`,
        remediation:
          conocida?.hacer ??
          'Look up the wait type in Microsoft documentation: without knowing what it means, any change is blind.',
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
  title: 'Unused and missing indexes',
  description: 'Indexes that only cost writes, and indexes the optimizer requests',
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
            message: `${num(row['escrituras'])} writes and no reads since the last restart.`,
            remediation:
              'An index like this only costs: space, writes, and backup time. Before dropping it, confirm a month-end process ' +
              'does not use it; disabling it (ALTER INDEX … DISABLE) lets you roll back without recreating it.',
            value: num(row['escrituras']),
          },
        ];
      }
      return [
        {
          severity: 'info',
          object: objeto,
          message: `optimizer estimates a benefit of ${num(row['beneficio']).toLocaleString('en-US')} if this index existed.`,
          remediation:
            'This is a suggestion, not a recipe: SQL Server proposes one index per query without looking at existing ones. ' +
            'Check whether an existing index can be extended with those columns before creating a new one.',
          value: num(row['beneficio']),
        },
      ];
    });
  },
};

/** Trabajos del Agent que fallan o que nadie mira. */
const jobs: ForeignCheckDefinition = {
  id: 'mssql_agent_jobs',
  title: 'Agent jobs',
  description: 'Disabled, failing, or never-run jobs',
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
            message: 'job is disabled.',
            remediation:
              'If it is no longer needed, delete it: a disabled job nobody remembers is maintenance someone thinks is running.',
          },
        ];
      }
      // run_status 0 = falló, 1 = éxito, 2 = reintento, 3 = cancelado.
      if (estado === 0) {
        return [
          {
            severity: 'critical',
            object: job,
            message: `last run failed: ${text(row['mensaje'], 'no message').slice(0, 300)}`,
            remediation: 'Review the job history in Agent. A failing backup job leaves the server without a safety net.',
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
            message: 'job is enabled but has never run.',
            remediation: 'Verify it has a schedule assigned: a job without a schedule only runs if someone starts it manually.',
          },
        ];
      }
      return [];
    }),
};

/**
 * Cobertura semanal estilo prod (Airflow Sys_Alerts / mssql_backup_monitoring):
 * FULL + DIFF en los últimos 7 días; LOG en las últimas 24 h si el modelo es
 * FULL o BULK_LOGGED. SIMPLE sólo exige FULL+DIFF. Es el check que dispara
 * En prod disparaba Sys_Alerts; Búho lo evalúa como finding nativo.
 */
const coberturaBackupsSemana: ForeignCheckDefinition = {
  id: 'mssql_backup_week_coverage',
  title: 'Weekly backup coverage (FULL/DIFF/LOG)',
  description:
    'msdb week window: FULL+DIFF within 7 days; LOG within 1 day for FULL/BULK_LOGGED',
  sql: () => `
    with eligible as (
      select d.name as database_name, d.recovery_model_desc
        from sys.databases d
       where d.database_id > 4
         and d.state_desc = 'ONLINE'
         and d.is_read_only = 0
         and d.source_database_id is null
    ),
    week_backups as (
      select e.database_name,
             e.recovery_model_desc,
             max(case when bs.type = 'D' then bs.backup_finish_date end) as last_full,
             max(case when bs.type = 'I' then bs.backup_finish_date end) as last_diff,
             max(case
                   when bs.type = 'L'
                    and bs.backup_finish_date >= dateadd(day, -1, getdate())
                   then bs.backup_finish_date
                 end) as last_log
        from eligible e
        left join msdb.dbo.backupset bs
          on bs.database_name = e.database_name
         and bs.type in ('D', 'I', 'L')
         and bs.backup_finish_date >= dateadd(day, -7, getdate())
       group by e.database_name, e.recovery_model_desc
    ),
    scored as (
      select database_name,
             recovery_model_desc,
             last_full,
             last_diff,
             last_log,
             case when last_full is null then 0 else 1 end as has_full,
             case when last_diff is null then 0 else 1 end as has_diff,
             case
               when recovery_model_desc not in ('FULL', 'BULK_LOGGED') then 1
               when last_log is null then 0
               else 1
             end as has_log,
             stuff(
               concat(
                 case when last_full is null then ',FULL' else '' end,
                 case when last_diff is null then ',DIFF' else '' end,
                 case
                   when recovery_model_desc in ('FULL', 'BULK_LOGGED')
                    and last_log is null then ',LOG'
                   else ''
                 end
               ),
               1, 1, ''
             ) as missing_types
        from week_backups
    )
    select database_name,
           recovery_model_desc,
           missing_types,
           convert(varchar(19), last_full, 120) as last_full,
           convert(varchar(19), last_diff, 120) as last_diff,
           convert(varchar(19), last_log, 120) as last_log
      from scored
     where has_full = 0 or has_diff = 0 or has_log = 0
     order by database_name`,
  evaluate: (rows) =>
    rows.map((row) => {
      const db = text(row['database_name']);
      const missing = text(row['missing_types'], 'coverage');
      const modelo = text(row['recovery_model_desc']);
      return {
        severity: missing.includes('FULL') ? ('critical' as const) : ('warning' as const),
        object: db,
        message:
          `incomplete weekly backup coverage (${modelo}): missing ${missing}` +
          ` (FULL/DIFF ≤7d` +
          (modelo === 'FULL' || modelo === 'BULK_LOGGED' ? ', LOG ≤1d' : '') +
          ').',
        remediation:
          'Align Agent (or maintenance plan) with FULL+DIFF at least weekly and LOG backups ' +
          'within 24 hours for FULL/BULK_LOGGED. SIMPLE only needs FULL+DIFF. ' +
          'last_full=' +
          text(row['last_full'], 'never') +
          ', last_diff=' +
          text(row['last_diff'], 'never') +
          ', last_log=' +
          text(row['last_log'], 'never') +
          '.',
      };
    }),
};

/** Blocking sessions right now — same story as PostgreSQL's blocking_chain. */
const bloqueos: ForeignCheckDefinition = {
  id: 'mssql_blocking',
  title: 'Blocking sessions',
  description: 'Sessions waiting on locks held by others',
  sql: () => `
    select count(*) as blocked,
           max(r.wait_time) / 1000.0 as max_wait_s,
           max(r.session_id) as sample_session
      from sys.dm_exec_requests r
     where r.blocking_session_id <> 0`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const blocked = num(row['blocked']);
    if (blocked <= 0) return [];
    const maxWait = num(row['max_wait_s']);
    return [
      {
        severity: maxWait >= 30 || blocked >= 5 ? ('critical' as const) : ('warning' as const),
        object: text(row['sample_session'], 'sessions'),
        message: `${blocked} session(s) blocked; longest wait ≈ ${formatDuration(maxWait)}.`,
        remediation:
          'Inspect sys.dm_exec_requests / WhoIsActive for the head blocker. Kill only after confirming it is stuck; prefer fixing the long transaction or missing index that caused the lock chain.',
        value: blocked,
      },
    ];
  },
};

/** Long-running requests (agentless proxy for "long running queries"). */
const consultasLargas: ForeignCheckDefinition = {
  id: 'mssql_long_queries',
  title: 'Long-running requests',
  description: 'Active requests older than 5 minutes',
  sql: () => `
    select r.session_id,
           r.total_elapsed_time / 1000.0 as elapsed_s,
           r.status,
           db_name(r.database_id) as database_name,
           left(isnull(t.text, ''), 200) as query_text
      from sys.dm_exec_requests r
      outer apply sys.dm_exec_sql_text(r.sql_handle) t
     where r.session_id <> @@spid
       and r.total_elapsed_time >= 300000
     order by r.total_elapsed_time desc`,
  evaluate: (rows) =>
    rows.slice(0, 10).map((row) => {
      const elapsed = num(row['elapsed_s']);
      return {
        severity: elapsed >= 900 ? ('critical' as const) : ('warning' as const),
        object: `session ${text(row['session_id'])}`,
        message:
          `request running for ${formatDuration(elapsed)} on ${text(row['database_name'])}` +
          ` (${text(row['status'])}): ${text(row['query_text'], '(no text)')}`,
        remediation:
          'Check for missing indexes, blocking, or a stuck Agent job. Capture the plan with SET STATISTICS XML or Query Store before killing the session.',
        value: elapsed,
      };
    }),
};

export const MSSQL_CHECKS: ForeignCheckDefinition[] = [
  configuracionServidor,
  basesDeDatos,
  coberturaBackupsSemana,
  esperas,
  indices,
  jobs,
  bloqueos,
  consultasLargas,
];
