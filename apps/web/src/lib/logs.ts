import { query } from './db';

/**
 * Lectura del log guardado.
 *
 * La pantalla se organiza por grupo de mensaje y no por entrada: cien errores
 * del mismo `insert` con cien identificadores distintos son un problema, no
 * cien. La huella (mensaje con literales y números normalizados) es lo que los
 * junta.
 */

export type LogKind =
  | 'deadlock'
  | 'lock_wait'
  | 'error'
  | 'fatal'
  | 'connection'
  | 'checkpoint'
  | 'autovacuum'
  | 'temp_file'
  | 'cancelled'
  | 'other';

export interface LogGroup {
  fingerprint: string;
  kind: LogKind;
  level: string;
  times: number;
  firstAt: Date;
  lastAt: Date;
  sample: string;
  detail: string | null;
  hint: string | null;
  sampleQuery: string | null;
  context: string | null;
  sqlstate: string | null;
  databases: string[];
  users: string[];
}

export interface LogCoverage {
  source: string;
  detail: string;
  warnings: string[];
  readAt: Date;
  entries: number;
}

export interface LogTotals {
  fatal: number;
  error: number;
  deadlock: number;
  lockWait: number;
  cancelled: number;
  connection: number;
  total: number;
}

export const KIND_LABEL: Record<LogKind, string> = {
  deadlock: 'Deadlock',
  lock_wait: 'Lock wait',
  error: 'Error',
  fatal: 'Fatal',
  connection: 'Connection',
  checkpoint: 'Checkpoint',
  autovacuum: 'Autovacuum',
  temp_file: 'Temp file',
  cancelled: 'Cancelled',
  other: 'Other',
};

/** Los tipos que representan algo que la aplicación vio fallar. */
export const FAILURE_KINDS: LogKind[] = ['fatal', 'error', 'deadlock', 'cancelled'];

export async function getLogCoverage(instanceId: number): Promise<LogCoverage | null> {
  const rows = await query<{
    source: string;
    detail: string | null;
    warnings: string[];
    read_at: Date;
    entries: string;
  }>(
    `select source, detail, warnings, read_at, entries
       from buho.log_cursors
      where instance_id = $1`,
    [instanceId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    source: row.source,
    detail: row.detail ?? '',
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    readAt: row.read_at,
    entries: Number(row.entries),
  };
}

export async function getLogTotals(instanceId: number, hours = 24): Promise<LogTotals> {
  const rows = await query<{
    fatal: string;
    error: string;
    deadlock: string;
    lock_wait: string;
    cancelled: string;
    connection: string;
    total: string;
  }>(
    `select count(*) filter (where kind = 'fatal')     as fatal,
            count(*) filter (where kind = 'error')     as error,
            count(*) filter (where kind = 'deadlock')  as deadlock,
            count(*) filter (where kind = 'lock_wait') as lock_wait,
            count(*) filter (where kind = 'cancelled') as cancelled,
            count(*) filter (where kind = 'connection') as connection,
            count(*)                                   as total
       from buho.log_events
      where instance_id = $1
        and at >= now() - ($2 || ' hours')::interval`,
    [instanceId, hours],
  );

  const row = rows[0];
  const num = (value: string | undefined) => Number(value ?? 0);
  return {
    fatal: num(row?.fatal),
    error: num(row?.error),
    deadlock: num(row?.deadlock),
    lockWait: num(row?.lock_wait),
    cancelled: num(row?.cancelled),
    connection: num(row?.connection),
    total: num(row?.total),
  };
}

export async function getLogGroups(
  instanceId: number,
  hours = 24,
  kinds: LogKind[] = FAILURE_KINDS,
  limit = 50,
): Promise<LogGroup[]> {
  // `distinct on` para la muestra: se quiere el texto de la ocurrencia más
  // reciente, no uno cualquiera del grupo, porque es el que el operador va a
  // buscar en su aplicación.
  const rows = await query<{
    fingerprint: string;
    kind: LogKind;
    level: string;
    times: string;
    first_at: Date;
    last_at: Date;
    sample: string;
    detail: string | null;
    hint: string | null;
    sample_query: string | null;
    context: string | null;
    sqlstate: string | null;
    databases: (string | null)[];
    users: (string | null)[];
  }>(
    `with log_window as (
       select *
         from buho.log_events
        where instance_id = $1
          and at >= now() - ($2 || ' hours')::interval
          and kind = any($3::text[])
     ),
     grupos as (
       select fingerprint,
              kind,
              count(*)                        as times,
              min(at)                         as first_at,
              max(at)                         as last_at,
              array_agg(distinct database)    as databases,
              array_agg(distinct username)    as users
         from log_window
        group by fingerprint, kind
     ),
     ultima as (
       select distinct on (fingerprint, kind)
              fingerprint, kind, level, message, detail, hint, query, context, sqlstate
         from log_window
        order by fingerprint, kind, at desc
     )
     select g.fingerprint, g.kind, u.level, g.times, g.first_at, g.last_at,
            u.message as sample, u.detail, u.hint, u.query as sample_query,
            u.context, u.sqlstate, g.databases, g.users
       from grupos g
       join ultima u on u.fingerprint = g.fingerprint and u.kind = g.kind
      order by g.times desc, g.last_at desc
      limit $4`,
    [instanceId, hours, kinds, limit],
  );

  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    kind: row.kind,
    level: row.level,
    times: Number(row.times),
    firstAt: row.first_at,
    lastAt: row.last_at,
    sample: row.sample,
    detail: row.detail,
    hint: row.hint,
    sampleQuery: row.sample_query,
    context: row.context,
    sqlstate: row.sqlstate,
    databases: (row.databases ?? []).filter((value): value is string => Boolean(value)),
    users: (row.users ?? []).filter((value): value is string => Boolean(value)),
  }));
}

