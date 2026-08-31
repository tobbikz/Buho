import type { Pool } from 'pg';
import { tagged } from './tag';

/**
 * Foto de las sesiones y de qué están esperando.
 *
 * Dos preguntas que hoy no se podían contestar y que son las que un DBA hace
 * primero cuando algo se cayó:
 *
 *   1. «¿Qué estaba corriendo a las 3:04?» — `pg_stat_activity` es el presente y
 *      no guarda nada. Cuando alguien mira, ya pasó.
 *   2. «¿En qué se está yendo el tiempo?» — no en CPU o disco a nivel de host,
 *      sino en qué espera el servidor: un bloqueo, una lectura de disco, un
 *      `fsync`, la red del cliente. Eso es `wait_event_type` y `wait_event`, y
 *      es la diferencia entre comprar discos y arreglar una transacción.
 *
 * Se guardan sólo las sesiones que están haciendo o esperando algo. Una sesión
 * `idle` no aporta a ninguna de las dos preguntas y multiplicaría el volumen por
 * el tamaño del pool de la aplicación, que suele ser cien veces mayor que el
 * número de sesiones activas.
 *
 * Una advertencia que la pantalla repite: esto es **muestreo**. Con una foto cada
 * diez segundos, una espera de dos milisegundos casi nunca se ve. Lo que el
 * muestreo mide bien es lo que dura: si una espera aparece en el 40 % de las
 * fotos, ocupó aproximadamente el 40 % del tiempo. Es el mismo principio que usa
 * cualquier perfilador.
 */

export interface SessionSample {
  pid: number;
  state: string;
  waitEventType: string | null;
  waitEvent: string | null;
  backendType: string | null;
  application: string;
  username: string;
  database: string;
  queryid: string | null;
  /** Cuánto lleva la consulta actual, en milisegundos. */
  queryMs: number | null;
  /** Cuánto lleva abierta la transacción. Una larga bloquea el vacuum. */
  xactMs: number | null;
  /** Quién la bloquea, si alguien la bloquea. */
  blockedBy: number | null;
  query: string | null;
}

/**
 * `pg_blocking_pids` se llama sólo para las sesiones que esperan un bloqueo:
 * es una función costosa (recorre la tabla de bloqueos por cada llamada) y
 * pedirla para todas las sesiones activas sería el monitor haciendo daño.
 *
 * El texto de la consulta se corta: guardar consultas de megabytes cada diez
 * segundos llenaría el store, y para reconocer qué estaba corriendo alcanza con
 * el principio. Que está cortado se ve en la pantalla.
 */
const SESSIONS_SQL = `
  select pid,
         coalesce(state, 'desconocido')                          as state,
         wait_event_type                                          as wait_event_type,
         wait_event                                               as wait_event,
         backend_type                                             as backend_type,
         coalesce(nullif(application_name, ''), '(sin nombre)')   as application,
         coalesce(usename, '(sin rol)')                           as username,
         coalesce(datname, '(sin base)')                          as database,
         query_id::text                                           as queryid,
         case when query_start is not null
              then extract(epoch from (now() - query_start)) * 1000 end as query_ms,
         case when xact_start is not null
              then extract(epoch from (now() - xact_start)) * 1000 end  as xact_ms,
         case when wait_event_type = 'Lock'
              then (select min(blocker) from unnest(pg_blocking_pids(pid)) as blocker) end as blocked_by,
         left(query, 900)                                         as query
    from pg_stat_activity
   where pid <> pg_backend_pid()
     and backend_type is not null
     and (state in ('active', 'idle in transaction', 'idle in transaction (aborted)')
          or wait_event_type = 'Lock')`;

