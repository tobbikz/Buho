import { formatBytes, formatDuration, formatPct } from '@buho/core';
import type { CheckDefinition, Finding } from './types';

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

const connectionSaturation: CheckDefinition = {
  id: 'connection_saturation',
  title: 'Saturación de conexiones',
  description: 'Sesiones en uso frente a max_connections',
  sql: () => `
    select current_setting('max_connections')::int as max_connections,
           count(*)                                as total
      from pg_stat_activity
     where backend_type = 'client backend'`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const max = num(row['max_connections']);
    const total = num(row['total']);
    if (max <= 0) return [];
    const pct = (total / max) * 100;
    if (pct < 75) return [];
    return [
      {
        severity: pct >= 90 ? 'critical' : 'warning',
        message: `${total} de ${max} conexiones en uso (${formatPct(pct)}).`,
        remediation:
          'Poner un pool (PgBouncer) delante de la aplicación en vez de subir max_connections: cada conexión reserva work_mem y memoria de backend.',
        value: pct,
      },
    ];
  },
};

const idleInTransaction: CheckDefinition = {
  id: 'idle_in_transaction',
  title: 'Transacciones abiertas sin actividad',
  description: 'Sesiones idle in transaction que retienen XID y bloquean vacuum',
  sql: () => `
    select pid, coalesce(usename, '(sin usuario)') as usename,
           coalesce(application_name, '(sin nombre)') as application_name,
           extract(epoch from (now() - state_change)) as idle_seconds
      from pg_stat_activity
     where state like 'idle in transaction%'
       and state_change < now() - interval '5 minutes'
     order by state_change
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['idle_seconds']);
      return {
        severity: seconds > 3600 ? 'critical' : 'warning',
        object: `pid ${text(row['pid'])} (${text(row['application_name'])})`,
        message: `Transacción abierta sin actividad desde hace ${formatDuration(seconds)}.`,
        remediation:
          'Revisar la aplicación que deja la transacción abierta y poner idle_in_transaction_session_timeout como red de seguridad: retiene XID, impide que autovacuum limpie y provoca bloat.',
        value: seconds,
      } satisfies Finding;
    }),
};

const blockingChain: CheckDefinition = {
  id: 'blocking_chain',
  title: 'Bloqueos activos',
  description: 'Sesiones bloqueadas y quién las bloquea',
  sql: () => `
    select pid, pg_blocking_pids(pid) as blocked_by,
           extract(epoch from (now() - query_start)) as blocked_seconds,
           left(coalesce(query, ''), 120) as query
      from pg_stat_activity
     where cardinality(pg_blocking_pids(pid)) > 0
     order by query_start
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => {
      const seconds = num(row['blocked_seconds']);
      const blockedBy = Array.isArray(row['blocked_by']) ? (row['blocked_by'] as unknown[]).join(', ') : '?';
      return {
        severity: seconds > 30 ? 'critical' : 'warning',
        object: `pid ${text(row['pid'])}`,
        message: `Bloqueada ${formatDuration(seconds)} por pid ${blockedBy}. Query: ${text(row['query'], '(oculta)')}`,
        remediation:
          'Identificar la sesión que bloquea con pg_blocking_pids y decidir si se termina (pg_terminate_backend). Si se repite, revisar el orden de acceso a las tablas en la transacción.',
        value: seconds,
      } satisfies Finding;
    }),
};

const xidWraparound: CheckDefinition = {
  id: 'xid_wraparound',
  title: 'Riesgo de wraparound de XID',
  description: 'Edad de los XID frente a autovacuum_freeze_max_age',
  sql: () => `
    select datname,
           age(datfrozenxid) as xid_age,
           current_setting('autovacuum_freeze_max_age')::bigint as freeze_max_age
      from pg_database
     where datallowconn
     order by age(datfrozenxid) desc`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const age = num(row['xid_age']);
      const max = num(row['freeze_max_age']);
      if (max <= 0) continue;
      const pct = (age / max) * 100;
      if (pct < 50) continue;
      findings.push({
        severity: pct >= 80 ? 'critical' : 'warning',
        object: text(row['datname']),
        message: `Los XID están al ${formatPct(pct)} de autovacuum_freeze_max_age (edad ${Math.round(age).toLocaleString('es-CR')}).`,
        remediation:
          'Dejar que autovacuum haga el freeze o lanzar VACUUM (FREEZE) en las tablas más viejas. Si esto sube sin bajar, algo está reteniendo XID: transacción abierta, slot de replicación inactivo o prepared transaction huérfana.',
        value: pct,
      });
    }
    return findings;
  },
};

