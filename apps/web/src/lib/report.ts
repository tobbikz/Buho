import { query } from './db';
import { backupState, getBackups, type BackupState } from './estate';
import { num } from './format';

/**
 * Informe semanal: el entregable de la consultoría.
 *
 * A diferencia del resto de la consola, que contesta "qué está pasando ahora",
 * este informe contesta "cómo se portó la semana". Por eso todo aquí es una
 * comparación contra la semana anterior o un extremo del periodo, nunca un
 * valor instantáneo: lo que el cliente paga es la lectura, no el número.
 *
 * Se arma con lo que ya está en el store, sin recolectar nada nuevo, y se
 * puede exportar a Markdown para adjuntarlo al correo del lunes.
 */

export interface ReportWindow {
  /** Semanas hacia atrás: 0 son los últimos siete días, 1 los siete previos. */
  weeksAgo: number;
  from: Date;
  to: Date;
  /** Mismo largo, la semana inmediatamente anterior: la base de comparación. */
  prevFrom: Date;
  prevTo: Date;
}

const WEEK_MS = 7 * 24 * 3600_000;

export function reportWindow(weeksAgo = 0): ReportWindow {
  const to = new Date(Date.now() - weeksAgo * WEEK_MS);
  const from = new Date(to.getTime() - WEEK_MS);
  return {
    weeksAgo,
    from,
    to,
    prevFrom: new Date(from.getTime() - WEEK_MS),
    prevTo: from,
  };
}

export interface ReportMetric {
  avg: number | null;
  max: number | null;
  min: number | null;
  /** Promedio de la semana anterior, para el delta. */
  prevAvg: number | null;
}

export interface ReportTable {
  schema: string;
  table: string;
  deadPct: number | null;
  bloatPct: number | null;
  bloatBytes: number | null;
  lastVacuum: Date | null;
}

export interface ReportQuery {
  queryid: string;
  text: string | null;
  calls: number;
  execMs: number;
  meanMs: number;
}

export interface ReportInstance {
  instanceId: number;
  alias: string;
  engine: string;
  environment: string;
  scoreStart: number | null;
  scoreEnd: number | null;
  critical: number;
  warning: number;
  info: number;
  /** Horas con muestras sobre las horas del periodo: delata caídas del colector. */
  coveragePct: number | null;
  connectionsPct: ReportMetric | null;
  cacheHitPct: ReportMetric | null;
  xidAgePct: ReportMetric | null;
  cpuPct: ReportMetric | null;
  memPct: ReportMetric | null;
  diskPct: ReportMetric | null;
  commitsPerSec: ReportMetric | null;
  replicationLag: ReportMetric | null;
  sizeStartBytes: number | null;
  sizeEndBytes: number | null;
  lockEpisodes: number;
  lockWorstSeconds: number | null;
  logErrors: number;
  logDeadlocks: number;
  logAvailable: boolean;
  worstTables: ReportTable[];
  topQueries: ReportQuery[];
  /**
   * Perfil de espera de la semana: proporción de fotos en cada familia.
   * Null si no hubo muestreo de sesiones (instancia nueva o motor sin datos).
   */
  waitProfile: ReportWaitShare[] | null;
  /** Fotos de sesiones en el periodo: el divisor de los porcentajes. */
  waitSamples: number;
}

export interface ReportWaitShare {
  waitType: string;
  share: number;
  averageSessions: number;
}

export interface ReportAction {
  checkId: string;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  remediation: string;
  message: string;
  instances: string[];
}

export interface ReportBackup {
  alias: string;
  engine: string;
  database: string;
  kind: string;
  state: BackupState;
  finishedAt: Date | null;
  source: string;
}

export interface WeeklyReport {
  window: ReportWindow;
  generatedAt: Date;
  instances: ReportInstance[];
  actions: ReportAction[];
  backups: ReportBackup[];
  totals: {
    instances: number;
    critical: number;
    warning: number;
    scoreAvg: number | null;
    scorePrevAvg: number | null;
    lockEpisodes: number;
    deadlocks: number;
    growthBytes: number | null;
    /** Proporción de tiempo de sesión del parque gastado en bloqueos. */
    lockWaitShare: number | null;
    /** Proporción gastada en disco. */
    ioWaitShare: number | null;
  };
  /**
   * Plan de trabajo de la semana: tres frases, no una lista.
   * Es lo que el cliente paga: la lectura, no el dump de métricas.
   */
  plan: string[];
}

