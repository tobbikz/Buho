import { query } from './db';
import { num } from './format';

export type Severity = 'critical' | 'warning' | 'info';
export type StatStatements = 'active' | 'preloaded_not_created' | 'not_preloaded';

export interface FleetInstance {
  instanceId: number;
  alias: string;
  host: string;
  port: number;
  database: string;
  environment: string;
  engine: string;
  /** Etiquetas declaradas en config.json; la consola agrupa y filtra por ellas. */
  tags: Record<string, string>;
  lastSeenAt: Date | null;
  versionText: string | null;
  versionNum: number | null;
  inRecovery: boolean | null;
  statStatements: StatStatements | null;
  trackIoTiming: boolean | null;
  hasPgMonitor: boolean | null;
  score: number | null;
  critical: number;
  warning: number;
  info: number;
  scoreTs: Date | null;
  connectionsUsedPct: number | null;
  connectionsTotal: number | null;
  connectionsMax: number | null;
  uptimeSeconds: number | null;
  blockedSessions: number | null;
  maxBlockedSeconds: number | null;
  cacheHitPct: number | null;
  xidAgePct: number | null;
  commitsPerSec: number | null;
  rollbacksPerSec: number | null;
  replicationLagSeconds: number | null;
  cpuPct: number | null;
  memUsedPct: number | null;
  mongoMemResidentMb: number | null;
  queriesPerSec: number | null;
  mongoOpsPerSec: number | null;
  /** Sum of insert+update+delete tuple rates when commits/s is not available yet. */
  dmlTuplesPerSec: number | null;
}

/**
 * Métricas etiquetadas (por base de datos, por tabla) se resumen al worst case:
 * en una vista de flota lo que importa es la base más comprometida, no el
 * promedio que la esconde.
 */
const FLEET_SQL = `
with latest as (
  select distinct on (instance_id, metric, labels)
         instance_id, metric, labels, value
    from buho.metric_samples
   where ts > now() - interval '10 minutes'
     and metric = any($1::text[])
   order by instance_id, metric, labels, ts desc
),
metrics as (
  select instance_id,
         max(value) filter (where metric = 'connections_used_pct')          as connections_used_pct,
         max(value) filter (where metric = 'connections_total')             as connections_total,
         max(value) filter (where metric = 'connections_max')               as connections_max,
         max(value) filter (where metric = 'uptime_seconds')                as uptime_seconds,
         max(value) filter (where metric = 'blocked_sessions')              as blocked_sessions,
         max(value) filter (where metric = 'max_blocked_seconds')           as max_blocked_seconds,
         min(value) filter (where metric = 'db_cache_hit_pct')              as cache_hit_pct,
         max(value) filter (where metric = 'xid_age_pct')                   as xid_age_pct,
         sum(value) filter (where metric = 'db_xact_commit_per_sec')        as commits_per_sec,
         sum(value) filter (where metric = 'db_xact_rollback_per_sec')      as rollbacks_per_sec,
         sum(value) filter (where metric in (
           'db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec'
         ))                                                                  as dml_tuples_per_sec,
         max(value) filter (where metric = 'replication_replay_lag_seconds') as replication_lag_seconds,
         max(value) filter (where metric = 'host_cpu_pct')                  as host_cpu_pct,
         max(value) filter (where metric = 'host_mem_used_pct')               as host_mem_used_pct,
         max(value) filter (where metric = 'mongo_mem_resident_mb')           as mongo_mem_resident_mb,
         max(value) filter (where metric = 'queries_total_per_sec')         as queries_per_sec,
         sum(value) filter (where metric in (
           'mongo_op_query_per_sec', 'mongo_op_insert_per_sec', 'mongo_op_update_per_sec',
           'mongo_op_delete_per_sec', 'mongo_op_command_per_sec'
         ))                                                                  as mongo_ops_per_sec
    from latest
   group by instance_id
),
scores as (
  select distinct on (instance_id) instance_id, ts, score, critical, warning, info
    from buho.health_scores
   order by instance_id, ts desc
),
tags as (
  select instance_id, jsonb_object_agg(key, value) as tags
    from buho.instance_tags
   group by instance_id
)
select i.instance_id, i.alias, i.host, i.port, i.database, i.environment, i.engine,
       i.last_seen_at, coalesce(t.tags, '{}'::jsonb) as tags,
       c.version_text, c.version_num, c.in_recovery, c.stat_statements,
       c.track_io_timing, c.has_pg_monitor,
       s.score, s.ts as score_ts,
       coalesce(s.critical, 0) as critical,
       coalesce(s.warning, 0)  as warning,
       coalesce(s.info, 0)     as info,
       m.connections_used_pct, m.connections_total, m.connections_max,
       m.uptime_seconds, m.blocked_sessions, m.max_blocked_seconds, m.cache_hit_pct, m.xid_age_pct,
       m.commits_per_sec, m.rollbacks_per_sec, m.dml_tuples_per_sec, m.replication_lag_seconds,
       m.host_cpu_pct, m.host_mem_used_pct, m.mongo_mem_resident_mb,
       m.queries_per_sec, m.mongo_ops_per_sec
  from buho.instances i
  left join buho.instance_capabilities c on c.instance_id = i.instance_id
  left join scores s on s.instance_id = i.instance_id
  left join tags t on t.instance_id = i.instance_id
  left join metrics m on m.instance_id = i.instance_id
 order by s.score asc nulls first, i.alias`;

