import {
  canForecast,
  historyDayCount,
  MIN_FORECAST_DAYS,
  project,
  type CapacityForecast,
  type CapacityPoint,
} from './capacity';
import { query } from './db';
import { formatBytes } from './format';

export interface EstateDiskInstanceRow {
  instanceId: number;
  alias: string;
  engine: string;
  sizeBytes: number | null;
  measuredAt: Date | null;
  historyDays: number;
  forecast: CapacityForecast | null;
}

export interface EstateDiskSchemaRow {
  instanceId: number;
  alias: string;
  engine: string;
  schema: string;
  sizeBytes: number;
  tableCount: number;
}

export interface EstateDiskTableRow {
  instanceId: number;
  alias: string;
  engine: string;
  schema: string;
  table: string;
  sizeBytes: number;
  indexBytes: number | null;
}

export interface EstateDiskSeries {
  bucket: number;
  total: number | null;
  [instanceAlias: string]: number | null;
}

const SCHEMA_EXPR = `coalesce(labels->>'schema', labels->>'esquema', labels->>'db', '(default)')`;
const TABLE_EXPR = `coalesce(labels->>'table', labels->>'tabla', '(unknown)')`;
const DATABASE_EXPR = `coalesce(labels->>'database', labels->>'db', '')`;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function dailyInstanceBytes(instanceId: number, days: number): Promise<CapacityPoint[]> {
  const rows = await query<Record<string, unknown>>(
    `select date_trunc('day', bucket) as day,
            sum(avg_value) as value
       from buho.metric_rollup_1h
      where instance_id = $1
        and metric = 'database_size_bytes'
        and bucket > now() - make_interval(days => $2::int)
      group by 1
      order by 1`,
    [instanceId, days],
  );
  return rows
    .map((row) => ({
      bucket: (row['day'] as Date).getTime(),
      value: Number(row['value']),
    }))
    .filter((point) => Number.isFinite(point.value));
}

export async function getEstateDiskByInstance(days = 90): Promise<EstateDiskInstanceRow[]> {
  const latest = await query<Record<string, unknown>>(
    `with ranked as (
       select i.instance_id, i.alias, i.engine, i.host, i.port,
              ${DATABASE_EXPR} as database,
              r.avg_value as bytes,
              r.bucket,
              row_number() over (
                partition by i.host, i.port, ${DATABASE_EXPR}
                order by r.bucket desc
              ) as rn
         from buho.instances i
         join buho.metric_rollup_1h r on r.instance_id = i.instance_id
        where r.metric = 'database_size_bytes'
          and r.bucket > now() - interval '3 days'
     )
     select instance_id, alias, engine,
            sum(bytes) as size_bytes,
            max(bucket) as measured_at
       from ranked
      where rn = 1
      group by instance_id, alias, engine, host, port
      order by size_bytes desc nulls last`,
  );

  const historyByInstance = await Promise.all(
    latest.map(async (row) => {
      const instanceId = Number(row['instance_id']);
      const history = await dailyInstanceBytes(instanceId, days);
      const historyDays = historyDayCount(history);
      const current = num(row['size_bytes']);
      const threshold = current && current > 0 ? current * 2 : 0;
      const forecast = canForecast(history)
        ? project('disco', row['alias'] as string, 'bytes', history, threshold, (v) => formatBytes(v))
        : null;
      return {
        instanceId,
        alias: String(row['alias']),
        engine: String(row['engine']),
        sizeBytes: current,
        measuredAt: date(row['measured_at']),
        historyDays,
        forecast,
      };
    }),
  );

  return historyByInstance;
}

export async function getEstateDiskBySchema(limit = 50): Promise<EstateDiskSchemaRow[]> {
  const rows = await query<Record<string, unknown>>(
    `with latest as (
       select r.instance_id,
              ${SCHEMA_EXPR} as schema,
              r.avg_value as bytes,
              row_number() over (
                partition by r.instance_id, ${SCHEMA_EXPR}, ${TABLE_EXPR}
                order by r.bucket desc
              ) as rn
         from buho.metric_rollup_1h r
        where r.metric = 'table_total_bytes'
          and r.bucket > now() - interval '3 days'
     )
     select i.instance_id, i.alias, i.engine, l.schema,
            sum(l.bytes) as size_bytes,
            count(*)::int as table_count
       from latest l
       join buho.instances i on i.instance_id = l.instance_id
      where l.rn = 1
      group by i.instance_id, i.alias, i.engine, l.schema
      order by size_bytes desc
      limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine']),
    schema: String(row['schema']),
    sizeBytes: Number(row['size_bytes']),
    tableCount: Number(row['table_count']),
  }));
}

export async function getEstateDiskByTable(limit = 80): Promise<EstateDiskTableRow[]> {
  const rows = await query<Record<string, unknown>>(
    `with latest_total as (
       select r.instance_id,
              ${SCHEMA_EXPR} as schema,
              ${TABLE_EXPR} as table_name,
              r.avg_value as total_bytes,
              row_number() over (
                partition by r.instance_id, ${SCHEMA_EXPR}, ${TABLE_EXPR}
                order by r.bucket desc
              ) as rn
         from buho.metric_rollup_1h r
        where r.metric = 'table_total_bytes'
          and r.bucket > now() - interval '3 days'
     ),
     latest_index as (
       select r.instance_id,
              ${SCHEMA_EXPR} as schema,
              ${TABLE_EXPR} as table_name,
              r.avg_value as index_bytes,
              row_number() over (
                partition by r.instance_id, ${SCHEMA_EXPR}, ${TABLE_EXPR}
                order by r.bucket desc
              ) as rn
         from buho.metric_rollup_1h r
        where r.metric = 'table_index_bytes'
          and r.bucket > now() - interval '3 days'
     )
     select i.instance_id, i.alias, i.engine,
            t.schema, t.table_name,
            t.total_bytes as size_bytes,
            ix.index_bytes
       from latest_total t
       join buho.instances i on i.instance_id = t.instance_id
       left join latest_index ix
         on ix.instance_id = t.instance_id
        and ix.schema = t.schema
        and ix.table_name = t.table_name
        and ix.rn = 1
      where t.rn = 1
      order by t.total_bytes desc
      limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine']),
    schema: String(row['schema']),
    table: String(row['table_name']),
    sizeBytes: Number(row['size_bytes']),
    indexBytes: num(row['index_bytes']),
  }));
}

