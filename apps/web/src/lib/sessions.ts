import { query } from './db';

/**
 * Lecturas del sampling de sessions.
 *
 * Toda esta pantalla se apoya en una idea: con fotos cada diez segundos no se
 * cuentan esperas, se estima **cuánto duraron**. Si una espera aparece en el
 * 40 % de las fotos, ocupó aproximadamente el 40 % del tiempo. Por eso todo se
 * expresa en proporción de fotos y en «sesiones promedio», never en «cantidad de
 * esperas», que sería inventar una cuenta que nadie midió.
 */

export interface WaitShare {
  waitType: string;
  waitEvent: string | null;
  /** Suma de sessions vistas esperando esto. */
  sessions: number;
  /** Sesiones promedio ocupadas en esto durante la window. */
  averageSessions: number;
  share: number;
}

export interface WaitBucket {
  bucket: Date;
  byType: Record<string, number>;
  total: number;
}

export interface SessionRow {
  ts: Date;
  pid: number;
  state: string;
  waitType: string | null;
  waitEvent: string | null;
  application: string;
  username: string;
  database: string;
  queryid: string | null;
  queryMs: number | null;
  xactMs: number | null;
  blockedBy: number | null;
  query: string | null;
}

/** Cuántas fotos hay en la window: es el divisor de todos los porcentajes. */
async function sampleCount(instanceId: number, minutes: number): Promise<number> {
  const filas = await query<{ fotos: number }>(
    `select count(distinct ts) as fotos
       from buho.wait_samples
      where instance_id = $1 and ts > now() - ($2 || ' minutes')::interval
        and not (wait_type = 'Idle' and sessions = 0)`,
    [instanceId, minutes],
  );
  return Number(filas[0]?.fotos ?? 0);
}

export async function getWaitShares(
  instanceId: number,
  minutes: number,
  top = 12,
): Promise<{ waits: WaitShare[]; samples: number; averageBusy: number }> {
  const fotos = await sampleCount(instanceId, minutes);

  const filas = await query<{
    wait_type: string;
    wait_event: string | null;
    sessions: number;
  }>(
    `select wait_type, wait_event, sum(sessions) as sessions
       from buho.wait_samples
      where instance_id = $1 and ts > now() - ($2 || ' minutes')::interval
        and not (wait_type = 'Idle' and sessions = 0)
      group by 1, 2
      order by 3 desc
      limit $3`,
    [instanceId, minutes, top],
  );

  const totalRows = await query<{ total: number }>(
    `select coalesce(sum(sessions), 0) as total
       from buho.wait_samples
      where instance_id = $1 and ts > now() - ($2 || ' minutes')::interval
        and not (wait_type = 'Idle' and sessions = 0)`,
    [instanceId, minutes],
  );
  const total = Number(totalRows[0]?.total ?? 0);

  return {
    samples: fotos,
    // Sesiones promedio ocupadas: es el número que se compara con el número de
    // cores del servidor. Si hay ocho cores y este número es doce, el
    // servidor está por encima de su capacidad de CPU.
    averageBusy: fotos > 0 ? total / fotos : 0,
    waits: filas.map((fila) => ({
      waitType: fila.wait_type,
      waitEvent: fila.wait_event,
      sessions: Number(fila.sessions),
      averageSessions: fotos > 0 ? Number(fila.sessions) / fotos : 0,
      share: total > 0 ? Number(fila.sessions) / total : 0,
    })),
  };
}

/**
 * Serie temporal por tipo de espera, para ver cuándo cambió el perfil.
 *
 * El tamaño del cubo se elige según la window: con cubos fijos, una semana
 * daría sesenta mil puntos y una hora, seis.
 */
export async function getWaitTimeline(instanceId: number, minutes: number): Promise<WaitBucket[]> {
  const segundos = minutes <= 60 ? 60 : minutes <= 360 ? 300 : minutes <= 1440 ? 900 : 3600;

  const filas = await query<{ bucket: Date; wait_type: string; sessions: number; fotos: number }>(
    `select to_timestamp(floor(extract(epoch from ts) / $3) * $3) as bucket,
            wait_type,
            sum(sessions)          as sessions,
            count(distinct ts)     as fotos
       from buho.wait_samples
      where instance_id = $1 and ts > now() - ($2 || ' minutes')::interval
        and not (wait_type = 'Idle' and sessions = 0)
      group by 1, 2
      order by 1`,
    [instanceId, minutes, segundos],
  );

  const cubos = new Map<number, WaitBucket>();
  for (const fila of filas) {
    const clave = new Date(fila.bucket).getTime();
    const cubo = cubos.get(clave) ?? { bucket: new Date(clave), byType: {}, total: 0 };
    // Se divide por las fotos del cubo para que el eje sea "sessions at once" y
    // no "sesiones sumadas", que crecería solo con el tamaño del cubo.
    const promedio = Number(fila.sessions) / Math.max(1, Number(fila.fotos));
    cubo.byType[fila.wait_type] = (cubo.byType[fila.wait_type] ?? 0) + promedio;
    cubo.total += promedio;
    cubos.set(clave, cubo);
  }
  return [...cubos.values()];
}

/**
 * Qué estaba corriendo en un momento dado.
 *
 * Se busca la foto más cercana al instante pedido y no un rango: promediar
 * sessions de fotos distintas mezclaría consultas que never coexistieron, y esta
 * pantalla existe para poder decir «a las 3:04 estas siete sessions estaban
 * esperando a esta otra».
 */
/**
 * Latest Live snapshot. Never returns a sample older than `maxAgeSeconds`
 * (default 30s ≈ 3 collector cycles) — otherwise the UI freezes on a finished
 * pg_restore / long query forever.
 */