/** Métricas de instancia que interesan como serie resumida en el informe. */
const METRICS = [
  'connections_used_pct',
  'db_cache_hit_pct',
  'xid_age_pct',
  'host_cpu_pct',
  'host_mem_used_pct',
  'host_disk_used_pct',
  'db_xact_commit_per_sec',
  'replication_replay_lag_seconds',
] as const;

type MetricName = (typeof METRICS)[number];

/**
 * Resumen por métrica del periodo y del anterior en una sola pasada.
 *
 * Se lee del rollup de una hora y no de las muestras crudas: una semana de
 * crudas son cientos de miles de filas por instancia, y para un informe
 * semanal la resolución horaria es de sobra.
 */
async function metricSummaries(
  w: ReportWindow,
): Promise<Map<number, Partial<Record<MetricName, ReportMetric>>>> {
  const rows = await query<{
    instance_id: string;
    metric: MetricName;
    avg_value: number | null;
    max_value: number | null;
    min_value: number | null;
    prev_avg: number | null;
  }>(
    `select instance_id,
            metric,
            avg(avg_value) filter (where bucket >= $1 and bucket < $2) as avg_value,
            max(max_value) filter (where bucket >= $1 and bucket < $2) as max_value,
            min(min_value) filter (where bucket >= $1 and bucket < $2) as min_value,
            avg(avg_value) filter (where bucket >= $3 and bucket < $1) as prev_avg
       from buho.metric_rollup_1h
      where metric = any($4)
        and labels = '{}'::jsonb
        and bucket >= $3 and bucket < $2
      group by 1, 2`,
    [w.from, w.to, w.prevFrom, [...METRICS]],
  );

  const byInstance = new Map<number, Partial<Record<MetricName, ReportMetric>>>();
  for (const row of rows) {
    const id = Number(row.instance_id);
    const entry = byInstance.get(id) ?? {};
    entry[row.metric] = {
      avg: num(row.avg_value),
      max: num(row.max_value),
      min: num(row.min_value),
      prevAvg: num(row.prev_avg),
    };
    byInstance.set(id, entry);
  }
  return byInstance;
}

/** Tamaño de la base al principio y al final: el crecimiento de la semana. */
async function sizes(w: ReportWindow): Promise<Map<number, { start: number; end: number }>> {
  const rows = await query<{ instance_id: string; start_bytes: number; end_bytes: number }>(
    `with por_hora as (
       select instance_id, bucket, sum(avg_value) as bytes
         from buho.metric_rollup_1h
        where metric = 'database_size_bytes'
          and bucket >= $1 and bucket < $2
        group by 1, 2
     )
     select instance_id,
            (array_agg(bytes order by bucket))[1]                 as start_bytes,
            (array_agg(bytes order by bucket desc))[1]            as end_bytes
       from por_hora
      group by 1`,
    [w.from, w.to],
  );

  return new Map(
    rows.map((row) => [
      Number(row.instance_id),
      { start: Number(row.start_bytes), end: Number(row.end_bytes) },
    ]),
  );
}

/** Cobertura: horas del periodo con al menos una muestra. */
async function coverage(w: ReportWindow): Promise<Map<number, number>> {
  const hours = Math.max(1, Math.round((w.to.getTime() - w.from.getTime()) / 3600_000));
  const rows = await query<{ instance_id: string; horas: string }>(
    `select instance_id, count(distinct bucket) as horas
       from buho.metric_rollup_1h
      where bucket >= $1 and bucket < $2
      group by 1`,
    [w.from, w.to],
  );
  return new Map(
    rows.map((row) => [Number(row.instance_id), Math.min(100, (Number(row.horas) / hours) * 100)]),
  );
}

/** Score al principio y al final del periodo, con los hallazgos del cierre. */
async function scores(w: ReportWindow): Promise<
  Map<number, { start: number | null; end: number | null; critical: number; warning: number; info: number }>
> {
  const rows = await query<{
    instance_id: string;
    score_start: number | null;
    score_end: number | null;
    critical: number;
    warning: number;
    info: number;
  }>(
    `select instance_id,
            (array_agg(score    order by ts))[1]      as score_start,
            (array_agg(score    order by ts desc))[1] as score_end,
            (array_agg(critical order by ts desc))[1] as critical,
            (array_agg(warning  order by ts desc))[1] as warning,
            (array_agg(info     order by ts desc))[1] as info
       from buho.health_scores
      where ts >= $1 and ts < $2
      group by 1`,
    [w.from, w.to],
  );

  return new Map(
    rows.map((row) => [
      Number(row.instance_id),
      {
        start: num(row.score_start),
        end: num(row.score_end),
        critical: Number(row.critical ?? 0),
        warning: Number(row.warning ?? 0),
        info: Number(row.info ?? 0),
      },
    ]),
  );
}