export async function sampleSessions(pool: Pool): Promise<SessionSample[]> {
  const result = await pool.query<{
    pid: number;
    state: string;
    wait_event_type: string | null;
    wait_event: string | null;
    backend_type: string | null;
    application: string;
    username: string;
    database: string;
    queryid: string | null;
    query_ms: string | null;
    xact_ms: string | null;
    blocked_by: number | null;
    query: string | null;
  }>(tagged(SESSIONS_SQL));

  return result.rows.map((fila) => ({
    pid: Number(fila.pid),
    state: fila.state,
    waitEventType: fila.wait_event_type,
    waitEvent: fila.wait_event,
    backendType: fila.backend_type,
    application: fila.application,
    username: fila.username,
    database: fila.database,
    queryid: fila.queryid,
    queryMs: fila.query_ms === null ? null : Number(fila.query_ms),
    xactMs: fila.xact_ms === null ? null : Number(fila.xact_ms),
    blockedBy: fila.blocked_by === null ? null : Number(fila.blocked_by),
    query: fila.query,
  }));
}

/**
 * Lo que se guarda de cada foto, ya resumido.
 *
 * Hay dos niveles a propósito. El agregado por espera contesta «en qué se va el
 * tiempo» y es barato de consultar sobre semanas. El detalle contesta «qué
 * estaba corriendo a las 3:04» y sólo se guarda de las sesiones que valen la
 * pena, porque guardar todas sería multiplicar el store por el pool de la
 * aplicación.
 */
export interface SessionSnapshot {
  at: Date;
  /** Cuántas sesiones por tipo de espera (o 'CPU' cuando no esperan nada). */
  waits: { waitType: string; waitEvent: string | null; sessions: number }[];
  /** Las que interesa poder reconstruir después. */
  detail: SessionSample[];
  activeSessions: number;
  blockedSessions: number;
  longestQueryMs: number | null;
  longestXactMs: number | null;
}

/**
 * Resume una foto.
 *
 * `wait_event_type` nulo en una sesión activa significa que **no está
 * esperando**: está usando CPU. Guardarlo como nulo y dejar que cada pantalla lo
 * interprete llevaría a leer «sin datos» donde en realidad el dato es el más
 * claro de todos, así que se nombra explícitamente.
 */
export function summarizeSessions(samples: SessionSample[], at = new Date()): SessionSnapshot {
  const porEspera = new Map<string, { waitType: string; waitEvent: string | null; sessions: number }>();
  let activas = 0;
  let bloqueadas = 0;
  let consultaMasLarga: number | null = null;
  let transaccionMasLarga: number | null = null;

  for (const muestra of samples) {
    const activa = muestra.state === 'active';
    if (activa) activas += 1;
    if (muestra.waitEventType === 'Lock') bloqueadas += 1;

    if (activa && muestra.queryMs !== null) {
      consultaMasLarga = Math.max(consultaMasLarga ?? 0, muestra.queryMs);
    }
    if (muestra.xactMs !== null) {
      transaccionMasLarga = Math.max(transaccionMasLarga ?? 0, muestra.xactMs);
    }

    // Sólo las activas cuentan para el desglose de esperas: una sesión con una
    // transacción abierta y sin hacer nada no está esperando al servidor, está
    // esperando a su aplicación, y sumarla inventaría carga que no existe.
    if (!activa) continue;
    const tipo = muestra.waitEventType ?? 'CPU';
    const evento = muestra.waitEventType ? muestra.waitEvent : null;
    const clave = `${tipo}\u0000${evento ?? ''}`;
    const entrada = porEspera.get(clave) ?? { waitType: tipo, waitEvent: evento, sessions: 0 };
    entrada.sessions += 1;
    porEspera.set(clave, entrada);
  }

  // El detalle se recorta a lo que de verdad sirve para reconstruir un incidente:
  // lo que espera un bloqueo, lo que lleva mucho corriendo y las transacciones
  // largas. El resto es ruido que se repetiría cada diez segundos.
  const detalle = samples
    .filter(
      (muestra) =>
        muestra.waitEventType === 'Lock' ||
        (muestra.queryMs ?? 0) > 1000 ||
        (muestra.xactMs ?? 0) > 60_000,
    )
    .sort((a, b) => (b.queryMs ?? 0) - (a.queryMs ?? 0))
    .slice(0, 20);

  return {
    at,
    waits: [...porEspera.values()].sort((a, b) => b.sessions - a.sessions),
    detail: detalle,
    activeSessions: activas,
    blockedSessions: bloqueadas,
    longestQueryMs: consultaMasLarga,
    longestXactMs: transaccionMasLarga,
  };
}
