import { query } from './db';
import { logConsoleEvent } from './users';
import { requireAdmin } from './session';
import { hostMetricsFromForm } from './test-target';

/**
 * Targets added from the console.
 *
 * config.json still works for file-based installs. Targets here are picked up
 * by the collector within ~30s without editing a file. Passwords live in the
 * store the same way they already live in config.json on-prem.
 */

export type TargetEngine =
  | 'postgres'
  | 'mariadb'
  | 'mssql'
  | 'mongodb'
  | 'redis'
  | 'oracle'
  | 'cassandra'
  | 'elasticsearch'
  | 'airflow'
  | 'kafka'
  | 'cdc';

export interface MonitorTarget {
  targetId: number;
  alias: string;
  engine: TargetEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  hasPassword: boolean;
  environment: string;
  ssl: boolean;
  tags: Record<string, string>;
  /** Platform extras (airflow / kafka / cdc / endpoint probe). */
  endpoint: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export interface MonitorTargetInput {
  alias: string;
  engine: TargetEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  environment: string;
  ssl: boolean;
  tags?: Record<string, string>;
  hostMetrics?: Record<string, unknown>;
  endpoint?: Record<string, unknown>;
  enabled?: boolean;
  /** PostgreSQL: create one target per connectable database on the host. */
  expandAllDatabases?: boolean;
}

const ENGINES = new Set([
  'postgres',
  'mariadb',
  'mssql',
  'mongodb',
  'redis',
  'oracle',
  'cassandra',
  'elasticsearch',
  'airflow',
  'kafka',
  'cdc',
]);

const DEFAULT_PORTS: Record<TargetEngine, number> = {
  postgres: 5432,
  mariadb: 3306,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
  oracle: 1521,
  cassandra: 9042,
  elasticsearch: 9200,
  airflow: 8080,
  kafka: 9092,
  cdc: 9092,
};

const NO_PASSWORD_OK = new Set(['cassandra', 'elasticsearch', 'airflow', 'kafka', 'cdc']);

export function defaultPort(engine: TargetEngine): number {
  return DEFAULT_PORTS[engine];
}

export async function listMonitorTargets(): Promise<MonitorTarget[]> {
  const rows = await query<Record<string, unknown>>(
    `select target_id, alias, engine, host, port, database, username,
            password <> '' as has_password, environment, ssl, tags, endpoint, enabled,
            created_at, updated_at, created_by
       from buho.monitor_targets
      order by alias`,
  );
  return rows.map((row) => ({
    targetId: Number(row['target_id']),
    alias: String(row['alias']),
    engine: String(row['engine']) as TargetEngine,
    host: String(row['host']),
    port: Number(row['port']),
    database: String(row['database'] ?? ''),
    username: String(row['username']),
    hasPassword: Boolean(row['has_password']),
    environment: String(row['environment'] ?? 'prod'),
    ssl: Boolean(row['ssl']),
    tags:
      row['tags'] && typeof row['tags'] === 'object' && !Array.isArray(row['tags'])
        ? (row['tags'] as Record<string, string>)
        : {},
    endpoint:
      row['endpoint'] && typeof row['endpoint'] === 'object' && !Array.isArray(row['endpoint'])
        ? (row['endpoint'] as Record<string, unknown>)
        : {},
    enabled: Boolean(row['enabled']),
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
    createdBy: (row['created_by'] as string | null) ?? null,
  }));
}

export function parseTargetForm(form: FormData): MonitorTargetInput {
  const engine = String(form.get('engine') ?? 'postgres') as TargetEngine;
  if (!ENGINES.has(engine)) throw new Error(`Unsupported engine: ${engine}`);

  const alias = String(form.get('alias') ?? '').trim();
  const host = String(form.get('host') ?? '').trim();
  const username = String(form.get('username') ?? '').trim();
  if (!alias) throw new Error('Alias is required.');
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    throw new Error('Alias may only contain letters, digits, dots, underscores and hyphens.');
  }
  if (!host) throw new Error('Host is required.');
  if (!username && !NO_PASSWORD_OK.has(engine)) {
    throw new Error('Username is required.');
  }