/** Episodios de bloqueo del periodo y la espera más larga. */
async function locks(w: ReportWindow): Promise<Map<number, { count: number; worst: number | null }>> {
  const rows = await query<{ instance_id: string; episodios: string; peor: number | null }>(
    `select instance_id, count(*) as episodios, max(wait_seconds) as peor
       from buho.lock_episodes
      where last_seen_at >= $1 and last_seen_at < $2
      group by 1`,
    [w.from, w.to],
  );
  return new Map(
    rows.map((row) => [
      Number(row.instance_id),
      { count: Number(row.episodios), worst: num(row.peor) },
    ]),
  );
}

/**
 * Errores y deadlocks leídos del log.
 *
 * Se distingue "cero errores" de "no hay log configurado": son conclusiones
 * opuestas y el informe no puede confundirlas. La presencia de un cursor es lo
 * que dice si de verdad se está leyendo el log de esa instancia.
 */
async function logs(
  w: ReportWindow,
): Promise<Map<number, { errors: number; deadlocks: number; available: boolean }>> {
  const [events, cursors] = await Promise.all([
    query<{ instance_id: string; errores: string; deadlocks: string }>(
      `select instance_id,
              count(*) filter (where kind in ('error', 'fatal', 'panic')) as errores,
              count(*) filter (where kind = 'deadlock')                   as deadlocks
         from buho.log_events
        where at >= $1 and at < $2
        group by 1`,
      [w.from, w.to],
    ),
    query<{ instance_id: string }>(`select instance_id from buho.log_cursors`),
  ]);

  const result = new Map<number, { errors: number; deadlocks: number; available: boolean }>();
  for (const row of cursors) {
    result.set(Number(row.instance_id), { errors: 0, deadlocks: 0, available: true });
  }
  for (const row of events) {
    const id = Number(row.instance_id);
    result.set(id, {
      errors: Number(row.errores),
      deadlocks: Number(row.deadlocks),
      available: result.get(id)?.available ?? true,
    });
  }
  return result;
}

/** Las tablas que peor están hoy: es el estado, no el promedio de la semana. */
async function worstTables(limit = 3): Promise<Map<number, ReportTable[]>> {
  const rows = await query<{
    instance_id: string;
    schema_name: string;
    table_name: string;
    dead_pct: number | null;
    bloat_pct: number | null;
    bloat_bytes: number | null;
    last_vacuum: Date | null;
  }>(
    `select instance_id, schema_name, table_name, dead_pct, bloat_pct, bloat_bytes,
            greatest(last_vacuum, last_autovacuum) as last_vacuum
       from (
         select v.*,
                row_number() over (
                  partition by instance_id
                  order by coalesce(dead_pct, 0) desc, coalesce(bloat_bytes, 0) desc
                ) as puesto
           from buho.vacuum_tables v
          where coalesce(dead_pct, 0) > 5 or coalesce(bloat_pct, 0) > 20
       ) t
      where puesto <= $1`,
    [limit],
  );

  const byInstance = new Map<number, ReportTable[]>();
  for (const row of rows) {
    const id = Number(row.instance_id);
    const list = byInstance.get(id) ?? [];
    list.push({
      schema: row.schema_name,
      table: row.table_name,
      deadPct: num(row.dead_pct),
      bloatPct: num(row.bloat_pct),
      bloatBytes: num(row.bloat_bytes),
      lastVacuum: row.last_vacuum,
    });
    byInstance.set(id, list);
  }
  return byInstance;
}