export interface LogRatePoint {
  bucket: number;
  // Índice para que la serie se pueda pasar tal cual al gráfico.
  [key: string]: number;
  fatal: number;
  error: number;
  deadlock: number;
  cancelled: number;
}

/**
 * Errors por tramo de tiempo.
 *
 * `generate_series` y no sólo los tramos con datos: un hueco en el gráfico
 * significa "no hubo errores", y sin la serie completa se vería como si el
 * tiempo se hubiera saltado.
 */
export async function getLogRate(
  instanceId: number,
  hours = 24,
  bucketMinutes = 15,
): Promise<LogRatePoint[]> {
  const rows = await query<{
    bucket: Date;
    fatal: string;
    error: string;
    deadlock: string;
    cancelled: string;
  }>(
    `with tramos as (
       select generate_series(
                date_bin(($2 || ' minutes')::interval, now() - ($1 || ' hours')::interval, 'epoch'),
                date_bin(($2 || ' minutes')::interval, now(), 'epoch'),
                ($2 || ' minutes')::interval
              ) as bucket
     )
     select t.bucket,
            count(e.*) filter (where e.kind = 'fatal')     as fatal,
            count(e.*) filter (where e.kind = 'error')     as error,
            count(e.*) filter (where e.kind = 'deadlock')  as deadlock,
            count(e.*) filter (where e.kind = 'cancelled') as cancelled
       from tramos t
       left join buho.log_events e
              on e.instance_id = $3
             and e.at >= t.bucket
             and e.at <  t.bucket + ($2 || ' minutes')::interval
      group by t.bucket
      order by t.bucket`,
    [hours, bucketMinutes, instanceId],
  );

  return rows.map((row) => ({
    bucket: row.bucket.getTime(),
    fatal: Number(row.fatal),
    error: Number(row.error),
    deadlock: Number(row.deadlock),
    cancelled: Number(row.cancelled),
  }));
}

export interface FleetLogPattern {
  instanceId: number;
  alias: string;
  engine: string;
  fingerprint: string;
  kind: LogKind;
  level: string;
  times: number;
  lastAt: Date;
  sample: string;
}