const deadTuples: CheckDefinition = {
  id: 'dead_tuples',
  title: 'Tuplas muertas y autovacuum atrasado',
  description: 'Tablas donde autovacuum no está siguiendo el ritmo de cambios',
  sql: () => `
    select schemaname, relname, n_live_tup, n_dead_tup, autovacuum_count,
           extract(epoch from (now() - greatest(last_autovacuum, last_vacuum))) as seconds_since_vacuum
      from pg_stat_user_tables
     where n_dead_tup > 0
     order by n_dead_tup desc
     limit 20`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const live = num(row['n_live_tup']);
      const dead = num(row['n_dead_tup']);
      const total = live + dead;
      if (total === 0) continue;
      const pct = (dead / total) * 100;
      const object = `${text(row['schemaname'])}.${text(row['relname'])}`;
      const autovacuums = num(row['autovacuum_count']);

      if (dead > 1000 && pct > 20) {
        findings.push({
          severity: pct > 50 ? 'warning' : 'info',
          object,
          message:
            `${dead.toLocaleString('es-CR')} tuplas muertas (${formatPct(pct)} de la tabla)` +
            (autovacuums > 0 ? `, y eso pese a ${autovacuums} autovacuums.` : ', sin ningún autovacuum.'),
          remediation:
            'En tablas con muchos UPDATE el scale_factor global (0.2) nunca alcanza. Bajarlo por tabla: ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000). Considerar fillfactor 90 para favorecer HOT updates.',
          value: pct,
        });
      } else if (autovacuums === 0 && dead > 10) {
        findings.push({
          severity: 'info',
          object,
          message: `${dead} tuplas muertas y autovacuum nunca corrió en esta tabla.`,
          remediation:
            'Normal si la tabla es nueva o pequeña. Si crece, verificar que autovacuum esté habilitado a nivel de tabla (reloptions).',
          value: dead,
        });
      }
    }
    return findings;
  },
};

/**
 * Verificado contra PG 18.4: encontró 4 índices redundantes (~132 MB) en el
 * lake de DataSync, donde el PK compuesto ya cubre el índice de la columna.
 */