/** Consultas que más tiempo consumieron en el periodo. */
async function topQueries(w: ReportWindow, limit = 3): Promise<Map<number, ReportQuery[]>> {
  const rows = await query<{
    instance_id: string;
    queryid: string;
    calls: number;
    exec_ms: number;
    query_text: string | null;
  }>(
    `select instance_id, queryid, calls, exec_ms, query_text
       from (
         select s.instance_id,
                s.queryid,
                sum(s.calls)   as calls,
                sum(s.exec_ms) as exec_ms,
                min(t.query) as query_text,
                row_number() over (partition by s.instance_id order by sum(s.exec_ms) desc) as puesto
           from buho.statement_stats s
           left join buho.statement_texts t
                  on t.instance_id = s.instance_id and t.queryid = s.queryid
          where s.ts >= $1 and s.ts < $2
          group by 1, 2
       ) q
      where puesto <= $3`,
    [w.from, w.to, limit],
  );

  const byInstance = new Map<number, ReportQuery[]>();
  for (const row of rows) {
    const id = Number(row.instance_id);
    const list = byInstance.get(id) ?? [];
    const calls = Number(row.calls);
    const execMs = Number(row.exec_ms);
    list.push({
      queryid: String(row.queryid),
      text: row.query_text,
      calls,
      execMs,
      meanMs: calls > 0 ? execMs / calls : 0,
    });
    byInstance.set(id, list);
  }
  return byInstance;
}


/**
 * Perfil de espera de la semana por instancia.
 *
 * Es el dato que convierte "hubo bloqueos" en "el 40 % del tiempo de sesión
 * se fue en Lock": lo que un cliente de consultoría necesita oír el lunes.
 * Misma semántica que la pantalla de Sesiones —proporción de fotos, no cuenta
 * de esperas— para que el informe y la consola no digan cosas distintas.
 */
async function waitProfiles(
  w: ReportWindow,
): Promise<Map<number, { samples: number; waits: ReportWaitShare[] }>> {
  const [fotos, filas] = await Promise.all([
    query<{ instance_id: string; fotos: string }>(
      `select instance_id, count(distinct ts) as fotos
         from buho.wait_samples
        where ts >= $1 and ts < $2
        group by 1`,
      [w.from, w.to],
    ),
    query<{ instance_id: string; wait_type: string; sessions: string }>(
      `select instance_id, wait_type, sum(sessions) as sessions
         from buho.wait_samples
        where ts >= $1 and ts < $2
        group by 1, 2`,
      [w.from, w.to],
    ),
  ]);

  const samples = new Map(fotos.map((row) => [Number(row.instance_id), Number(row.fotos)]));
  const byInstance = new Map<number, { total: number; rows: { waitType: string; sessions: number }[] }>();
  for (const row of filas) {
    const id = Number(row.instance_id);
    const entry = byInstance.get(id) ?? { total: 0, rows: [] };
    const sessions = Number(row.sessions);
    entry.total += sessions;
    entry.rows.push({ waitType: row.wait_type, sessions });
    byInstance.set(id, entry);
  }

  const result = new Map<number, { samples: number; waits: ReportWaitShare[] }>();
  for (const [id, entry] of byInstance) {
    const n = samples.get(id) ?? 0;
    result.set(id, {
      samples: n,
      waits: entry.rows
        .map((row) => ({
          waitType: row.waitType,
          share: entry.total > 0 ? row.sessions / entry.total : 0,
          averageSessions: n > 0 ? row.sessions / n : 0,
        }))
        .sort((a, b) => b.share - a.share),
    });
  }
  return result;
}

/**
 * Acciones recomendadas: los checks abiertos al cierre, agrupados.
 *
 * Se agrupa por check y no por instancia porque el mismo problema en cinco
 * servidores es una sola decisión, y ordenarlo por cuántas instancias toca es
 * lo que convierte una lista de hallazgos en un plan de trabajo.
 */