  const portField = String(form.get('port') ?? '').trim();
  const portRaw = portField ? Number(portField) : defaultPort(engine);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error('Port must be an integer between 1 and 65535.');
  }

  const tags: Record<string, string> = {};
  const tagKey = String(form.get('tagKey') ?? '').trim().toUpperCase();
  const tagValue = String(form.get('tagValue') ?? '').trim();
  if (tagKey && tagValue) tags[tagKey] = tagValue;

  const endpoint: Record<string, unknown> = {};
  if (engine === 'airflow') {
    const baseUrl = String(form.get('airflowBaseUrl') ?? '').trim();
    const airflow: Record<string, unknown> = {
      apiVersion: 'v2',
      ...(baseUrl ? { baseUrl } : {}),
      username: username || undefined,
      password: String(form.get('password') ?? '') || undefined,
    };
    const metaHost = String(form.get('airflowMetaHost') ?? '').trim();
    if (metaHost) {
      airflow.metadata = {
        host: metaHost,
        port: Number(form.get('airflowMetaPort') ?? 5432) || 5432,
        database: String(form.get('airflowMetaDatabase') ?? 'airflow').trim() || 'airflow',
        user: String(form.get('airflowMetaUser') ?? '').trim(),
        password: String(form.get('airflowMetaPassword') ?? ''),
        ssl: form.get('airflowMetaSsl') === 'on',
        engine: 'postgres',
      };
    }
    endpoint.airflow = airflow;
  }
  if (engine === 'kafka' || engine === 'cdc') {
    const brokers = String(form.get('kafkaBrokers') ?? '')
      .split(/[\s,]+/)
      .map((b) => b.trim())
      .filter(Boolean);
    const groups = String(form.get('kafkaGroups') ?? '')
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter(Boolean);
    const kafka = {
      ...(brokers.length ? { brokers } : {}),
      ...(groups.length ? { consumerGroups: groups } : {}),
    };
    if (engine === 'kafka') endpoint.kafka = kafka;
    else {
      endpoint.cdc = {
        kafka,
        topics: String(form.get('cdcTopics') ?? '')
          .split(/[\s,]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        applyGroups: groups,
      };
    }
  }

  return {
    alias,
    engine,
    host,
    port: portRaw,
    database: String(form.get('database') ?? '').trim(),
    username,
    password: String(form.get('password') ?? ''),
    environment: String(form.get('environment') ?? 'PROD').trim().toUpperCase() || 'PROD',
    ssl: form.get('ssl') === 'on',
    tags,
    hostMetrics: hostMetricsFromForm(form),
    endpoint,
    enabled: true,
    expandAllDatabases: form.get('expandAllDatabases') === 'on',
  };
}

async function ensureRetirementSchema(): Promise<void> {
  await query(
    `alter table buho.instances add column if not exists retired boolean not null default false`,
  );
  await query(
    `create table if not exists buho.suppressed_aliases (
       alias text primary key,
       suppressed_at timestamptz not null default now()
     )`,
  );
}

/** Keeps a blank password on an existing console target. */
async function keepStoredPassword(input: MonitorTargetInput): Promise<void> {
  if (input.password) return;
  const existing = await query<{ password: string }>(
    `select password from buho.monitor_targets where tenant = 'default' and alias = $1`,
    [input.alias],
  );
  const kept = existing[0]?.password ?? '';
  if (!kept && !NO_PASSWORD_OK.has(input.engine)) {
    throw new Error('Password is required for a new target.');
  }
  input.password = kept;
}