const redundantIndexes: CheckDefinition = {
  id: 'redundant_index_prefix',
  title: 'Índices redundantes por prefijo',
  description: 'Índices cuyas columnas ya son el prefijo izquierdo de otro índice',
  sql: () => `
    with idx as (
      select i.indexrelid,
             n.nspname  as schema_name,
             c.relname  as table_name,
             ir.relname as index_name,
             i.indisunique,
             pg_relation_size(i.indexrelid) as bytes,
             (i.indpred is not null)   as is_partial,
             (i.indexprs is not null)  as has_expression,
             (select array_agg(k.attnum order by k.ord)
                from unnest(i.indkey) with ordinality k(attnum, ord)) as cols
        from pg_index i
        join pg_class c      on c.oid = i.indrelid
        join pg_class ir     on ir.oid = i.indexrelid
        join pg_namespace n  on n.oid = c.relnamespace
       where i.indisvalid
         and c.relkind in ('r', 'p')
         and n.nspname not in ('pg_catalog', 'information_schema')
    )
    select a.schema_name, a.table_name,
           a.index_name as redundant_index,
           b.index_name as covered_by,
           a.bytes      as redundant_bytes
      from idx a
      join idx b
        on a.schema_name = b.schema_name
       and a.table_name  = b.table_name
       and a.indexrelid <> b.indexrelid
       and array_length(a.cols, 1) <= array_length(b.cols, 1)
       and b.cols[1:array_length(a.cols, 1)] = a.cols
     where not a.indisunique
       and not a.is_partial and not b.is_partial
       and not a.has_expression and not b.has_expression
       and a.bytes > 1024 * 1024
     order by a.bytes desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: `${text(row['schema_name'])}.${text(row['table_name'])}.${text(row['redundant_index'])}`,
      message:
        `${formatBytes(num(row['redundant_bytes']))} recuperables: sus columnas ya son el prefijo izquierdo de ` +
        `${text(row['covered_by'])}, que puede atender las mismas búsquedas.`,
      remediation:
        'Confirmar que ninguna query dependa explícitamente del índice (pg_stat_user_indexes.idx_scan) y luego DROP INDEX CONCURRENTLY. Además de espacio, se ahorra trabajo de escritura en cada INSERT y UPDATE.',
      value: num(row['redundant_bytes']),
    })),
};

const unusedIndexes: CheckDefinition = {
  id: 'unused_indexes',
  title: 'Índices sin uso',
  description: 'Índices grandes que nunca registraron un scan',
  // Se excluyen los índices de PK/UNIQUE (respaldan integridad: no son
  // accionables) y los que ya reporta redundant_index_prefix, para no decir
  // dos veces lo mismo del mismo objeto.
  sql: () => `
    with idx as (
      select i.indexrelid, i.indrelid, i.indisunique,
             (i.indpred is not null)  as is_partial,
             (i.indexprs is not null) as has_expression,
             (select array_agg(k.attnum order by k.ord)
                from unnest(i.indkey) with ordinality k(attnum, ord)) as cols
        from pg_index i
       where i.indisvalid
    ),
    redundant as (
      select a.indexrelid
        from idx a
        join idx b
          on a.indrelid = b.indrelid
         and a.indexrelid <> b.indexrelid
         and array_length(a.cols, 1) <= array_length(b.cols, 1)
         and b.cols[1:array_length(a.cols, 1)] = a.cols
       where not a.indisunique
         and not a.is_partial and not b.is_partial
         and not a.has_expression and not b.has_expression
    )
    select s.schemaname, s.relname, s.indexrelname,
           pg_relation_size(s.indexrelid) as bytes
      from pg_stat_user_indexes s
      join pg_index i on i.indexrelid = s.indexrelid
     where s.idx_scan = 0
       and not i.indisprimary
       and not i.indisunique
       and pg_relation_size(s.indexrelid) > 10 * 1024 * 1024
       and s.indexrelid not in (select indexrelid from redundant)
     order by pg_relation_size(s.indexrelid) desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['schemaname'])}.${text(row['relname'])}.${text(row['indexrelname'])}`,
      message: `${formatBytes(num(row['bytes']))} sin un solo scan registrado.`,
      remediation:
        'Revisar antes de borrar: los contadores se reinician con pg_stat_reset y puede ser un índice usado por procesos poco frecuentes (cierres, reportes) o por réplicas.',
      value: num(row['bytes']),
    })),
};

const tempSpill: CheckDefinition = {
  id: 'temp_spill',
  title: 'Derrame a archivos temporales',
  description: 'Consultas que no caben en work_mem y bajan a disco',
  sql: () => `
    select datname, temp_files, temp_bytes
      from pg_stat_database
     where temp_bytes > 64 * 1024 * 1024
     order by temp_bytes desc`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: text(row['datname']),
      message: `${formatBytes(num(row['temp_bytes']))} derramados en ${num(row['temp_files'])} archivos temporales.`,
      remediation:
        'Subir work_mem (por sesión o por rol, no globalmente: se multiplica por conexión y por nodo del plan) o arreglar las consultas que ordenan o agrupan sin índice. Con log_temp_files se identifica cuáles son.',
      value: num(row['temp_bytes']),
    })),
};

const cacheHit: CheckDefinition = {
  id: 'cache_hit',
  title: 'Cache hit ratio bajo',
  description: 'Proporción de bloques servidos desde shared_buffers',
  sql: () => `
    select datname, blks_hit, blks_read
      from pg_stat_database
     where blks_read + blks_hit > 100000
     order by blks_read desc`,
  evaluate: (rows) => {
    const findings: Finding[] = [];
    for (const row of rows) {
      const hits = num(row['blks_hit']);
      const reads = num(row['blks_read']);
      const pct = (hits / (hits + reads)) * 100;
      if (pct >= 95) continue;
      findings.push({
        severity: pct < 90 ? 'warning' : 'info',
        object: text(row['datname']),
        message: `Cache hit del ${formatPct(pct)} desde el último reset de estadísticas.`,
        remediation:
          'Es un indicador grueso (el sistema operativo también cachea). Antes de subir shared_buffers, mirar qué consultas hacen los reads con pg_stat_statements y si falta un índice.',
        value: pct,
      });
    }
    return findings;
  },
};

const inactiveSlots: CheckDefinition = {
  id: 'inactive_replication_slot',
  title: 'Slot de replicación inactivo',
  description: 'Slots sin consumidor: retienen WAL y pueden llenar el disco',
  sql: () => `
    select slot_name, slot_type, active, coalesce(wal_status, 'unknown') as wal_status,
           safe_wal_size
      from pg_replication_slots
     where not active or wal_status in ('extended', 'unreserved', 'lost')`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: text(row['wal_status']) === 'lost' ? ('critical' as const) : ('warning' as const),
      object: text(row['slot_name']),
      message: `Slot ${text(row['slot_type'])} inactivo, wal_status = ${text(row['wal_status'])}.`,
      remediation:
        'Un slot sin consumidor retiene WAL indefinidamente hasta llenar el disco y además bloquea el freeze de XID. Si el consumidor ya no existe: SELECT pg_drop_replication_slot(...). Si sigue vivo, arreglar la réplica o el conector CDC.',
    })),
};

const tablesWithoutPk: CheckDefinition = {
  id: 'tables_without_pk',
  title: 'Tablas sin llave primaria',
  description: 'Tablas grandes sin PK',
  sql: () => `
    select n.nspname as schema_name, c.relname as table_name, c.reltuples::bigint as est_rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname not in ('pg_catalog', 'information_schema')
       and c.reltuples > 1000
       and not exists (
             select 1 from pg_constraint k
              where k.conrelid = c.oid and k.contype = 'p')
     order by c.reltuples desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'info' as const,
      object: `${text(row['schema_name'])}.${text(row['table_name'])}`,
      message: `~${num(row['est_rows']).toLocaleString('es-CR')} filas sin llave primaria.`,
      remediation:
        'Sin PK no hay forma barata de identificar una fila: complica UPDATE/DELETE puntuales, replicación lógica (REPLICA IDENTITY) y CDC. Añadir PK o al menos un índice único.',
      value: num(row['est_rows']),
    })),
};