/** Fleet total per day, deduped by physical server and database name. */
export async function getEstateDiskFleetHistory(days = 90): Promise<CapacityPoint[]> {
  const rows = await query<Record<string, unknown>>(
    `with hourly as (
       select date_trunc('day', r.bucket) as day,
              i.host, i.port,
              ${DATABASE_EXPR} as database,
              avg(r.avg_value) as bytes
         from buho.metric_rollup_1h r
         join buho.instances i on i.instance_id = r.instance_id
        where r.metric = 'database_size_bytes'
          and r.bucket > now() - make_interval(days => $1::int)
        group by 1, 2, 3, 4
     )
     select day, sum(bytes) as value
       from hourly
      group by 1
      order by 1`,
    [days],
  );

  return rows
    .map((row) => ({
      bucket: (row['day'] as Date).getTime(),
      value: Number(row['value']),
    }))
    .filter((point) => Number.isFinite(point.value));
}

/** Top instances as separate series for a multi-line chart. */
export async function getEstateDiskInstanceSeries(
  days = 90,
  topN = 5,
): Promise<{ keys: string[]; points: EstateDiskSeries[] }> {
  const top = await query<{ alias: string }>(
    `with ranked as (
       select i.alias, r.avg_value as bytes,
              row_number() over (
                partition by i.host, i.port, ${DATABASE_EXPR}
                order by r.bucket desc
              ) as rn
         from buho.instances i
         join buho.metric_rollup_1h r on r.instance_id = i.instance_id
        where r.metric = 'database_size_bytes'
          and r.bucket > now() - interval '3 days'
     )
     select alias, sum(bytes) as total
       from ranked
      where rn = 1
      group by alias
      order by total desc
      limit $1`,
    [topN],
  );

  const keys = top.map((row) => row.alias);
  if (keys.length === 0) return { keys: [], points: [] };

  const rows = await query<Record<string, unknown>>(
    `with hourly as (
       select date_trunc('day', r.bucket) as day,
              i.alias,
              sum(r.avg_value) as bytes
         from buho.metric_rollup_1h r
         join buho.instances i on i.instance_id = r.instance_id
        where r.metric = 'database_size_bytes'
          and r.bucket > now() - make_interval(days => $1::int)
          and i.alias = any($2::text[])
        group by 1, 2
     )
     select day, alias, bytes
       from hourly
      order by day`,
    [days, keys],
  );

  const fleet = await getEstateDiskFleetHistory(days);
  const byBucket = new Map<number, EstateDiskSeries>();
  for (const point of fleet) {
    byBucket.set(point.bucket, { bucket: point.bucket, total: point.value });
  }
  for (const row of rows) {
    const bucket = (row['day'] as Date).getTime();
    const alias = String(row['alias']);
    let point = byBucket.get(bucket);
    if (!point) {
      point = { bucket, total: null };
      byBucket.set(bucket, point);
    }
    point[alias] = Number(row['bytes']);
  }

  return {
    keys,
    points: [...byBucket.values()].sort((a, b) => a.bucket - b.bucket),
  };
}

export async function getEstateDiskFleetForecast(days = 90): Promise<CapacityForecast | null> {
  const history = await getEstateDiskFleetHistory(days);
  if (!canForecast(history)) return null;
  const current = history[history.length - 1]?.value ?? 0;
  const threshold = current > 0 ? current * 2 : 0;
  return project('disco', 'Estate data', 'bytes', history, threshold, (v) => formatBytes(v));
}

export interface EstateDiskEnginePoint {
  bucket: number;
  [engine: string]: number | null;
}

/** Hourly (then daily) total size by engine — growth heat across the fleet. */
export async function getEstateDiskByEngineSeries(
  days = 30,
): Promise<{ keys: string[]; points: EstateDiskEnginePoint[] }> {
  const rows = await query<{ day: Date; engine: string; bytes: string }>(
    `with hourly as (
       select date_trunc('day', r.bucket) as day,
              i.engine,
              i.host, i.port,
              ${DATABASE_EXPR} as database,
              avg(r.avg_value) as bytes
         from buho.metric_rollup_1h r
         join buho.instances i on i.instance_id = r.instance_id
        where r.metric = 'database_size_bytes'
          and r.bucket > now() - make_interval(days => $1::int)
        group by 1, 2, 3, 4, 5
     )
     select day, engine, sum(bytes)::text as bytes
       from hourly
      group by 1, 2
      order by 1, 2`,
    [days],
  );

  const engineSet = new Set<string>();
  const byBucket = new Map<number, EstateDiskEnginePoint>();
  for (const row of rows) {
    const bucket = row.day.getTime();
    const engine = row.engine;
    engineSet.add(engine);
    let point = byBucket.get(bucket);
    if (!point) {
      point = { bucket };
      byBucket.set(bucket, point);
    }
    point[engine] = Number(row.bytes);
  }

  const keys = [...engineSet].sort();
  return {
    keys,
    points: [...byBucket.values()].sort((a, b) => a.bucket - b.bucket),
  };
}

export { MIN_FORECAST_DAYS, canForecast, historyDayCount };