export interface FleetLogLevelCount {
  instanceId: number;
  alias: string;
  engine: string;
  level: string;
  times: number;
}

/** Top message fingerprints across the fleet (CRITICAL/ERROR/FATAL style). */
export async function getFleetLogPatterns(
  hours = 24,
  limit = 40,
): Promise<FleetLogPattern[]> {
  const rows = await query<{
    instance_id: string;
    alias: string;
    engine: string;
    fingerprint: string;
    kind: LogKind;
    level: string;
    times: string;
    last_at: Date;
    sample: string;
  }>(
    `select e.instance_id, i.alias, i.engine, e.fingerprint, e.kind, e.level,
            count(*)::text as times, max(e.at) as last_at,
            (array_agg(e.message order by e.at desc))[1] as sample
       from buho.log_events e
       join buho.instances i using (instance_id)
      where e.at >= now() - ($1 || ' hours')::interval
        and (
          e.kind in ('fatal', 'error', 'deadlock', 'cancelled')
          or lower(e.level) in ('fatal', 'panic', 'error', 'critical', 'warning', 'warn')
        )
      group by e.instance_id, i.alias, i.engine, e.fingerprint, e.kind, e.level
      order by count(*) desc, max(e.at) desc
      limit $2`,
    [hours, limit],
  );

  return rows.map((row) => ({
    instanceId: Number(row.instance_id),
    alias: row.alias,
    engine: row.engine,
    fingerprint: row.fingerprint,
    kind: row.kind,
    level: row.level,
    times: Number(row.times),
    lastAt: row.last_at,
    sample: row.sample,
  }));
}

export type FleetLogEvent = {
  id: string;
  instanceId: number;
  alias: string;
  engine: string;
  at: Date;
  level: string;
  kind: LogKind;
  message: string;
  database: string | null;
  username: string | null;
};

/** Recent log lines across the fleet (Observability → Logs). */
export async function listFleetLogEvents(
  hours = 24,
  limit = 200,
): Promise<FleetLogEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `select e.instance_id, i.alias, i.engine, e.at, e.level, e.kind,
            e.message, e.database, e.username, e.fingerprint, e.pid
       from buho.log_events e
       join buho.instances i using (instance_id)
      where e.at >= now() - ($1 || ' hours')::interval
      order by e.at desc
      limit $2`,
    [hours, limit],
  );
  return rows.map((row) => {
    const instanceId = Number(row['instance_id']);
    const at = row['at'] as Date;
    const fingerprint = String(row['fingerprint'] ?? '');
    const pid = row['pid'] == null ? '' : String(row['pid']);
    return {
      id: `${instanceId}:${at.toISOString()}:${fingerprint}:${pid}`,
      instanceId,
      alias: String(row['alias']),
      engine: String(row['engine']),
      at,
      level: String(row['level'] ?? ''),
      kind: row['kind'] as LogKind,
      message: String(row['message'] ?? ''),
      database: (row['database'] as string | null) ?? null,
      username: (row['username'] as string | null) ?? null,
    };
  });
}

/** Counts by instance × log level for the fleet heatmap strip. */
export async function getFleetLogLevelCounts(hours = 24): Promise<FleetLogLevelCount[]> {
  const rows = await query<{
    instance_id: string;
    alias: string;
    engine: string;
    level: string;
    times: string;
  }>(
    `select e.instance_id, i.alias, i.engine, lower(e.level) as level, count(*)::text as times
       from buho.log_events e
       join buho.instances i using (instance_id)
      where e.at >= now() - ($1 || ' hours')::interval
        and lower(e.level) in ('fatal', 'panic', 'error', 'critical', 'warning', 'warn')
      group by e.instance_id, i.alias, i.engine, lower(e.level)
      order by i.alias, times desc`,
    [hours],
  );

  return rows.map((row) => ({
    instanceId: Number(row.instance_id),
    alias: row.alias,
    engine: row.engine,
    level: row.level,
    times: Number(row.times),
  }));
}
