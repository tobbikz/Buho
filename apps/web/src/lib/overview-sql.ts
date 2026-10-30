import pg from 'pg';
import { query } from './db';
import type { OverviewSqlMode } from './overview-layout-types';

const ROW_CAP = 500;
const STATEMENT_TIMEOUT_MS = 8_000;

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|refresh|reindex|vacuum|comment|security|set\s+role|set\s+session)\b/i;

export type SqlTableResult = {
  mode: 'table';
  columns: string[];
  rows: Record<string, string | number | null>[];
};

export type SqlTimeseriesResult = {
  mode: 'timeseries';
  points: { bucket: number; [key: string]: number | null }[];
  seriesKeys: string[];
};

export type SqlBigNumberResult = {
  mode: 'big_number';
  label: string;
  value: number | null;
  display: string;
};

export type SqlBarResult = {
  mode: 'bar';
  rows: { label: string; value: number; display: string }[];
};

export type SqlWidgetResult =
  | SqlTableResult
  | SqlTimeseriesResult
  | SqlBigNumberResult
  | SqlBarResult;

export type SqlTestResult = {
  ok: true;
  message: string;
  columns?: string[];
  planHint?: string;
};

export function assertReadonlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!trimmed) throw new Error('SQL is empty.');
  if (trimmed.includes(';')) throw new Error('Only a single statement is allowed.');
  if (FORBIDDEN.test(trimmed)) throw new Error('Only read-only SELECT / WITH…SELECT is allowed.');
  const head = trimmed.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').replace(/^\s*--[^\n]*\n/g, '');
  if (!/^(with|select)\b/i.test(head)) {
    throw new Error('Query must start with SELECT or WITH.');
  }
  return trimmed;
}

async function targetConn(instanceId: number): Promise<{
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  engine: string;
}> {
  const rows = await query<Record<string, unknown>>(
    `select t.engine, t.host, t.port, t.database, t.username, t.password, t.ssl
       from buho.instances i
       join buho.monitor_targets t
         on t.tenant = 'default' and t.alias = i.alias
      where i.instance_id = $1`,
    [instanceId],
  );
  const row = rows[0];
  if (!row) throw new Error('No Admin → Databases target credentials for this instance.');
  const engine = String(row.engine ?? 'postgres');
  if (engine !== 'postgres') {
    throw new Error('SQL widgets support PostgreSQL targets only in v1.');
  }
  return {
    engine,
    host: String(row.host),
    port: Number(row.port) || 5432,
    database: String(row.database || 'postgres'),
    username: String(row.username || 'postgres'),
    password: String(row.password ?? ''),
    ssl: Boolean(row.ssl),
  };
}

