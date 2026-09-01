import { query } from './db';
import { logConsoleEvent } from './users';
import { requireAdmin } from './session';

/**
 * Targets added from the console.
 *
 * config.json still works for file-based installs. Targets here are picked up
 * by the collector within ~30s without editing a file. Passwords live in the
 * store the same way they already live in config.json on-prem.
 */

export type TargetEngine = 'postgres' | 'mariadb' | 'mssql' | 'mongodb';

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
  enabled?: boolean;
}

const ENGINES = new Set(['postgres', 'mariadb', 'mssql', 'mongodb']);

const DEFAULT_PORTS: Record<TargetEngine, number> = {
  postgres: 5432,
  mariadb: 3306,
  mssql: 1433,
  mongodb: 27017,
};

export function defaultPort(engine: TargetEngine): number {
  return DEFAULT_PORTS[engine];
}

export async function listMonitorTargets(): Promise<MonitorTarget[]> {
  const rows = await query<Record<string, unknown>>(
    `select target_id, alias, engine, host, port, database, username,
            password <> '' as has_password, environment, ssl, tags, enabled,
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
  if (!username) throw new Error('Username is required.');

  const portField = String(form.get('port') ?? '').trim();
  const portRaw = portField ? Number(portField) : defaultPort(engine);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error('Port must be an integer between 1 and 65535.');
  }

  const tags: Record<string, string> = {};
  const tagKey = String(form.get('tagKey') ?? '').trim();
  const tagValue = String(form.get('tagValue') ?? '').trim();
  if (tagKey && tagValue) tags[tagKey] = tagValue;

  return {
    alias,
    engine,
    host,
    port: portRaw,
    database: String(form.get('database') ?? '').trim(),
    username,
    password: String(form.get('password') ?? ''),
    environment: String(form.get('environment') ?? 'prod').trim() || 'prod',
    ssl: form.get('ssl') === 'on',
    tags,
    enabled: true,
  };
}

export async function saveMonitorTarget(input: MonitorTargetInput): Promise<number> {
  const session = await requireAdmin();
  if (!input.password) {
    throw new Error('Password is required for a new target.');
  }

  const database =
    input.database ||
    (input.engine === 'mongodb' ? 'admin' : input.engine === 'mssql' ? 'master' : 'postgres');

  const rows = await query<{ target_id: string }>(
    `insert into buho.monitor_targets
       (alias, engine, host, port, database, username, password, environment, ssl, tags, enabled, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, true, $11)
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
       enabled = true,
       updated_at = now()
     returning target_id`,
    [
      input.alias,
      input.engine,
      input.host,
      input.port,
      database,
      input.username,
      input.password,
      input.environment,
      input.ssl,
      JSON.stringify(input.tags ?? {}),
      session.username,
    ],
  );

  // Fleet shows the instance before the collector's first sample.
  await query(
    `insert into buho.instances (tenant, alias, host, port, database, environment, engine, last_seen_at)
     values ('default', $1, $2, $3, $4, $5, $6, now())
     on conflict (tenant, alias) do update set
       host = excluded.host,
       port = excluded.port,
       database = excluded.database,
       environment = excluded.environment,
       engine = excluded.engine,
       last_seen_at = now()`,
    [input.alias, input.host, input.port, database, input.environment, input.engine],
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
  }

  await logConsoleEvent(
    session.username,
    'monitor_target.upsert',
    `${input.alias} (${input.engine}://${input.host}:${input.port})`,
  );

  return Number(rows[0]?.target_id);
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
    `delete from buho.monitor_targets where target_id = $1 returning alias`,
    [targetId],
  );
  const alias = existing[0]?.alias;
  await logConsoleEvent(
    session.username,
    'monitor_target.delete',
    alias ? `alias=${alias}` : `target_id=${targetId}`,
  );
}