const longRunningQueries: CheckDefinition = {
  id: 'long_running_queries',
  title: 'Consultas de larga duración',
  description: 'Consultas activas por encima del umbral',
  sql: () => `
    select pid, coalesce(application_name, '(sin nombre)') as application_name,
           extract(epoch from (now() - query_start)) as running_seconds,
           left(coalesce(query, ''), 120) as query
      from pg_stat_activity
     where state = 'active'
       and backend_type = 'client backend'
       and query_start < now() - interval '5 minutes'
     order by query_start
     limit 10`,
  evaluate: (rows) =>
    rows.map((row) => ({
      severity: 'warning' as const,
      object: `pid ${text(row['pid'])} (${text(row['application_name'])})`,
      message: `Corriendo hace ${formatDuration(num(row['running_seconds']))}: ${text(row['query'], '(oculta)')}`,
      remediation:
        'Revisar el plan con EXPLAIN (ANALYZE, BUFFERS). Para que no se repita, poner statement_timeout por rol en las cargas interactivas.',
      value: num(row['running_seconds']),
    })),
};

/**
 * El caso "precargada pero sin CREATE EXTENSION" es el más común y el más
 * satisfactorio de arreglar: se activa sin reiniciar el servidor.
 */
const statStatementsState: CheckDefinition = {
  id: 'pg_stat_statements_state',
  title: 'Estado de pg_stat_statements',
  description: 'Disponibilidad del análisis de consultas',
  sql: () => null,
  evaluate: (_rows, caps) => {
    if (caps.statStatements === 'active') return [];
    if (caps.statStatements === 'preloaded_not_created') {
      return [
        {
          severity: 'warning',
          message:
            'La librería ya está en shared_preload_libraries pero la extensión no está creada: se está pagando el overhead sin obtener ni un dato.',
          remediation: 'CREATE EXTENSION pg_stat_statements; — no requiere reiniciar el servidor.',
        },
      ];
    }
    return [
      {
        severity: 'info',
        message: 'pg_stat_statements no está precargado, así que no hay análisis de consultas.',
        remediation:
          "Añadir 'pg_stat_statements' a shared_preload_libraries y reiniciar; luego CREATE EXTENSION. Es el cambio con mejor relación valor/riesgo en un PostgreSQL sin instrumentar.",
      },
    ];
  },
};

const configCoherence: CheckDefinition = {
  id: 'config_coherence',
  title: 'Configuración de memoria incoherente',
  description: 'shared_buffers frente a effective_cache_size y track_io_timing',
  sql: () => `
    select (select setting::bigint * 8192 from pg_settings where name = 'shared_buffers')       as shared_buffers_bytes,
           (select setting::bigint * 8192 from pg_settings where name = 'effective_cache_size') as effective_cache_bytes,
           (select setting::bigint * 1024 from pg_settings where name = 'work_mem')             as work_mem_bytes,
           (select setting from pg_settings where name = 'track_io_timing')                     as track_io_timing`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];
    const shared = num(row['shared_buffers_bytes']);
    const effective = num(row['effective_cache_bytes']);

    if (shared > 0 && effective > 0 && effective / shared >= 16) {
      findings.push({
        severity: 'warning',
        message:
          `shared_buffers está en ${formatBytes(shared)} mientras effective_cache_size declara ${formatBytes(effective)}: ` +
          'la instancia quedó con el valor por defecto del contenedor.',
        remediation:
          'Con RAM dedicada, shared_buffers suele ir cerca del 25% y effective_cache_size del 50–75%. effective_cache_size no reserva memoria, solo informa al planificador, así que dejarlo alto con shared_buffers mínimo da planes optimistas sin caché real.',
        value: effective / shared,
      });
    }

    if (String(row['track_io_timing']) !== 'on') {
      findings.push({
        severity: 'info',
        message: 'track_io_timing = off: no hay tiempos de I/O, solo conteos de bloques.',
        remediation:
          'Se activa sin reiniciar: ALTER SYSTEM SET track_io_timing = on; SELECT pg_reload_conf(); El overhead se mide antes con pg_test_timing.',
      });
    }

    return findings;
  },
};