export async function getLatestLiveSessions(
  instanceId: number,
  maxAgeSeconds = 30,
): Promise<{ at: Date | null; sessions: SessionRow[]; stale: boolean }> {
  // Prefer the newest wait tick (includes Idle heartbeats) so an empty cycle
  // clears Live instead of replaying the last busy session_samples row.
  const cercana = await query<{ ts: Date }>(
    `select ts
       from buho.wait_samples
      where instance_id = $1
        and ts > now() - ($2::text || ' seconds')::interval
      order by ts desc
      limit 1`,
    [instanceId, String(maxAgeSeconds)],
  );
  const momento = cercana[0]?.ts ?? null;
  if (!momento) {
    return { at: null, sessions: [], stale: true };
  }
  const foto = await loadSessionsAtTs(instanceId, momento);
  return { at: new Date(momento), sessions: foto.sessions, stale: false };
}

export async function getSessionsAt(
  instanceId: number,
  at: Date,
): Promise<{ at: Date | null; sessions: SessionRow[] }> {
  const cercana = await query<{ ts: Date }>(
    `select ts
       from buho.session_samples
      where instance_id = $1
      order by abs(extract(epoch from (ts - $2::timestamptz)))
      limit 1`,
    [instanceId, at.toISOString()],
  );
  const momento = cercana[0]?.ts ?? null;
  if (!momento) return { at: null, sessions: [] };

  return loadSessionsAtTs(instanceId, momento);
}

async function loadSessionsAtTs(
  instanceId: number,
  momento: Date,
): Promise<{ at: Date | null; sessions: SessionRow[] }> {
  const filas = await query<{
    ts: Date;
    pid: number;
    state: string;
    wait_type: string | null;
    wait_event: string | null;
    application: string;
    username: string;
    database: string;
    queryid: string | null;
    query_ms: string | null;
    xact_ms: string | null;
    blocked_by: number | null;
    query: string | null;
  }>(
    `select ts, pid, state, wait_type, wait_event, application, username, database,
            queryid::text as queryid, query_ms, xact_ms, blocked_by, query
       from buho.session_samples
      where instance_id = $1 and ts = $2
      order by coalesce(query_ms, 0) desc`,
    [instanceId, momento],
  );

  return {
    at: new Date(momento),
    sessions: filas.map((fila) => ({
      ts: new Date(fila.ts),
      pid: Number(fila.pid),
      state: fila.state,
      waitType: fila.wait_type,
      waitEvent: fila.wait_event,
      application: fila.application,
      username: fila.username,
      database: fila.database,
      queryid: fila.queryid,
      queryMs: fila.query_ms === null ? null : Number(fila.query_ms),
      xactMs: fila.xact_ms === null ? null : Number(fila.xact_ms),
      blockedBy: fila.blocked_by === null ? null : Number(fila.blocked_by),
      query: fila.query,
    })),
  };
}

/**
 * Los momentos que vale la pena mirar, para no obligar a adivinar una hora.
 *
 * Se ordenan por gravedad y no por tiempo: quien abre esta pantalla después de
 * un incidente quiere el peor momento, no el último.
 */
export async function getInterestingMoments(
  instanceId: number,
  minutes: number,
  limit = 8,
): Promise<{ ts: Date; sessions: number; blocked: number; longestMs: number | null }[]> {
  const filas = await query<{
    ts: Date;
    sessions: number;
    bloqueadas: number;
    mas_larga: string | null;
  }>(
    `select ts,
            count(*)                                        as sessions,
            count(*) filter (where wait_type = 'Lock')      as bloqueadas,
            max(query_ms)                                   as mas_larga
       from buho.session_samples
      where instance_id = $1 and ts > now() - ($2 || ' minutes')::interval
      group by ts
      order by count(*) filter (where wait_type = 'Lock') desc,
               max(query_ms) desc nulls last
      limit $3`,
    [instanceId, minutes, limit],
  );

  return filas.map((fila) => ({
    ts: new Date(fila.ts),
    sessions: Number(fila.sessions),
    blocked: Number(fila.bloqueadas),
    longestMs: fila.mas_larga === null ? null : Number(fila.mas_larga),
  }));
}

export interface SessionDimCount {
  label: string;
  count: number;
}

/** Connections by user from recent session samples (all engines that sample sessions). */
export async function getConnectionsByUser(
  instanceId: number,
  minutes = 60,
  limit = 12,
): Promise<SessionDimCount[]> {
  const rows = await query<{ username: string; count: string }>(
    `select coalesce(nullif(username, ''), '(unknown)') as username,
            count(*)::text as count
       from buho.session_samples
      where instance_id = $1
        and ts >= now() - ($2 || ' minutes')::interval
      group by 1
      order by count(*) desc
      limit $3`,
    [instanceId, minutes, limit],
  );
  return rows.map((row) => ({ label: row.username, count: Number(row.count) }));
}

/** Wait samples grouped by application (foreign + PG). */
export async function getWaitsByApplication(
  instanceId: number,
  minutes = 60,
  limit = 12,
): Promise<Array<SessionDimCount & { waitType: string }>> {
  const rows = await query<{ application: string; wait_type: string; count: string }>(
    `select coalesce(nullif(application, ''), '(unknown)') as application,
            coalesce(nullif(wait_type, ''), '(none)') as wait_type,
            count(*)::text as count
       from buho.session_samples
      where instance_id = $1
        and ts >= now() - ($2 || ' minutes')::interval
        and coalesce(wait_type, '') not in ('', 'Activity')
      group by 1, 2
      order by count(*) desc
      limit $3`,
    [instanceId, minutes, limit],
  );
  return rows.map((row) => ({
    label: row.application,
    waitType: row.wait_type,
    count: Number(row.count),
  }));
}

export { WAIT_TYPE_HELP, waitHelp } from '@/lib/wait-help';
