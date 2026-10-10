import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

export type HostMetricsSource = 'none' | 'local' | 'ssh';

export interface TargetProbeInput {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  hostMetricsSource: HostMetricsSource;
  sshTarget?: string;
  sshIdentityFile?: string;
  dataDirectory?: string;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  detail?: string;
}

export interface TargetProbeResult {
  database: ProbeResult;
  host: ProbeResult;
}

const SAFE_TARGET = /^[A-Za-z0-9._@-]+$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

function defaultDatabase(engine: string): string {
  if (engine === 'oracle') return 'FREEPDB1';
  if (engine === 'mssql') return 'master';
  if (engine === 'mariadb') return 'mysql';
  return 'postgres';
}

export async function probeDatabase(input: TargetProbeInput): Promise<ProbeResult> {
  if (input.engine !== 'postgres') {
    return {
      ok: true,
      message: `Skipped (${input.engine}): database probe is implemented for PostgreSQL only.`,
    };
  }

  const database = input.database.trim() || defaultDatabase(input.engine);
  const pool = new pg.Pool({
    host: input.host,
    port: input.port,
    database,
    user: input.username,
    password: input.password,
    ssl: input.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    max: 1,
  });

  try {
    const client = await pool.connect();
    try {
      const result = await client.query<{ version: string; in_recovery: boolean }>(
        'select version(), pg_is_in_recovery() as in_recovery',
      );
      const row = result.rows[0];
      const version = row?.version?.split(' ').slice(0, 2).join(' ') ?? 'PostgreSQL';
      const role = row?.in_recovery ? 'standby' : 'primary';
      return {
        ok: true,
        message: `Connected (${role})`,
        detail: version,
      };
    } finally {
      client.release();
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function probeLocalHost(dataDirectory?: string): Promise<ProbeResult> {
  const dir = dataDirectory?.trim() || '/var/lib/postgresql';
  if (!SAFE_PATH.test(dir)) {
    return { ok: false, message: `Invalid data directory path: ${dir}` };
  }

  try {
    const { stdout } = await run(
      'sh',
      ['-c', `grep '^cpu ' /proc/stat >/dev/null && nproc && test -d '${dir}' || dirname '${dir}'`],
      { timeout: 5000 },
    );
    const cores = Number(stdout.trim().split('\n').pop());
    return {
      ok: true,
      message: 'Local /proc readable',
      detail: Number.isFinite(cores) ? `${cores} CPU core(s)` : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeSshHost(
  target: string,
  identityFile?: string,
  dataDirectory?: string,
): Promise<ProbeResult> {
  if (!target) return { ok: false, message: 'SSH target is required (user@host).' };
  if (!SAFE_TARGET.test(target)) {
    return { ok: false, message: 'SSH target must be user@host without special characters.' };
  }

  const dir = dataDirectory?.trim() || '/var/lib/postgresql';
  if (!SAFE_PATH.test(dir)) {
    return { ok: false, message: `Invalid data directory path: ${dir}` };
  }

  const body = `grep '^cpu ' /proc/stat && nproc && df -kP '${dir}' 2>/dev/null | tail -1 || df -kP / | tail -1`;
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...(identityFile?.trim() ? ['-i', identityFile.trim()] : []),
    target,
    body,
  ];

  try {
    const { stdout } = await run('ssh', args, { timeout: 10_000, maxBuffer: 64 * 1024 });
    const lines = stdout.trim().split('\n');
    const cores = Number(lines.find((line) => /^\d+$/.test(line.trim())) ?? '');
    return {
      ok: true,
      message: 'SSH host reachable',
      detail: Number.isFinite(cores) ? `${cores} CPU core(s) via ${target}` : target,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeHostMetrics(input: TargetProbeInput): Promise<ProbeResult> {
  if (input.hostMetricsSource === 'none') {
    return { ok: true, message: 'Host metrics disabled (CPU/MEM will show —).' };
  }
  if (input.hostMetricsSource === 'local') {
    return probeLocalHost(input.dataDirectory);
  }
  return probeSshHost(input.sshTarget ?? '', input.sshIdentityFile, input.dataDirectory);
}

export async function probeTarget(input: TargetProbeInput): Promise<TargetProbeResult> {
  const [database, host] = await Promise.all([probeDatabase(input), probeHostMetrics(input)]);
  return { database, host };
}

export function hostMetricsFromForm(form: FormData): Record<string, unknown> {
  const source = String(form.get('hostMetricsSource') ?? 'none') as HostMetricsSource;
  if (source === 'none') return {};

  const dataDirectory = String(form.get('dataDirectory') ?? '').trim();
  if (source === 'local') {
    return {
      source: 'local',
      ...(dataDirectory ? { dataDirectory } : {}),
    };
  }

  const target = String(form.get('sshTarget') ?? '').trim();
  const identityFile = String(form.get('sshIdentityFile') ?? '').trim();
  return {
    source: 'ssh',
    target,
    ...(identityFile ? { identityFile } : {}),
    ...(dataDirectory ? { dataDirectory } : {}),
  };
}

export function probeInputFromForm(form: FormData): TargetProbeInput {
  const engine = String(form.get('engine') ?? 'postgres');
  const portField = String(form.get('port') ?? '').trim();
  const port = portField
    ? Number(portField)
    : engine === 'mssql'
      ? 1433
      : engine === 'mariadb'
        ? 3306
        : engine === 'oracle'
          ? 1521
          : 5432;

  return {
    engine,
    host: String(form.get('host') ?? '').trim(),
    port,
    database: String(form.get('database') ?? '').trim(),
    username: String(form.get('username') ?? '').trim(),
    password: String(form.get('password') ?? ''),
    ssl: form.get('ssl') === 'on',
    hostMetricsSource: String(form.get('hostMetricsSource') ?? 'none') as HostMetricsSource,
    sshTarget: String(form.get('sshTarget') ?? '').trim(),
    sshIdentityFile: String(form.get('sshIdentityFile') ?? '').trim(),
    dataDirectory: String(form.get('dataDirectory') ?? '').trim(),
  };
}