async function actions(limit = 12): Promise<ReportAction[]> {
  const rows = await query<{
    check_id: string;
    title: string;
    severity: 'critical' | 'warning' | 'info';
    remediation: string;
    message: string;
    aliases: string[];
  }>(
    `with ultima as (
       select instance_id, max(ts) as ts
         from buho.check_results
        group by 1
     )
     select r.check_id,
            min(r.title)                       as title,
            min(r.severity)                    as severity,
            min(r.remediation)                 as remediation,
            min(r.message)                     as message,
            array_agg(distinct i.alias)        as aliases
       from buho.check_results r
       join ultima u on u.instance_id = r.instance_id and u.ts = r.ts
       join buho.instances i on i.instance_id = r.instance_id
      where r.severity in ('critical', 'warning')
      group by r.check_id
      order by min(case r.severity when 'critical' then 0 else 1 end),
               count(distinct r.instance_id) desc
      limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    checkId: row.check_id,
    title: row.title,
    severity: row.severity,
    remediation: row.remediation,
    message: row.message,
    instances: row.aliases,
  }));
}

/**
 * Estado de respaldos al cierre.
 *
 * Se clasifica con la misma función que la pantalla del parque: el informe no
 * puede decir "atrasado" donde la consola dice "ok". Van primero los que no
 * están bien, que es lo que hay que leer.
 */
async function backups(): Promise<ReportBackup[]> {
  const rows = await getBackups();
  const orden: Record<BackupState, number> = {
    sin_recuperacion: 0,
    atrasado: 1,
    no_verificable: 2,
    ok: 3,
  };

  return rows
    .map((row) => ({
      alias: row.alias,
      engine: row.engine,
      database: row.database,
      kind: row.kind,
      state: backupState(row),
      finishedAt: row.finishedAt,
      source: row.source,
    }))
    .sort(
      (a, b) =>
        orden[a.state] - orden[b.state] ||
        a.alias.localeCompare(b.alias) ||
        a.kind.localeCompare(b.kind),
    );
}

export async function getWeeklyReport(weeksAgo = 0): Promise<WeeklyReport> {
  const w = reportWindow(weeksAgo);

  const [
    instances,
    metrics,
    sizeByInstance,
    coverageByInstance,
    scoreByInstance,
    lockByInstance,
    logByInstance,
    tableByInstance,
    queryByInstance,
    waitByInstance,
    actionList,
    backupList,
    prevScores,
  ] = await Promise.all([
    query<{
      instance_id: string;
      alias: string;
      engine: string;
      environment: string;
    }>(
      `select instance_id, alias, engine, environment
         from buho.instances
        order by environment, alias`,
    ),
    metricSummaries(w),
    sizes(w),
    coverage(w),
    scores(w),
    locks(w),
    logs(w),
    worstTables(),
    topQueries(w),
    waitProfiles(w),
    actions(),
    backups(),
    query<{ score_avg: number | null }>(
      `select avg(score) as score_avg
         from buho.health_scores
        where ts >= $1 and ts < $2`,
      [w.prevFrom, w.prevTo],
    ),
  ]);

  const rows: ReportInstance[] = instances.map((instance) => {
    const id = Number(instance.instance_id);
    const m = metrics.get(id) ?? {};
    const score = scoreByInstance.get(id);
    const size = sizeByInstance.get(id);
    const lock = lockByInstance.get(id);
    const log = logByInstance.get(id);

    return {
      instanceId: id,
      alias: instance.alias,
      engine: instance.engine,
      environment: instance.environment,
      scoreStart: score?.start ?? null,
      scoreEnd: score?.end ?? null,
      critical: score?.critical ?? 0,
      warning: score?.warning ?? 0,
      info: score?.info ?? 0,
      coveragePct: coverageByInstance.get(id) ?? null,
      connectionsPct: m.connections_used_pct ?? null,
      cacheHitPct: m.db_cache_hit_pct ?? null,
      xidAgePct: m.xid_age_pct ?? null,
      cpuPct: m.host_cpu_pct ?? null,
      memPct: m.host_mem_used_pct ?? null,
      diskPct: m.host_disk_used_pct ?? null,
      commitsPerSec: m.db_xact_commit_per_sec ?? null,
      replicationLag: m.replication_replay_lag_seconds ?? null,
      sizeStartBytes: size?.start ?? null,
      sizeEndBytes: size?.end ?? null,
      lockEpisodes: lock?.count ?? 0,
      lockWorstSeconds: lock?.worst ?? null,
      logErrors: log?.errors ?? 0,
      logDeadlocks: log?.deadlocks ?? 0,
      logAvailable: log?.available ?? false,
      worstTables: tableByInstance.get(id) ?? [],
      topQueries: queryByInstance.get(id) ?? [],
      waitProfile: waitByInstance.get(id)?.waits ?? null,
      waitSamples: waitByInstance.get(id)?.samples ?? 0,
    };
  });

  const scored = rows.map((row) => row.scoreEnd).filter((value): value is number => value !== null);
  const growth = rows
    .map((row) =>
      row.sizeStartBytes !== null && row.sizeEndBytes !== null
        ? row.sizeEndBytes - row.sizeStartBytes
        : null,
    )
    .filter((value): value is number => value !== null);

  // Pesos del parque: se promedian las instancias que sí tienen muestreo, no
  // se inventa cero para las que no. Un parque a medias con "0 % Lock" mentiría.
  const conEsperas = rows.filter((row) => row.waitProfile && row.waitProfile.length > 0);
  const shareOf = (tipo: string): number | null => {
    if (conEsperas.length === 0) return null;
    const suma = conEsperas.reduce(
      (acc, row) => acc + (row.waitProfile?.find((w) => w.waitType === tipo)?.share ?? 0),
      0,
    );
    return suma / conEsperas.length;
  };
  const lockWaitShare = shareOf('Lock');
  const ioWaitShare = shareOf('IO');

  return {
    window: w,
    generatedAt: new Date(),
    instances: rows,
    actions: actionList,
    backups: backupList,
    plan: buildPlan(rows, actionList, backupList, lockWaitShare, ioWaitShare),
    totals: {
      instances: rows.length,
      critical: rows.reduce((sum, row) => sum + row.critical, 0),
      warning: rows.reduce((sum, row) => sum + row.warning, 0),
      scoreAvg: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      scorePrevAvg: num(prevScores[0]?.score_avg ?? null),
      lockEpisodes: rows.reduce((sum, row) => sum + row.lockEpisodes, 0),
      deadlocks: rows.reduce((sum, row) => sum + row.logDeadlocks, 0),
      growthBytes: growth.length ? growth.reduce((a, b) => a + b, 0) : null,
      lockWaitShare,
      ioWaitShare,
    },
  };
}

/**
 * Tres frases de plan de trabajo.
 *
 * El informe sin esto es un dump de números. Con esto es lo que un DBA le
 * diría al cliente el lunes: qué arreglar primero, qué vigilar y qué está bien.
 * Se corta a tres a propósito: más de eso nadie lee.
 */
function buildPlan(
  rows: ReportInstance[],
  actionList: ReportAction[],
  backupList: ReportBackup[],
  lockWaitShare: number | null,
  ioWaitShare: number | null,
): string[] {
  const plan: string[] = [];

  const criticos = actionList.filter((a) => a.severity === 'critical');
  if (criticos.length > 0) {
    const primero = criticos[0]!;
    plan.push(
      `Prioridad 1: ${primero.title} en ${primero.instances.join(', ')}. ${primero.remediation}`,
    );
  } else if (lockWaitShare !== null && lockWaitShare >= 0.15) {
    const peores = rows
      .filter((r) => (r.waitProfile?.find((w) => w.waitType === 'Lock')?.share ?? 0) >= 0.15)
      .map((r) => r.alias);
    plan.push(
      `Prioridad 1: el parque gastó ${(lockWaitShare * 100).toFixed(0)} % del tiempo de sesión ` +
        `esperando bloqueos${peores.length ? ` (peor en ${peores.slice(0, 3).join(', ')})` : ''}. ` +
        'Acortar transacciones y revisar el orden de los locks: no se arregla con hardware.',
    );
  }

  const atrasados = backupList.filter((b) => b.state === 'atrasado' || b.state === 'sin_recuperacion');
  if (atrasados.length > 0 && plan.length < 3) {
    plan.push(
      `Prioridad ${plan.length + 1}: ${atrasados.length} respaldo${atrasados.length === 1 ? '' : 's'} ` +
        `en mal estado (${[...new Set(atrasados.map((b) => b.alias))].slice(0, 4).join(', ')}). ` +
        'Sin recuperación no hay discusión de rendimiento que importe.',
    );
  }

  if (ioWaitShare !== null && ioWaitShare >= 0.25 && plan.length < 3) {
    plan.push(
      `Prioridad ${plan.length + 1}: ${(ioWaitShare * 100).toFixed(0)} % del tiempo de sesión ` +
        'esperando disco. Revisar caché (shared_buffers / buffer pool) y el almacenamiento ' +
        'antes de subir vCPU.',
    );
  }

  const advertencias = actionList.filter((a) => a.severity === 'warning');
  if (advertencias.length > 0 && plan.length < 3) {
    const a = advertencias[0]!;
    plan.push(
      `Prioridad ${plan.length + 1}: ${a.title} en ${a.instances.slice(0, 3).join(', ')}. ${a.remediation}`,
    );
  }

  if (plan.length === 0) {
    plan.push(
      'La semana no dejó trabajo urgente: sin críticos, sin bloqueos dominantes y con respaldos al día. ' +
        'Conviene revisar igual el crecimiento y las consultas más caras, que es donde se gestan los problemas de la semana que viene.',
    );
  }

  return plan.slice(0, 3);
}