const frequentCheckpoints: CheckDefinition = {
  id: 'frequent_checkpoints',
  title: 'Checkpoints forzados por volumen de WAL',
  description: 'Proporción de checkpoints pedidos por max_wal_size frente a los programados',
  // PG17 movió estos contadores de pg_stat_bgwriter a pg_stat_checkpointer y
  // les cambió el nombre; PG18 los quitó de bgwriter.
  sql: (caps) =>
    caps.hasStatCheckpointer
      ? `select num_timed as timed, num_requested as requested,
                (select setting::bigint * 1024 * 1024 from pg_settings where name = 'max_wal_size') as max_wal_bytes,
                (select setting::int from pg_settings where name = 'checkpoint_timeout') as checkpoint_timeout
           from pg_stat_checkpointer`
      : `select checkpoints_timed as timed, checkpoints_req as requested,
                (select setting::bigint * 1024 * 1024 from pg_settings where name = 'max_wal_size') as max_wal_bytes,
                (select setting::int from pg_settings where name = 'checkpoint_timeout') as checkpoint_timeout
           from pg_stat_bgwriter`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const timed = num(row['timed']);
    const requested = num(row['requested']);
    const total = timed + requested;
    // Con pocos checkpoints el porcentaje es ruido estadístico.
    if (total < 20) return [];

    const pct = (requested / total) * 100;
    if (pct < 30) return [];

    return [
      {
        severity: pct >= 60 ? 'warning' : 'info',
        message:
          `${formatPct(pct)} de los checkpoints los forzó el volumen de WAL (${requested} de ${total}), ` +
          `con max_wal_size en ${formatBytes(num(row['max_wal_bytes']))}.`,
        remediation:
          'Subir max_wal_size para que el checkpoint lo gobierne checkpoint_timeout y no el llenado del WAL. Los checkpoints forzados concentran escritura y disparan full page writes; el costo de subirlo es más espacio en pg_wal y una recuperación más larga tras una caída.',
        value: pct,
      },
    ];
  },
};

const walArchiveFailing: CheckDefinition = {
  id: 'wal_archive_failing',
  title: 'Archivado de WAL fallando',
  description: 'archive_mode activo con el archiver fallando: el WAL se acumula y no hay backup válido',
  sql: () => `
    select current_setting('archive_mode')                        as archive_mode,
           nullif(trim(current_setting('archive_command')), '')    as archive_command,
           a.archived_count, a.failed_count,
           a.last_archived_time, a.last_failed_time,
           a.last_failed_wal
      from pg_stat_archiver a`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    if (String(row['archive_mode']) === 'off') return [];

    const findings: Finding[] = [];
    const failed = num(row['failed_count']);
    const lastFailed = row['last_failed_time'] ? new Date(String(row['last_failed_time'])) : null;
    const lastArchived = row['last_archived_time'] ? new Date(String(row['last_archived_time'])) : null;

    if (!row['archive_command']) {
      findings.push({
        severity: 'critical',
        message: 'archive_mode está activo pero archive_command está vacío: el WAL nunca se archiva y pg_wal crece sin techo.',
        remediation:
          'Definir archive_command (o archive_library) y verificarlo con pg_switch_wal(). Mientras esté vacío, PostgreSQL retiene cada segmento a la espera de archivarlo hasta llenar el disco.',
      });
    }

    // Lo que importa no es que alguna vez falló, sino que el último intento
    // fallara: si después hubo un archivado exitoso, el problema ya pasó.
    const failingNow = failed > 0 && lastFailed !== null && (lastArchived === null || lastFailed > lastArchived);
    if (failingNow) {
      findings.push({
        severity: 'critical',
        message:
          `El archivado falla desde ${text(row['last_failed_wal'])} (${failed} intentos fallidos). ` +
          'El WAL se acumula en pg_wal y el backup en cadena quedó incompleto.',
        remediation:
          'Revisar el destino del archive_command (permisos, espacio, red). Hasta que un segmento se archive con éxito, PostgreSQL no libera ninguno de los siguientes: el riesgo inmediato es llenar el disco, y el de fondo es no poder recuperar a un punto en el tiempo.',
        value: failed,
      });
    }

    return findings;
  },
};

