import { tagged } from './tag';
import type { Pool } from 'pg';

/**
 * Una sesión bloqueada, con quién la bloquea y por qué.
 *
 * Esto no cabe en el modelo de métricas: son eventos con texto de query y
 * duración propia, no series numéricas. Por eso viven en su propia tabla y no
 * pasan por el DeltaEngine.
 */
export interface BlockedSession {
  waiterPid: number;
  waiterQueryStart: Date | null;
  waitSeconds: number;
  waiterUser: string | null;
  waiterApplication: string | null;
  waiterDatabase: string | null;
  waiterQuery: string;
  waitEventType: string | null;
  waitEvent: string | null;
  lockType: string | null;
  lockMode: string | null;
  lockObject: string | null;
  blockerPids: number[];
  blockerPid: number | null;
  blockerState: string | null;
  blockerQuery: string | null;
  blockerUser: string | null;
  blockerApplication: string | null;
  blockerXactSeconds: number | null;
}

/**
 * Dos filtros, cada uno por su razón:
 *
 *  - `wait_event_type = 'Lock'` es el filtro barato y va primero: una sesión
 *    detenida por un lock pesado siempre lo tiene, así que pg_blocking_pids()
 *    —que toma locks internos para responder— se llama sólo sobre esas filas
 *    en vez de sobre toda pg_stat_activity.
 *  - `datname = current_database()` acota al alcance de la instancia. Sin él,
 *    dos entradas del config que apunten a dos bases del **mismo servidor**
 *    guardan el mismo bloqueo dos veces: pg_stat_activity es del clúster
 *    completo, no de la base conectada. El bloqueador sí puede vivir en otra
 *    base (pasa con los locks advisory) y se registra tal cual.
 */
const BLOCKING_SQL = `
with waiters as (
  select pid, query_start, usename, application_name, datname,
         wait_event_type, wait_event, left(query, 2000) as query,
         pg_blocking_pids(pid) as blocker_pids
    from pg_stat_activity
   where wait_event_type = 'Lock'
     and backend_type = 'client backend'
     and datname = current_database()
)
select w.pid                                          as waiter_pid,
       w.query_start                                  as waiter_query_start,
       extract(epoch from (now() - w.query_start))     as wait_seconds,
       w.usename                                      as waiter_user,
       w.application_name                             as waiter_application,
       w.datname                                      as waiter_database,
       w.query                                        as waiter_query,
       w.wait_event_type, w.wait_event, w.blocker_pids,
       l.locktype                                     as lock_type,
       l.mode                                         as lock_mode,
       l.object                                       as lock_object,
       b.pid                                          as blocker_pid,
       b.state                                        as blocker_state,
       b.query                                        as blocker_query,
       b.usename                                      as blocker_user,
       b.application_name                             as blocker_application,
       b.xact_seconds                                 as blocker_xact_seconds
  from waiters w
  left join lateral (
    select k.locktype, k.mode,
           coalesce(
             n.nspname || '.' || c.relname,
             case when k.locktype = 'advisory'
                  then 'advisory ' || coalesce(k.classid::text, '?') || '/' || coalesce(k.objid::text, '?')
             end,
             k.locktype
           ) as object
      from pg_locks k
      left join pg_class c on c.oid = k.relation
      left join pg_namespace n on n.oid = c.relnamespace
     where k.pid = w.pid
       and not k.granted
     limit 1
  ) l on true
  left join lateral (
    select a.pid, a.state, left(a.query, 2000) as query, a.usename, a.application_name,
           extract(epoch from (now() - a.xact_start)) as xact_seconds
      from pg_stat_activity a
     where a.pid = w.blocker_pids[1]
  ) b on true
 where cardinality(w.blocker_pids) > 0
 order by wait_seconds desc nulls last
 limit 50`;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

/**
 * Sin `pg_monitor` (o `pg_read_all_stats`) PostgreSQL devuelve
 * "<insufficient privilege>" en vez del texto de la query ajena. Se guarda tal
 * cual: es más honesto que una cadena vacía y explica por qué falta el dato.
 */
export async function sampleBlocking(pool: Pool): Promise<BlockedSession[]> {
  const result = await pool.query(tagged(BLOCKING_SQL));

  return result.rows.map((row: Record<string, unknown>) => ({
    waiterPid: Number(row['waiter_pid']),
    waiterQueryStart: (row['waiter_query_start'] as Date | null) ?? null,
    waitSeconds: num(row['wait_seconds']) ?? 0,
    waiterUser: text(row['waiter_user']),
    waiterApplication: text(row['waiter_application']),
    waiterDatabase: text(row['waiter_database']),
    waiterQuery: text(row['waiter_query']) ?? '(sin texto)',
    waitEventType: text(row['wait_event_type']),
    waitEvent: text(row['wait_event']),
    lockType: text(row['lock_type']),
    lockMode: text(row['lock_mode']),
    lockObject: text(row['lock_object']),
    blockerPids: ((row['blocker_pids'] as number[] | null) ?? []).map(Number),
    blockerPid: num(row['blocker_pid']),
    blockerState: text(row['blocker_state']),
    blockerQuery: text(row['blocker_query']),
    blockerUser: text(row['blocker_user']),
    blockerApplication: text(row['blocker_application']),
    blockerXactSeconds: num(row['blocker_xact_seconds']),
  }));
}