const FLEET_METRICS = [
  'connections_used_pct',
  'connections_total',
  'connections_max',
  'uptime_seconds',
  'blocked_sessions',
  'max_blocked_seconds',
  'db_cache_hit_pct',
  'xid_age_pct',
  'db_xact_commit_per_sec',
  'db_xact_rollback_per_sec',
  'db_tup_inserted_per_sec',
  'db_tup_updated_per_sec',
  'db_tup_deleted_per_sec',
  'replication_replay_lag_seconds',
  'host_cpu_pct',
  'host_mem_used_pct',
  'mongo_mem_resident_mb',
  'queries_total_per_sec',
  'mongo_op_query_per_sec',
  'mongo_op_insert_per_sec',
  'mongo_op_update_per_sec',
  'mongo_op_delete_per_sec',
  'mongo_op_command_per_sec',
];

function toFleetInstance(row: Record<string, unknown>): FleetInstance {
  return {
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    host: String(row['host']),
    port: Number(row['port']),
    database: String(row['database']),
    environment: String(row['environment']),
    engine: String(row['engine'] ?? 'postgres'),
    tags: (row['tags'] as Record<string, string> | null) ?? {},
    lastSeenAt: (row['last_seen_at'] as Date | null) ?? null,
    versionText: (row['version_text'] as string | null) ?? null,
    versionNum: num(row['version_num']),
    inRecovery: (row['in_recovery'] as boolean | null) ?? null,
    statStatements: (row['stat_statements'] as StatStatements | null) ?? null,
    trackIoTiming: (row['track_io_timing'] as boolean | null) ?? null,
    hasPgMonitor: (row['has_pg_monitor'] as boolean | null) ?? null,
    score: num(row['score']),
    critical: num(row['critical']) ?? 0,
    warning: num(row['warning']) ?? 0,
    info: num(row['info']) ?? 0,
    scoreTs: (row['score_ts'] as Date | null) ?? null,
    connectionsUsedPct: num(row['connections_used_pct']),
    connectionsTotal: num(row['connections_total']),
    connectionsMax: num(row['connections_max']),
    uptimeSeconds: num(row['uptime_seconds']),
    blockedSessions: num(row['blocked_sessions']),
    maxBlockedSeconds: num(row['max_blocked_seconds']),
    cacheHitPct: num(row['cache_hit_pct']),
    xidAgePct: num(row['xid_age_pct']),
    commitsPerSec: num(row['commits_per_sec']),
    rollbacksPerSec: num(row['rollbacks_per_sec']),
    dmlTuplesPerSec: num(row['dml_tuples_per_sec']),
    replicationLagSeconds: num(row['replication_lag_seconds']),
    cpuPct: num(row['host_cpu_pct']),
    memUsedPct: num(row['host_mem_used_pct']),
    mongoMemResidentMb: num(row['mongo_mem_resident_mb']),
    queriesPerSec: num(row['queries_per_sec']),
    mongoOpsPerSec: num(row['mongo_ops_per_sec']),
  };
}

export async function listInstances(): Promise<FleetInstance[]> {
  const rows = await query<Record<string, unknown>>(FLEET_SQL, [FLEET_METRICS]);
  return rows.map(toFleetInstance);
}

export async function getInstance(instanceId: number): Promise<FleetInstance | null> {
  const rows = await query<Record<string, unknown>>(
    `select * from (${FLEET_SQL}) f where f.instance_id = $2`,
    [FLEET_METRICS, instanceId],
  );
  const row = rows[0];
  return row ? toFleetInstance(row) : null;
}

// -------------------------------------------------------------------- checks

export interface Finding {
  checkId: string;
  title: string;
  severity: Severity;
  object: string | null;
  message: string;
  remediation: string;
  value: number | null;
  ts: Date;
}