export async function saveMonitorTarget(input: MonitorTargetInput): Promise<number> {
  const session = await requireAdmin();
  await keepStoredPassword(input);

  const seedDatabase =
    input.database ||
    (input.engine === 'mongodb'
      ? 'admin'
      : input.engine === 'mssql'
        ? 'master'
        : input.engine === 'oracle'
          ? 'FREEPDB1'
          : input.engine === 'redis'
            ? '0'
            : input.engine === 'cassandra' ||
                input.engine === 'elasticsearch' ||
                input.engine === 'airflow' ||
                input.engine === 'kafka' ||
                input.engine === 'cdc'
              ? ''
              : 'postgres');

  let databases = [seedDatabase];
  if (input.engine === 'postgres' && input.expandAllDatabases) {
    try {
      databases = await listPostgresDatabases({
        host: input.host,
        port: input.port,
        database: seedDatabase,
        username: input.username,
        password: input.password,
        ssl: input.ssl,
      });
      if (databases.length === 0) databases = [seedDatabase];
    } catch (error) {
      throw new Error(
        `Could not list databases on ${input.host}: ${
          error instanceof Error ? error.message : String(error)
        }. Grant CONNECT on each database (or uncheck “every database”).`,
      );
    }
  }

  let firstTargetId = 0;
  for (const database of databases) {
    const alias =
      databases.length === 1
        ? input.alias
        : `${input.alias}-${database}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 63);
    const targetId = await upsertOneTarget(
      { ...input, alias, database },
      session.username,
    );
    if (!firstTargetId) firstTargetId = targetId;
  }

  await logConsoleEvent(
    session.username,
    'monitor_target.upsert',
    databases.length > 1
      ? `${input.alias} → ${databases.length} databases on ${input.host}:${input.port}`
      : `${input.alias} (${input.engine}://${input.host}:${input.port}/${seedDatabase})`,
  );

  return firstTargetId;
}

async function upsertOneTarget(
  input: MonitorTargetInput & { database: string },
  username: string,
): Promise<number> {
  const rows = await query<{ target_id: string }>(
    `insert into buho.monitor_targets
       (alias, engine, host, port, database, username, password, environment, ssl, tags, host_metrics, endpoint, enabled, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb, true, $13)
     on conflict (tenant, alias) do update set
       engine = excluded.engine,
       host = excluded.host,
       port = excluded.port,
       database = excluded.database,
       username = excluded.username,
       password = excluded.password,
       environment = excluded.environment,
       ssl = excluded.ssl,
       tags = excluded.tags,
       host_metrics = excluded.host_metrics,
       endpoint = case
         when excluded.endpoint = '{}'::jsonb then buho.monitor_targets.endpoint
         else excluded.endpoint
       end,
       enabled = true,
       updated_at = now()
     returning target_id`,
    [
      input.alias,
      input.engine,
      input.host,
      input.port,
      input.database,
      input.username,
      input.password,
      input.environment,
      input.ssl,
      JSON.stringify(input.tags ?? {}),
      JSON.stringify(input.hostMetrics ?? {}),
      JSON.stringify(input.endpoint ?? {}),
      username,
    ],
  );

  await ensureRetirementSchema();
  await query(`delete from buho.suppressed_aliases where alias = $1`, [input.alias]);
  await query(
    `insert into buho.instances (tenant, alias, host, port, database, environment, engine, last_seen_at, retired)
     values ('default', $1, $2, $3, $4, $5, $6, null, false)
     on conflict (tenant, alias) do update set
       host = excluded.host,
       port = excluded.port,
       database = excluded.database,
       environment = excluded.environment,
       engine = excluded.engine,
       retired = false`,
    [input.alias, input.host, input.port, input.database, input.environment, input.engine],
  );

  const tags = input.tags ?? {};
  const idRows = await query<{ instance_id: string }>(
    `select instance_id from buho.instances where tenant = 'default' and alias = $1`,
    [input.alias],
  );
  const instanceId = Number(idRows[0]?.instance_id);
  if (instanceId) {
    await query(`delete from buho.instance_tags where instance_id = $1`, [instanceId]);
    for (const [key, value] of Object.entries(tags)) {
      await query(
        `insert into buho.instance_tags (instance_id, key, value) values ($1, $2, $3)`,
        [instanceId, key, value],
      );
    }
    // Mark host grouping for multi-DB expands.
    if (input.expandAllDatabases) {
      await query(
        `insert into buho.instance_tags (instance_id, key, value) values ($1, 'HOST', $2)
         on conflict (instance_id, key) do update set value = excluded.value`,
        [instanceId, input.host],
      );
    }
  }

  return Number(rows[0]?.target_id);
}

/** Connectable non-template databases on a PostgreSQL host. */
export async function listPostgresDatabases(input: {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}): Promise<string[]> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    ssl: input.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8_000,
    max: 1,
  });
  try {
    const result = await pool.query<{ datname: string }>(
      `select datname
         from pg_database
        where datallowconn
          and not datistemplate
        order by datname`,
    );
    return result.rows.map((row) => row.datname);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function setTargetEnabled(targetId: number, enabled: boolean): Promise<void> {
  const session = await requireAdmin();
  await query(
    `update buho.monitor_targets set enabled = $2, updated_at = now() where target_id = $1`,
    [targetId, enabled],
  );
  await logConsoleEvent(
    session.username,
    enabled ? 'monitor_target.enable' : 'monitor_target.disable',
    `target_id=${targetId}`,
  );
}

export async function removeMonitorTarget(targetId: number): Promise<void> {
  const session = await requireAdmin();
  const existing = await query<{ alias: string }>(
    `select alias from buho.monitor_targets where target_id = $1`,
    [targetId],
  );
  const alias = existing[0]?.alias;
  if (alias) await retireAlias(alias, session.username, 'monitor_target.delete');
  else {
    await query(`delete from buho.monitor_targets where target_id = $1`, [targetId]);
    await logConsoleEvent(session.username, 'monitor_target.delete', `target_id=${targetId}`);
  }
}

export interface StoredInstance {
  instanceId: number;
  alias: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  environment: string;
  fromConsole: boolean;
}

/** Instances the collector is showing that are not rows in the console target list. */
export async function listOtherInstances(): Promise<StoredInstance[]> {
  await ensureRetirementSchema();
  const rows = await query<Record<string, unknown>>(
    `select i.instance_id, i.alias, i.engine, i.host, i.port, i.database, i.environment,
            exists (
              select 1 from buho.monitor_targets t
               where t.tenant = 'default' and t.alias = i.alias
            ) as from_console
       from buho.instances i
      where coalesce(i.retired, false) = false
        and not exists (
          select 1 from buho.monitor_targets t
           where t.tenant = 'default' and t.alias = i.alias
        )
      order by i.alias`,
  );
  return rows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine'] ?? 'postgres'),
    host: String(row['host']),
    port: Number(row['port']),
    database: String(row['database'] ?? ''),
    environment: String(row['environment'] ?? ''),
    fromConsole: Boolean(row['from_console']),
  }));
}