async function withTargetClient<T>(
  instanceId: number,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const conn = await targetConn(instanceId);
  const client = new pg.Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    await client.query(`set statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function cellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTimeseries(fields: string[], rows: Record<string, unknown>[]): SqlTimeseriesResult {
  const lower = fields.map((f) => f.toLowerCase());
  const tsIdx = lower.findIndex((f) => f === 'ts' || f === 'bucket' || f === 'time' || f === 'at');
  const valueIdx = lower.findIndex((f) => f === 'value' || f === 'v' || f === 'y');
  const seriesIdx = lower.findIndex((f) => f === 'series' || f === 'metric' || f === 'name');
  if (tsIdx < 0 || valueIdx < 0) {
    throw new Error('Timeseries mode needs columns ts (timestamptz) and value (numeric).');
  }
  const tsKey = fields[tsIdx]!;
  const valueKey = fields[valueIdx]!;
  const seriesKey = seriesIdx >= 0 ? fields[seriesIdx]! : null;

  const byBucket = new Map<number, { bucket: number; [key: string]: number | null }>();
  const seriesKeys = new Set<string>();

  for (const row of rows) {
    const rawTs = row[tsKey];
    const bucket =
      rawTs instanceof Date
        ? rawTs.getTime()
        : typeof rawTs === 'string' || typeof rawTs === 'number'
          ? new Date(rawTs).getTime()
          : NaN;
    if (!Number.isFinite(bucket)) continue;
    const value = asNumber(row[valueKey]);
    const series = seriesKey ? String(row[seriesKey] ?? 'value') : 'value';
    seriesKeys.add(series);
    let point = byBucket.get(bucket);
    if (!point) {
      point = { bucket };
      byBucket.set(bucket, point);
    }
    point[series] = value;
  }

  const keys = [...seriesKeys];
  const points = [...byBucket.values()]
    .map((p) => {
      for (const k of keys) if (p[k] === undefined) p[k] = null;
      return p;
    })
    .sort((a, b) => a.bucket - b.bucket);

  return { mode: 'timeseries', points, seriesKeys: keys };
}

function toBigNumber(fields: string[], rows: Record<string, unknown>[]): SqlBigNumberResult {
  if (rows.length === 0) {
    return { mode: 'big_number', label: fields[0] ?? 'value', value: null, display: '—' };
  }
  const row = rows[0]!;
  let valueKey = fields.find((f) => asNumber(row[f]) !== null) ?? fields[0];
  if (!valueKey) throw new Error('Big number mode needs at least one numeric column.');
  const value = asNumber(row[valueKey]);
  const labelKey = fields.find((f) => f !== valueKey && typeof row[f] === 'string');
  const label = labelKey ? String(row[labelKey]) : valueKey;
  return {
    mode: 'big_number',
    label,
    value,
    display: value === null ? '—' : String(value),
  };
}

function toBar(fields: string[], rows: Record<string, unknown>[]): SqlBarResult {
  const lower = fields.map((f) => f.toLowerCase());
  const labelIdx = lower.findIndex((f) =>
    ['label', 'name', 'category', 'key', 'series'].includes(f),
  );
  const valueIdx = lower.findIndex((f) => ['value', 'v', 'y', 'count', 'n'].includes(f));
  const labelKey = labelIdx >= 0 ? fields[labelIdx]! : fields[0];
  const valueKey =
    valueIdx >= 0
      ? fields[valueIdx]!
      : fields.find((f) => f !== labelKey) ?? fields[0];
  if (!labelKey || !valueKey) throw new Error('Bar mode needs label + value columns.');

  const out: SqlBarResult['rows'] = [];
  for (const row of rows.slice(0, 40)) {
    const value = asNumber(row[valueKey]);
    if (value === null) continue;
    out.push({
      label: String(row[labelKey] ?? '—'),
      value,
      display: String(value),
    });
  }
  return { mode: 'bar', rows: out };
}

function shapeResult(
  mode: OverviewSqlMode,
  fields: string[],
  rows: Record<string, unknown>[],
): SqlWidgetResult {
  if (mode === 'timeseries') return toTimeseries(fields, rows);
  if (mode === 'big_number') return toBigNumber(fields, rows);
  if (mode === 'bar') return toBar(fields, rows);
  return {
    mode: 'table',
    columns: fields,
    rows: rows.map((row) => {
      const out: Record<string, string | number | null> = {};
      for (const col of fields) out[col] = cellValue(row[col]);
      return out;
    }),
  };
}

/** Validate SQL without returning chart data (EXPLAIN + column probe). */
export async function testOverviewSql(
  instanceId: number,
  sql: string,
  mode: OverviewSqlMode,
): Promise<SqlTestResult> {
  const safeSql = assertReadonlySelect(sql);
  return withTargetClient(instanceId, async (client) => {
    const explain = await client.query(`explain ${safeSql}`);
    const planLines = (explain.rows as Record<string, unknown>[])
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter(Boolean);
    const probe = await client.query(`select * from (${safeSql}) as buho_preview limit 0`);
    const columns = probe.fields.map((f) => f.name);
    if (mode === 'timeseries') {
      const lower = columns.map((c) => c.toLowerCase());
      if (!lower.some((c) => ['ts', 'bucket', 'time', 'at'].includes(c))) {
        throw new Error('Timeseries mode needs a ts/bucket/time column (validated).');
      }
      if (!lower.some((c) => ['value', 'v', 'y'].includes(c))) {
        throw new Error('Timeseries mode needs a value column (validated).');
      }
    }
    if (mode === 'bar' && columns.length < 1) {
      throw new Error('Bar mode needs at least one column.');
    }
    return {
      ok: true as const,
      message: `Valid · ${columns.length} column(s): ${columns.join(', ') || '(none)'}`,
      columns,
      planHint: planLines[0],
    };
  });
}

export async function runOverviewSql(
  instanceId: number,
  sql: string,
  mode: OverviewSqlMode,
): Promise<SqlWidgetResult> {
  const safeSql = assertReadonlySelect(sql);
  return withTargetClient(instanceId, async (client) => {
    // Full preview path: validate plan first (Superset-style), then fetch rows.
    await client.query(`explain ${safeSql}`);
    const result = await client.query(safeSql);
    const fields = result.fields.map((f) => f.name);
    const rows = (result.rows as Record<string, unknown>[]).slice(0, ROW_CAP);
    return shapeResult(mode, fields, rows);
  });
}