const unsafeDurability: CheckDefinition = {
  id: 'unsafe_durability',
  title: 'Parámetros de durabilidad en riesgo',
  description: 'fsync, full_page_writes y synchronous_commit desactivados',
  // Búho no toca ninguno de estos cuatro en su sesión, así que current_setting
  // dice la verdad. (Los timeouts son otra historia: ver missing_timeouts.)
  sql: () => `
    select current_setting('fsync')               as fsync,
           current_setting('full_page_writes')     as full_page_writes,
           current_setting('data_checksums')       as data_checksums,
           current_setting('synchronous_commit')   as synchronous_commit`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];

    if (String(row['fsync']) === 'off') {
      findings.push({
        severity: 'critical',
        message: 'fsync = off: un corte de energía o una caída del kernel puede dejar la base irrecuperable.',
        remediation:
          'Poner fsync = on (requiere reinicio). Sólo tiene sentido en off durante una carga inicial que se puede repetir desde cero. No es "más rápido con un riesgo pequeño": es corrupción silenciosa, no pérdida de las últimas transacciones.',
      });
    }
    if (String(row['full_page_writes']) === 'off') {
      findings.push({
        severity: 'critical',
        message: 'full_page_writes = off: una caída durante una escritura puede dejar páginas partidas ilegibles.',
        remediation:
          'Poner full_page_writes = on. Sólo se puede desactivar si el almacenamiento garantiza escrituras atómicas de página, lo que casi ningún filesystem promete.',
      });
    }
    if (String(row['synchronous_commit']) === 'off') {
      findings.push({
        severity: 'warning',
        message: 'synchronous_commit = off: los commits confirman antes de que el WAL llegue a disco.',
        remediation:
          'A diferencia de fsync, esto no corrompe: se pierden las últimas transacciones confirmadas ante una caída. Es una decisión válida si alguien la tomó a propósito; hay que confirmar que sea el caso y no una herencia.',
      });
    }
    if (String(row['data_checksums']) === 'off') {
      findings.push({
        severity: 'info',
        message: 'data_checksums = off: la corrupción de datos en disco no se detecta al leerlos.',
        remediation:
          'Se puede activar sin volcar y restaurar con pg_checksums --enable, pero exige la instancia detenida. Vale la pena planificarlo en la próxima ventana.',
      });
    }

    return findings;
  },
};

const autovacuumDisabled: CheckDefinition = {
  id: 'autovacuum_disabled',
  title: 'Tablas con autovacuum desactivado',
  description: 'Tablas con autovacuum_enabled = false en sus reloptions',
  sql: () => `
    select n.nspname as schema_name, c.relname as table_name,
           coalesce(s.n_dead_tup, 0)  as dead_tuples,
           coalesce(s.n_live_tup, 0)  as live_tuples,
           s.last_autovacuum, s.last_vacuum,
           pg_total_relation_size(c.oid) as bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
     where c.relkind in ('r', 'p')
       and n.nspname not in ('pg_catalog', 'information_schema')
       and array_to_string(c.reloptions, ',') like '%autovacuum_enabled=false%'
     order by pg_total_relation_size(c.oid) desc
     limit 20`,
  evaluate: (rows) =>
    rows.map((row) => {
      const dead = num(row['dead_tuples']);
      const manual = row['last_vacuum'] !== null && row['last_vacuum'] !== undefined;
      return {
        severity: dead > 100_000 ? ('critical' as const) : ('warning' as const),
        object: `${text(row['schema_name'])}.${text(row['table_name'])}`,
        message:
          `Autovacuum desactivado en la tabla (${formatBytes(num(row['bytes']))}, ${dead.toLocaleString('es-CR')} tuplas muertas). ` +
          (manual ? 'Hay vacuum manual registrado.' : 'No hay ningún vacuum manual registrado.'),
        remediation:
          'Si fue para una carga masiva, revertirlo: ALTER TABLE ... RESET (autovacuum_enabled). Una tabla sin vacuum no sólo acumula espacio muerto, también deja de avanzar su relfrozenxid y arrastra el riesgo de wraparound de toda la base.',
        value: dead,
      };
    }),
};