export interface TargetFormDefaults {
  alias: string;
  engine: string;
  environment: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  tagKey: string;
  tagValue: string;
  hostSource: string;
  dataDirectory: string;
}

export async function getTargetFormDefaults(targetId: number): Promise<TargetFormDefaults | null> {
  const rows = await query<Record<string, unknown>>(
    `select alias, engine, host, port, database, username, environment, ssl, tags, host_metrics
       from buho.monitor_targets
      where target_id = $1`,
    [targetId],
  );
  const row = rows[0];
  if (!row) return null;
  const tags =
    row['tags'] && typeof row['tags'] === 'object' && !Array.isArray(row['tags'])
      ? (row['tags'] as Record<string, string>)
      : {};
  const tagEntry = Object.entries(tags)[0];
  const metrics =
    row['host_metrics'] && typeof row['host_metrics'] === 'object' && !Array.isArray(row['host_metrics'])
      ? (row['host_metrics'] as Record<string, unknown>)
      : {};
  return {
    alias: String(row['alias']),
    engine: String(row['engine']),
    environment: String(row['environment'] ?? 'PROD'),
    host: String(row['host']),
    port: Number(row['port']),
    database: String(row['database'] ?? ''),
    username: String(row['username']),
    ssl: Boolean(row['ssl']),
    tagKey: tagEntry?.[0] ?? '',
    tagValue: tagEntry?.[1] ?? '',
    hostSource: String(metrics['source'] ?? 'local'),
    dataDirectory: String(metrics['dataDirectory'] ?? ''),
  };
}

/** Drops a connection from the fleet, including ones that only exist because of config.json. */
export async function retireInstance(alias: string): Promise<void> {
  const session = await requireAdmin();
  await retireAlias(alias, session.username, 'instance.retire');
}

async function retireAlias(alias: string, username: string, action: string): Promise<void> {
  await ensureRetirementSchema();
  await query(
    `insert into buho.suppressed_aliases (alias) values ($1)
     on conflict (alias) do update set suppressed_at = now()`,
    [alias],
  );
  await query(`delete from buho.monitor_targets where tenant = 'default' and alias = $1`, [alias]);
  await query(
    `update buho.instances set retired = true where tenant = 'default' and alias = $1`,
    [alias],
  );
  try {
    await query(`delete from buho.instances where tenant = 'default' and alias = $1`, [alias]);
  } catch (error) {
    await logConsoleEvent(
      username,
      action,
      `alias=${alias} hidden; history kept (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  await logConsoleEvent(username, action, `alias=${alias}`);
}