export interface FleetFinding extends Finding {
  instanceId: number;
  alias: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const LATEST_FINDINGS_CTE = `
  ultima as (
    select instance_id, max(ts) as ts
      from buho.check_results
     group by instance_id
  ),
  vigentes as (
    select r.*
      from buho.check_results r
      join ultima u on u.instance_id = r.instance_id and u.ts = r.ts
  )`;

/**
 * Findings de la última corrida, a nivel flota. Sirve para modales de critical/warning
 * sin repetir la lógica de agrupación de la pantalla de Checks.
 */
export async function getFleetFindings(
  severities: Severity[] = ['critical', 'warning'],
): Promise<FleetFinding[]> {
  const rows = await query<Record<string, unknown>>(
    `with ${LATEST_FINDINGS_CTE}
     select v.check_id, v.title, v.severity, v.object, v.message, v.remediation, v.value, v.ts,
            v.instance_id, i.alias
       from vigentes v
       join buho.instances i using (instance_id)
      where v.severity = any($1::text[])
      order by v.severity, i.alias, v.check_id, v.object nulls first`,
    [severities],
  );

  return rows
    .map((row) => ({
      instanceId: Number(row['instance_id']),
      alias: String(row['alias']),
      checkId: String(row['check_id']),
      title: String(row['title']),
      severity: row['severity'] as Severity,
      object: (row['object'] as string | null) ?? null,
      message: String(row['message']),
      remediation: String(row['remediation']),
      value: num(row['value']),
      ts: row['ts'] as Date,
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.alias.localeCompare(b.alias) ||
        a.checkId.localeCompare(b.checkId) ||
        (a.object ?? '').localeCompare(b.object ?? ''),
    );
}

/**
 * Los checks se guardan por corrida; la UI muestra únicamente la última.
 * Buscar el max(ts) por separado evita traer el histórico completo.
 */
export async function getFindings(instanceId: number): Promise<Finding[]> {
  const rows = await query<Record<string, unknown>>(
    `select ts, check_id, title, severity, object, message, remediation, value
       from buho.check_results
      where instance_id = $1
        and ts = (select max(ts) from buho.check_results where instance_id = $1)`,
    [instanceId],
  );

  return rows
    .map((row) => ({
      checkId: String(row['check_id']),
      title: String(row['title']),
      severity: row['severity'] as Severity,
      object: (row['object'] as string | null) ?? null,
      message: String(row['message']),
      remediation: String(row['remediation']),
      value: num(row['value']),
      ts: row['ts'] as Date,
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.checkId.localeCompare(b.checkId) ||
        (a.object ?? '').localeCompare(b.object ?? ''),
    );
}

// ------------------------------------------------------------------- series

export interface SeriesPoint {
  bucket: number;
  [metric: string]: number | null;
}

/**
 * Lo que el gráfico puede dibujar.
 *
 * Es más ancho que `SeriesPoint` porque una banda de línea base viaja como el
 * par `[p10, p90]` bajo su propia clave: Recharts pinta un área entre dos
 * valores sólo si el dato es una tupla.
 */
export interface ChartPoint {
  bucket: number;
  [key: string]: number | [number, number] | null | undefined;
}

/**
 * Cómo combinar las etiquetas de una misma métrica en un instante dado.
 *
 * `sum` sirve para contadores y tasas (los commits de cuatro bases se suman).
 * **Nunca** para porcentajes: sumar el cache hit de cuatro bases da 397 %, que
 * fue exactamente el bug que apareció al graficarlo. Para ratios se usa `min`
 * (el worst case, igual que la vista de flota) o `avg`.
 */
export type CrossLabel = 'sum' | 'avg' | 'min' | 'max';

interface SeriesSource {
  relation: string;
  tsColumn: string;
  valueColumn: string;
  label: string;
}

/**
 * De dónde leer una window. Una window de 24 h sobre raw samples de 10 s
 * son ~8.600 filas por métrica y por etiqueta; a 30 días de retención eso se
 * arrastra. Los rollups existían desde F0 pero la UI no los usaba.
 *
 * La columna de valor sigue la intención de la agregación: si el chart pide el
 * worst case, el rollup tiene que dar `min_value`, no el promedio, o el pico
 * desaparece justo en las windows largas donde importa verlo.
 */
export function seriesSource(windowMinutes: number, crossLabel: CrossLabel = 'sum'): SeriesSource {
  const column = crossLabel === 'min' ? 'min_value' : crossLabel === 'max' ? 'max_value' : 'avg_value';

  if (windowMinutes <= 360) {
    return { relation: 'buho.metric_samples', tsColumn: 'ts', valueColumn: 'value', label: 'raw samples' };
  }
  if (windowMinutes <= 3 * 1440) {
    return { relation: 'buho.metric_rollup_5m', tsColumn: 'bucket', valueColumn: column, label: 'rollup 5 m' };
  }
  return { relation: 'buho.metric_rollup_1h', tsColumn: 'bucket', valueColumn: column, label: 'rollup 1 h' };
}

/**
 * Devuelve varias métricas alineadas al mismo bucket para graficarlas juntas.
 * Primero se combinan las etiquetas en cada instante y después se promedia el
 * bucket: al revés el total queda mal cuando el número de etiquetas cambia
 * entre muestras.
 */
export async function getSeries(
  instanceId: number,
  metrics: string[],
  windowMinutes = 60,
  bucketSeconds = 60,
  crossLabel: CrossLabel = 'sum',
): Promise<SeriesPoint[]> {
  const source = seriesSource(windowMinutes, crossLabel);
  const rows = await query<Record<string, unknown>>(
    `with per_ts as (
       select metric, ${source.tsColumn} as ts, ${crossLabel}(${source.valueColumn}) as value
         from ${source.relation}
        where instance_id = $1
          and metric = any($2::text[])
          and ${source.tsColumn} > now() - make_interval(mins => $3::int)
        group by metric, ${source.tsColumn}
     )
     select metric,
            date_bin(make_interval(secs => $4::int), ts, timestamptz 'epoch') as bucket,
            avg(value) as value
       from per_ts
      group by 1, 2
      order by 2`,
    [instanceId, metrics, windowMinutes, bucketSeconds],
  );

  const byBucket = new Map<number, SeriesPoint>();
  for (const row of rows) {
    const bucket = (row['bucket'] as Date).getTime();
    let point = byBucket.get(bucket);
    if (!point) {
      point = { bucket };
      for (const metric of metrics) point[metric] = null;
      byBucket.set(bucket, point);
    }
    point[String(row['metric'])] = num(row['value']);
  }
  return [...byBucket.values()].sort((a, b) => a.bucket - b.bucket);
}

/**
 * Igual que getSeries, pero abre una métrica etiquetada en una serie por
 * etiqueta (las clases de espera, por ejemplo). Se queda con las top N por
 * volumen: veinte líneas en un chart no se leen.
 */
export async function getSeriesByLabel(
  instanceId: number,
  metric: string,
  labelKey: string,
  windowMinutes = 60,
  bucketSeconds = 60,
  topN = 5,
): Promise<{ points: SeriesPoint[]; keys: string[] }> {
  const source = seriesSource(windowMinutes);
  const rows = await query<Record<string, unknown>>(
    `with per_ts as (
       select coalesce(labels->>$5, '(sin dato)') as k,
              ${source.tsColumn} as ts,
              sum(${source.valueColumn}) as value
         from ${source.relation}
        where instance_id = $1
          and metric = $2
          and ${source.tsColumn} > now() - make_interval(mins => $3::int)
        group by 1, 2
     ),
     top as (
       select k from per_ts group by k order by sum(value) desc limit $6
     )
     select p.k,
            date_bin(make_interval(secs => $4::int), p.ts, timestamptz 'epoch') as bucket,
            avg(p.value) as value
       from per_ts p
       join top on top.k = p.k
      group by 1, 2
      order by 2`,
    [instanceId, metric, windowMinutes, bucketSeconds, labelKey, topN],
  );

  const keys: string[] = [];
  const byBucket = new Map<number, SeriesPoint>();
  for (const row of rows) {
    const key = String(row['k']);
    if (!keys.includes(key)) keys.push(key);
    const bucket = (row['bucket'] as Date).getTime();
    let point = byBucket.get(bucket);
    if (!point) {
      point = { bucket };
      byBucket.set(bucket, point);
    }
    point[key] = num(row['value']);
  }

  // Los buckets sin una etiqueta quedan en null explícito, no en undefined:
  // Recharts necesita la clave presente para no cortar la línea.
  const points = [...byBucket.values()].sort((a, b) => a.bucket - b.bucket);
  for (const point of points) {
    for (const key of keys) if (point[key] === undefined) point[key] = null;
  }

  return { points, keys };
}

// ------------------------------------------------------ catálogo de series

export interface AvailableMetric {
  metric: string;
  labelKeys: string[];
}

/**
 * Qué series tiene esta instancia y con qué etiquetas. Se lee del rollup de 5 m
 * y no de las raw samples: son 40 veces menos filas para la misma respuesta
 * (medido en 3 ms contra 24 h de datos).
 *
 * La window de 48 h es a propósito: una métrica que dejó de llegar hace dos
 * días no debería seguir ofreciéndose como si existiera.
 */
export async function listMetrics(instanceId: number): Promise<AvailableMetric[]> {
  const rows = await query<Record<string, unknown>>(
    `select m.metric,
            coalesce(array_agg(distinct k.key) filter (where k.key is not null), '{}') as label_keys
       from (select distinct metric, labels
               from buho.metric_rollup_5m
              where instance_id = $1
                and bucket > now() - interval '48 hours') m
       left join lateral jsonb_object_keys(m.labels) as k(key) on true
      group by m.metric
      order by m.metric`,
    [instanceId],
  );

  return rows.map((row) => ({
    metric: String(row['metric']),
    labelKeys: (row['label_keys'] as string[] | null) ?? [],
  }));
}

// ------------------------------------------------------- recursos del host

export interface HostSummary {
  at: Date;
  cpuPct: number | null;
  iowaitPct: number | null;
  stealPct: number | null;
  memUsedPct: number | null;
  memAvailableBytes: number | null;
  memTotalBytes: number | null;
  swapUsedPct: number | null;
  loadPerCore: number | null;
  cores: number | null;
  diskUsedPct: number | null;
  diskFreeBytes: number | null;
  mount: string | null;
}

/**
 * Último valor de cada métrica del host. Devuelve null cuando la instancia no
 * tiene la recolección configurada, que es el caso por defecto: la pantalla lo
 * explica en vez de mostrar charts vacíos.
 */
export async function getHostSummary(instanceId: number): Promise<HostSummary | null> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (metric)
            metric, value, ts, labels->>'mount' as mount
       from buho.metric_samples
      where instance_id = $1
        and metric like 'host\\_%'
        and ts > now() - interval '15 minutes'
      order by metric, ts desc`,
    [instanceId],
  );
  if (rows.length === 0) return null;

  const byMetric = new Map(rows.map((row) => [String(row['metric']), row]));
  const value = (metric: string): number | null => {
    const row = byMetric.get(metric);
    return row ? num(row['value']) : null;
  };

  const newest = rows.reduce(
    (latest, row) => Math.max(latest, (row['ts'] as Date).getTime()),
    0,
  );

  return {
    at: new Date(newest),
    cpuPct: value('host_cpu_pct'),
    iowaitPct: value('host_cpu_iowait_pct'),
    stealPct: value('host_cpu_steal_pct'),
    memUsedPct: value('host_mem_used_pct'),
    memAvailableBytes: value('host_mem_available_bytes'),
    memTotalBytes: value('host_mem_total_bytes'),
    swapUsedPct: value('host_swap_used_pct'),
    loadPerCore: value('host_load1_per_core'),
    cores: value('host_cores'),
    diskUsedPct: value('host_disk_used_pct'),
    diskFreeBytes: value('host_disk_free_bytes'),
    mount: (byMetric.get('host_disk_used_pct')?.['mount'] as string | null) ?? null,
  };
}

// -------------------------------------------------- análisis por consulta

export type StatementOrder = 'time' | 'calls' | 'mean' | 'rows';

export interface TopStatement {
  queryid: string;
  query: string;
  database: string | null;
  username: string | null;
  calls: number;
  execMs: number;
  meanMs: number;
  rows: number;
  sharedHit: number;
  sharedRead: number;
  tempWritten: number;
  walBytes: number;
  hitPct: number | null;
  lastSeenAt: Date;
}

const STATEMENT_ORDER_SQL: Record<StatementOrder, string> = {
  time: 'sum(s.exec_ms)',
  calls: 'sum(s.calls)',
  mean: 'sum(s.exec_ms) / nullif(sum(s.calls), 0)',
  rows: 'sum(s.rows)',
};

/**
 * Las consultas del propio monitor dominan cualquier ranking por número de
 * llamadas, así que se pueden esconder. El filtro busca la marca en cualquier
 * posición y no como prefijo: el colector la escribe **al final**, porque
 * pg_stat_statements descarta los comentarios que preceden a la sentencia. Con
 * el patrón anclado al inicio el filtro no coincidía never y las consultas del
 * monitor se colaban en todos los rankings.
 *
 * Filtrar por la marca y no por patrones como `pg_stat_%` es lo que evita
 * esconder también las consultas legítimas del DBA sobre el catálogo.
 */
const MONITOR_QUERY_TAG = '%/* buho */%';

export async function getTopStatements(
  instanceId: number,
  windowMinutes = 60,
  order: StatementOrder = 'time',
  hideMonitorQueries = true,
  limit = 25,
  /**
   * Filtro de texto libre sobre la consulta, el rol o la base.
   *
   * Existe para que el diagrama de flujo pueda llevar a algún sitio útil: al
   * pinchar una tabla, la pregunta siguiente siempre es "¿y qué consultas la
   * tocan?", y sin filtro había que buscarla a ojo en una lista de veinticinco.
   */
  search: string | null = null,
): Promise<TopStatement[]> {
  const rows = await query<Record<string, unknown>>(
    `select s.queryid::text                       as queryid,
            t.query,
            max(s.database)                       as database,
            max(s.username)                      as username,
            sum(s.calls)                         as calls,
            sum(s.exec_ms)                       as exec_ms,
            sum(s.exec_ms) / nullif(sum(s.calls), 0) as mean_ms,
            sum(s.rows)                          as rows,
            sum(s.shared_hit)                    as shared_hit,
            sum(s.shared_read)                   as shared_read,
            sum(s.temp_written)                  as temp_written,
            sum(s.wal_bytes)                     as wal_bytes,
            max(s.ts)                            as last_seen_at
       from buho.statement_stats s
       join buho.statement_texts t
         on t.instance_id = s.instance_id and t.queryid = s.queryid
      where s.instance_id = $1
        and s.ts > now() - make_interval(mins => $2::int)
        and ($4::boolean is false or t.query not like $5)
        and ($6::text is null
             or t.query ilike '%' || $6 || '%'
             or s.username ilike '%' || $6 || '%'
             or s.database ilike '%' || $6 || '%')
      group by 1, 2
      order by ${STATEMENT_ORDER_SQL[order]} desc nulls last
      limit $3`,
    [instanceId, windowMinutes, limit, hideMonitorQueries, MONITOR_QUERY_TAG, search],
  );

  return rows.map((row) => {
    const hit = num(row['shared_hit']) ?? 0;
    const read = num(row['shared_read']) ?? 0;
    return {
      queryid: String(row['queryid']),
      query: String(row['query'] ?? ''),
      database: (row['database'] as string | null) ?? null,
      username: (row['username'] as string | null) ?? null,
      calls: num(row['calls']) ?? 0,
      execMs: num(row['exec_ms']) ?? 0,
      meanMs: num(row['mean_ms']) ?? 0,
      rows: num(row['rows']) ?? 0,
      sharedHit: hit,
      sharedRead: read,
      tempWritten: num(row['temp_written']) ?? 0,
      walBytes: num(row['wal_bytes']) ?? 0,
      hitPct: hit + read > 0 ? (hit / (hit + read)) * 100 : null,
      lastSeenAt: row['last_seen_at'] as Date,
    };
  });
}

export interface StatementPoint {
  bucket: number;
  execMs: number;
  calls: number;
}

/**
 * Evolución de cada consulta del top, en una sola consulta al store en vez de
 * una por fila. Sirve para responder lo que el ranking no dice: si algo está
 * caro *ahora* o lleva caro toda la window.
 */
export async function getStatementSeries(
  instanceId: number,
  queryids: string[],
  windowMinutes = 60,
  bucketSeconds = 300,
): Promise<Map<string, StatementPoint[]>> {
  const result = new Map<string, StatementPoint[]>();
  if (queryids.length === 0) return result;

  const rows = await query<Record<string, unknown>>(
    `select queryid::text as queryid,
            date_bin(make_interval(secs => $4::int), ts, timestamptz 'epoch') as bucket,
            sum(exec_ms) as exec_ms,
            sum(calls)   as calls
       from buho.statement_stats
      where instance_id = $1
        and queryid = any($2::bigint[])
        and ts > now() - make_interval(mins => $3::int)
      group by 1, 2
      order by 2`,
    [instanceId, queryids, windowMinutes, bucketSeconds],
  );

  for (const row of rows) {
    const key = String(row['queryid']);
    const points = result.get(key) ?? [];
    points.push({
      bucket: (row['bucket'] as Date).getTime(),
      execMs: num(row['exec_ms']) ?? 0,
      calls: num(row['calls']) ?? 0,
    });
    result.set(key, points);
  }

  return result;
}

/**
 * Carga agregada de consultas. `db_time_sessions` son milisegundos de ejecución
 * per second de reloj: 1.0 equivale a una sesión ocupada a tiempo completo.
 * Es la aproximación honesta a "cuánto trabajo está haciendo la base", porque
 * PostgreSQL no expone CPU del host.
 */
export async function getStatementLoad(
  instanceId: number,
  windowMinutes = 60,
  bucketSeconds = 60,
  hideMonitorQueries = true,
): Promise<SeriesPoint[]> {
  const rows = await query<Record<string, unknown>>(
    `select date_bin(make_interval(secs => $3::int), s.ts, timestamptz 'epoch') as bucket,
            sum(s.exec_ms) / ($3::double precision * 1000.0) as db_time_sessions,
            sum(s.calls) / $3::double precision              as calls_per_sec
       from buho.statement_stats s
       join buho.statement_texts t
         on t.instance_id = s.instance_id and t.queryid = s.queryid
      where s.instance_id = $1
        and s.ts > now() - make_interval(mins => $2::int)
        and ($4::boolean is false or t.query not like $5)
      group by 1
      order by 1`,
    [instanceId, windowMinutes, bucketSeconds, hideMonitorQueries, MONITOR_QUERY_TAG],
  );

  return rows.map((row) => ({
    bucket: (row['bucket'] as Date).getTime(),
    db_time_sessions: num(row['db_time_sessions']),
    calls_per_sec: num(row['calls_per_sec']),
  }));
}

// ----------------------------------------------------- desgloses etiquetados

export interface LabeledValue {
  labels: Record<string, string>;
  value: number;
}

/** Último valor de una métrica etiquetada, una fila por combinación de labels. */
export async function getLabeled(
  instanceId: number,
  metric: string,
  limit = 15,
  windowMinutes = 15,
): Promise<LabeledValue[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (labels) labels, value
       from buho.metric_samples
      where instance_id = $1
        and metric = $2
        and ts > now() - make_interval(mins => $3::int)
      order by labels, ts desc`,
    [instanceId, metric, windowMinutes],
  );

  return rows
    .map((row) => ({
      labels: (row['labels'] as Record<string, string>) ?? {},
      value: num(row['value']) ?? 0,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** Combina dos métricas que comparten etiquetas (tamaño total e indexs, por ejemplo). */
export async function getLabeledPair(
  instanceId: number,
  metricA: string,
  metricB: string,
  limit = 10,
  windowMinutes = 30,
): Promise<Array<LabeledValue & { valueB: number | null }>> {
  const [a, b] = await Promise.all([
    getLabeled(instanceId, metricA, 200, windowMinutes),
    getLabeled(instanceId, metricB, 200, windowMinutes),
  ]);

  const keyOf = (labels: Record<string, string>) =>
    Object.keys(labels)
      .sort()
      .map((key) => `${key}=${labels[key]}`)
      .join(',');

  const bByKey = new Map(b.map((row) => [keyOf(row.labels), row.value]));
  return a.slice(0, limit).map((row) => ({ ...row, valueB: bByKey.get(keyOf(row.labels)) ?? null }));
}

// ------------------------------------------------------------------ bloqueos

export interface LockEpisode {
  episodeId: number;
  active: boolean;
  waiterPid: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  samples: number;
  waitSeconds: number;
  waiterUser: string | null;
  waiterApplication: string | null;
  waiterDatabase: string | null;
  waiterQuery: string;
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
 * "Activo" = visto en el último sampling. El colector escribe cada 10 s, así
 * que 30 s de margen tolera un ciclo perdido sin declarar vivo un bloqueo que
 * ya se resolvió.
 */
const ACTIVE_WINDOW = "interval '30 seconds'";

export async function getLockEpisodes(
  instanceId: number,
  hours = 24,
  limit = 60,
): Promise<LockEpisode[]> {
  const rows = await query<Record<string, unknown>>(
    `select episode_id, waiter_pid, first_seen_at, last_seen_at, samples, wait_seconds,
            waiter_user, waiter_application, waiter_database, waiter_query,
            wait_event, lock_type, lock_mode, lock_object,
            blocker_pids, blocker_pid, blocker_state, blocker_query,
            blocker_user, blocker_application, blocker_xact_seconds,
            last_seen_at > now() - ${ACTIVE_WINDOW} as active
       from buho.lock_episodes
      where instance_id = $1
        and last_seen_at > now() - make_interval(hours => $2::int)
      order by active desc, wait_seconds desc
      limit $3`,
    [instanceId, hours, limit],
  );

  return rows.map((row) => ({
    episodeId: Number(row['episode_id']),
    active: Boolean(row['active']),
    waiterPid: Number(row['waiter_pid']),
    firstSeenAt: row['first_seen_at'] as Date,
    lastSeenAt: row['last_seen_at'] as Date,
    samples: num(row['samples']) ?? 1,
    waitSeconds: num(row['wait_seconds']) ?? 0,
    waiterUser: (row['waiter_user'] as string | null) ?? null,
    waiterApplication: (row['waiter_application'] as string | null) ?? null,
    waiterDatabase: (row['waiter_database'] as string | null) ?? null,
    waiterQuery: String(row['waiter_query'] ?? ''),
    waitEvent: (row['wait_event'] as string | null) ?? null,
    lockType: (row['lock_type'] as string | null) ?? null,
    lockMode: (row['lock_mode'] as string | null) ?? null,
    lockObject: (row['lock_object'] as string | null) ?? null,
    blockerPids: ((row['blocker_pids'] as number[] | null) ?? []).map(Number),
    blockerPid: num(row['blocker_pid']),
    blockerState: (row['blocker_state'] as string | null) ?? null,
    blockerQuery: (row['blocker_query'] as string | null) ?? null,
    blockerUser: (row['blocker_user'] as string | null) ?? null,
    blockerApplication: (row['blocker_application'] as string | null) ?? null,
    blockerXactSeconds: num(row['blocker_xact_seconds']),
  }));
}

// ------------------------------------------------------------------- eventos

export interface CollectorEvent {
  eventId: number;
  ts: Date;
  level: 'info' | 'warn' | 'error';
  component: string;
  message: string;
  instanceId: number | null;
  instanceAlias: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  ackedAt: Date | null;
  ackedBy: string | null;
  detail: unknown | null;
  /** Open feed only: earliest occurrence in the collapsed group. */
  firstTs?: Date | null;
  /** Open feed only: how many matching rows were collapsed. */
  occurrences?: number;
}

export type EventFeedView = 'open' | 'history';

function parseEventDetail(raw: unknown): unknown | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function getEvents(
  instanceId: number | null,
  limit = 100,
  view: EventFeedView = 'open',
): Promise<CollectorEvent[]> {
  if (view === 'open') {
    const rows = await query<Record<string, unknown>>(
      `select max(e.event_id) as event_id,
              max(e.ts) as ts,
              min(e.ts) as first_ts,
              e.level,
              e.component,
              e.message,
              e.instance_id,
              i.alias as instance_alias,
              count(*)::int as occurrences,
              (array_agg(e.detail order by e.ts desc))[1] as detail
         from buho.collector_events e
         left join buho.instances i on i.instance_id = e.instance_id
        where e.status = 'open'
          and ($1::bigint is null or e.instance_id = $1)
        group by e.instance_id, i.alias, e.level, e.component, e.message
        order by max(e.ts) desc
        limit $2`,
      [instanceId, limit],
    );
    return rows.map((row) => ({
      eventId: Number(row['event_id']),
      ts: row['ts'] as Date,
      level: row['level'] as CollectorEvent['level'],
      component: String(row['component']),
      message: String(row['message']),
      instanceId: row['instance_id'] === null ? null : Number(row['instance_id']),
      instanceAlias: (row['instance_alias'] as string | null) ?? null,
      status: 'open' as const,
      ackedAt: null,
      ackedBy: null,
      detail: parseEventDetail(row['detail']),
      firstTs: (row['first_ts'] as Date | null) ?? null,
      occurrences: Number(row['occurrences'] ?? 1),
    }));
  }

  const rows = await query<Record<string, unknown>>(
    `select e.event_id, e.ts, e.level, e.component, e.message, e.detail, e.instance_id,
            i.alias as instance_alias, e.status, e.acked_at, e.acked_by
       from buho.collector_events e
       left join buho.instances i on i.instance_id = e.instance_id
      where ($1::bigint is null or e.instance_id = $1)
      order by e.ts desc
      limit $2`,
    [instanceId, limit],
  );
  return rows.map((row) => ({
    eventId: Number(row['event_id']),
    ts: row['ts'] as Date,
    level: row['level'] as CollectorEvent['level'],
    component: String(row['component']),
    message: String(row['message']),
    instanceId: row['instance_id'] === null ? null : Number(row['instance_id']),
    instanceAlias: (row['instance_alias'] as string | null) ?? null,
    status: String(row['status'] ?? 'open') as CollectorEvent['status'],
    ackedAt: (row['acked_at'] as Date | null) ?? null,
    ackedBy: (row['acked_by'] as string | null) ?? null,
    detail: parseEventDetail(row['detail']),
  }));
}

export async function acknowledgeEvents(eventIds: number[], username: string): Promise<number> {
  if (eventIds.length === 0) return 0;

  const rows = await query<{ count: string }>(
    `with fingerprints as (
       select distinct instance_id, level, component, message
         from buho.collector_events
        where event_id = any($1::bigint[])
     )
     update buho.collector_events e
        set status = 'acknowledged',
            acked_at = now(),
            acked_by = $2
       from fingerprints f
      where e.status = 'open'
        and e.instance_id is not distinct from f.instance_id
        and e.level = f.level
        and e.component = f.component
        and e.message = f.message
     returning 1`,
    [eventIds, username],
  );
  return rows.length;
}

export async function acknowledgeAllOpenEvents(username: string): Promise<number> {
  const rows = await query<{ count: string }>(
    `update buho.collector_events
        set status = 'acknowledged',
            acked_at = now(),
            acked_by = $1
      where status = 'open'
      returning 1`,
    [username],
  );
  return rows.length;
}