const staleStatistics: CheckDefinition = {
  id: 'stale_statistics',
  title: 'Estadísticas del planificador desactualizadas',
  description: 'Tablas con muchas filas modificadas desde el último ANALYZE',
  sql: () => `
    select schemaname as schema_name, relname as table_name,
           n_mod_since_analyze as modified,
           n_live_tup          as live_tuples,
           greatest(last_analyze, last_autoanalyze) as analyzed_at
      from pg_stat_user_tables
     where n_mod_since_analyze > greatest(10000, n_live_tup * 0.2)
       and n_live_tup > 1000
     order by n_mod_since_analyze desc
     limit 15`,
  evaluate: (rows) =>
    rows.map((row) => {
      const modified = num(row['modified']);
      const live = num(row['live_tuples']);
      const pct = live > 0 ? (modified / live) * 100 : 0;
      const analyzed = row['analyzed_at'];
      return {
        severity: pct >= 100 ? ('warning' as const) : ('info' as const),
        object: `${text(row['schema_name'])}.${text(row['table_name'])}`,
        message:
          `${modified.toLocaleString('es-CR')} filas modificadas desde el último ANALYZE (${formatPct(pct)} de la tabla), ` +
          (analyzed ? `analizada por última vez el ${new Date(String(analyzed)).toISOString().slice(0, 16).replace('T', ' ')}.` : 'nunca analizada.'),
        remediation:
          'Correr ANALYZE sobre la tabla. Estadísticas viejas hacen que el planificador estime mal la cantidad de filas y elija seq scan donde debía usar índice, o nested loop donde debía usar hash join: la query se degrada sin que nada cambie en el SQL.',
        value: pct,
      };
    }),
};

const replicationLag: CheckDefinition = {
  id: 'replication_lag',
  title: 'Retraso de replicación',
  description: 'Bytes y segundos de retraso de los standby (o del replay si esta instancia es standby)',
  // Dos preguntas distintas según el rol: en el primario interesa cuánto le
  // falta a cada standby; en un standby, cuánto hace que no aplica nada.
  sql: (caps) =>
    caps.inRecovery
      ? `select 'standby' as scope,
                extract(epoch from (now() - pg_last_xact_replay_timestamp())) as replay_seconds,
                null::bigint as lag_bytes, null::text as client, null::text as state`
      : `select 'primary' as scope,
                extract(epoch from replay_lag) as replay_seconds,
                pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes,
                coalesce(application_name, host(client_addr)::text, '(desconocido)') as client,
                state
           from pg_stat_replication`,
  evaluate: (rows) => {
    const findings: Finding[] = [];

    for (const row of rows) {
      const seconds = num(row['replay_seconds']);
      const bytes = num(row['lag_bytes']);

      if (String(row['scope']) === 'standby') {
        // Un standby sin tráfico también muestra "retraso": el aviso es por
        // minutos sin aplicar nada, no por segundos.
        if (seconds < 300) continue;
        findings.push({
          severity: seconds >= 1800 ? 'critical' : 'warning',
          message: `Este standby no aplica cambios desde hace ${formatDuration(seconds)}.`,
          remediation:
            'Verificar la conexión con el primario (pg_stat_wal_receiver) y si el primario sigue generando WAL. Un standby atrasado sirve cada vez menos como failover y, si alimenta consultas de lectura, ya está devolviendo datos viejos.',
          value: seconds,
        });
        continue;
      }

      if (bytes < 64 * 1024 * 1024 && seconds < 60) continue;
      findings.push({
        severity: bytes >= 512 * 1024 * 1024 || seconds >= 300 ? 'critical' : 'warning',
        object: text(row['client']),
        message:
          `El standby está ${formatBytes(bytes)} detrás` +
          (seconds > 0 ? ` (${formatDuration(seconds)} de replay)` : '') +
          `, en estado ${text(row['state'])}.`,
        remediation:
          'Revisar red y capacidad de I/O del standby. Si el retraso crece sostenido, el primario acabará reteniendo WAL por el slot y llenando pg_wal.',
        value: bytes,
      });
    }

    return findings;
  },
};

const missingTimeouts: CheckDefinition = {
  id: 'missing_timeouts',
  title: 'Sin límites de tiempo por sesión',
  description: 'statement_timeout e idle_in_transaction_session_timeout sin definir',
  // Este check no puede preguntarle a su propia sesión.
  //
  // El pool de Búho fija statement_timeout e idle_in_transaction_session_timeout
  // como parámetros del paquete de arranque, y eso contamina las dos vistas
  // obvias: `current_setting()` devuelve el valor del monitor, y `reset_val`
  // también, porque RESET vuelve al valor de arranque de la sesión, no al del
  // archivo de configuración. Medido: reset_val devolvía 5000 y 10000, que son
  // exactamente los valores que pone Búho.
  //
  // La fuente honesta es la configuración en disco (`pg_file_settings`, legible
  // con pg_monitor). Los overrides por rol o por base se cuentan aparte para
  // no afirmar de más.
  appliesTo: (caps) => caps.hasPgMonitor || caps.isSuperuser,
  sql: () => `
    select coalesce(
             (select f.setting from pg_file_settings f
               where f.name = 'statement_timeout' and f.applied
               order by f.seqno desc limit 1),
             (select boot_val from pg_settings where name = 'statement_timeout')
           ) as statement_timeout,
           coalesce(
             (select f.setting from pg_file_settings f
               where f.name = 'idle_in_transaction_session_timeout' and f.applied
               order by f.seqno desc limit 1),
             (select boot_val from pg_settings where name = 'idle_in_transaction_session_timeout')
           ) as idle_in_transaction_timeout,
           (select count(*) from pg_db_role_setting) as scoped_overrides`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];

    const overrides = num(row['scoped_overrides']);
    const caveat =
      overrides > 0
        ? ` Hay ${overrides} configuración(es) por rol o por base que este check no evalúa: si el límite está ahí, ignorar el aviso.`
        : '';

    if (String(row['idle_in_transaction_timeout']) === '0') {
      findings.push({
        severity: 'warning',
        message:
          'idle_in_transaction_session_timeout = 0 en la configuración: una transacción olvidada puede quedar abierta para siempre.' +
          caveat,
        remediation:
          'Poner un límite (por ejemplo 15min) a nivel de servidor o de rol. Es la única defensa automática contra el patrón más común de desastre: una transacción abierta que frena el vacuum de toda la base y empuja el XID hacia el wraparound.',
      });
    }
    if (String(row['statement_timeout']) === '0') {
      findings.push({
        severity: 'info',
        message: 'statement_timeout = 0 en la configuración: no hay techo para lo que puede durar una consulta.' + caveat,
        remediation:
          'Conviene definirlo por rol y no globalmente: la aplicación web tolera segundos, el proceso de reportes necesita minutos. Un valor global agresivo rompe los batch legítimos.',
      });
    }

    return findings;
  },
};

const weakPasswordEncryption: CheckDefinition = {
  id: 'weak_password_encryption',
  title: 'Cifrado de contraseñas obsoleto',
  description: 'password_encryption en md5 o roles con hashes md5 guardados',
  // El conteo de hashes exige superusuario (pg_authid): con pg_monitor la
  // consulta fallaría entera, así que la parte sensible se incluye sólo si se
  // puede leer.
  sql: (caps) =>
    caps.isSuperuser
      ? `select current_setting('password_encryption') as password_encryption,
                (select count(*) from pg_authid
                  where rolpassword like 'md5%' and rolcanlogin) as md5_roles`
      : `select current_setting('password_encryption') as password_encryption,
                null::bigint as md5_roles`,
  evaluate: (rows) => {
    const row = rows[0];
    if (!row) return [];
    const findings: Finding[] = [];

    if (String(row['password_encryption']) === 'md5') {
      findings.push({
        severity: 'warning',
        message: 'password_encryption = md5: las contraseñas nuevas se guardan con un esquema obsoleto.',
        remediation:
          'Cambiar a scram-sha-256 (ALTER SYSTEM SET password_encryption = \'scram-sha-256\'; SELECT pg_reload_conf()). El hash md5 de PostgreSQL usa el nombre de usuario como sal y es vulnerable a fuerza bruta offline si alguien obtiene el hash; PG18 ya lo marca como obsoleto.',
      });
    }

    const md5Roles = row['md5_roles'];
    if (md5Roles !== null && md5Roles !== undefined && num(md5Roles) > 0) {
      findings.push({
        severity: 'warning',
        message: `${num(md5Roles)} rol(es) con permiso de login todavía tienen su contraseña en md5.`,
        remediation:
          'Cambiar password_encryption y luego reasignar la contraseña de cada rol (\\password en psql): el hash no se convierte solo, se reescribe recién cuando la contraseña se vuelve a establecer. Revisar también que pg_hba.conf no siga pidiendo md5.',
        value: num(md5Roles),
      });
    }

    return findings;
  },
};

export const CHECKS: CheckDefinition[] = [
  connectionSaturation,
  idleInTransaction,
  blockingChain,
  xidWraparound,
  deadTuples,
  redundantIndexes,
  unusedIndexes,
  tempSpill,
  cacheHit,
  inactiveSlots,
  tablesWithoutPk,
  longRunningQueries,
  statStatementsState,
  configCoherence,
  frequentCheckpoints,
  walArchiveFailing,
  unsafeDurability,
  autovacuumDisabled,
  staleStatistics,
  replicationLag,
  missingTimeouts,
  weakPasswordEncryption,
];
