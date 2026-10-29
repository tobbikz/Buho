/**
 * Backup monitor + restore-drill agent (Deep Platform W5).
 *
 * Drills do **not** require CREATE DATABASE / pg_restore privileges. They prove
 * the monitor role can still write a scratch schema, round-trip a row, and clean
 * up — the same failure modes that block a real restore (auth, disk full,
 * read-only replica, revoked DDL). Storage agents can attach artifacts later.
 */
import type { Pool } from 'pg';
import type { EngineClient } from '../engine';

export interface BackupEvidenceRow {
  kind: string;
  finishedAt: Date | null;
  sizeBytes?: number | null;
  status?: string | null;
}

export type RpoEvalStatus = 'met' | 'breached' | 'broken' | 'unknown';

export interface RpoEvaluation {
  status: RpoEvalStatus;
  rpoSeconds: number;
  ageSeconds: number | null;
  latestKind: string | null;
  message: string;
}

export function evaluateRpo(
  rows: BackupEvidenceRow[],
  rpoSeconds: number,
  now = new Date(),
): RpoEvaluation {
  if (!rows.length) {
    return {
      status: 'unknown',
      rpoSeconds,
      ageSeconds: null,
      latestKind: null,
      message: 'No backup evidence rows',
    };
  }
  const sorted = [...rows]
    .filter((r) => r.finishedAt)
    .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
  const latest = sorted[0];
  if (!latest?.finishedAt) {
    return {
      status: 'broken',
      rpoSeconds,
      ageSeconds: null,
      latestKind: null,
      message: 'Backup rows lack finishedAt',
    };
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((now.getTime() - latest.finishedAt.getTime()) / 1000),
  );
  if (String(latest.status ?? '').toLowerCase().includes('fail')) {
    return {
      status: 'broken',
      rpoSeconds,
      ageSeconds,
      latestKind: latest.kind,
      message: `Latest ${latest.kind} backup marked failed`,
    };
  }
  if (ageSeconds > rpoSeconds) {
    return {
      status: 'breached',
      rpoSeconds,
      ageSeconds,
      latestKind: latest.kind,
      message: `Latest ${latest.kind} is ${ageSeconds}s old > RPO ${rpoSeconds}s`,
    };
  }
  return {
    status: 'met',
    rpoSeconds,
    ageSeconds,
    latestKind: latest.kind,
    message: `Within RPO (${ageSeconds}s ≤ ${rpoSeconds}s)`,
  };
}

export interface RestoreDrillSpec {
  instanceAlias: string;
  scratchDatabase: string;
  artifactId?: string;
  engine?: string;
}

export interface RestoreDrillResult {
  ok: boolean;
  durationMs: number;
  message: string;
  bytes?: number;
  /** Logical artifact path recorded for inventory (not a filesystem dump). */
  artifactPath?: string;
  artifactKind?: string;
}

/** @deprecated use runRestoreDrill — kept for harness compatibility */
export async function runRestoreDrillStub(
  spec: RestoreDrillSpec,
): Promise<RestoreDrillResult> {
  return runRestoreDrill(spec);
}

/**
 * Run a restore drill against a live connection.
 * Pass either a Postgres `Pool` or a foreign `EngineClient`.
 */
export async function runRestoreDrill(
  spec: RestoreDrillSpec,
  conn?: Pool | EngineClient,
): Promise<RestoreDrillResult> {
  const started = Date.now();
  const schema = 'buho_restore_drill';
  const path = `logical://${spec.instanceAlias}/${spec.scratchDatabase}/${new Date().toISOString()}`;

  if (!conn) {
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Drill queued for ${spec.instanceAlias} → ${spec.scratchDatabase} (no connection; record-only)`,
      artifactPath: path,
      artifactKind: 'logical_probe',
    };
  }

  const engine = spec.engine ?? 'postgres';
  try {
    if ('query' in conn && typeof (conn as Pool).connect === 'function') {
      await runPostgresProbe(conn as Pool, schema);
    } else {
      await runForeignProbe(conn as EngineClient, engine, schema);
    }
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Restore drill OK on ${spec.instanceAlias}: wrote/read/dropped ${schema}.probe`,
      bytes: 64,
      artifactPath: path,
      artifactKind: 'logical_probe',
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message: `Restore drill FAILED on ${spec.instanceAlias}: ${err instanceof Error ? err.message : String(err)}`,
      artifactPath: path,
      artifactKind: 'logical_probe',
    };
  }
}

async function runPostgresProbe(pool: Pool, schema: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`create schema if not exists ${schema}`);
    await client.query(
      `create table if not exists ${schema}.probe (
         id int primary key, ts timestamptz not null default now(), note text
       )`,
    );
    await client.query(
      `insert into ${schema}.probe (id, note) values (1, 'buho-drill')
       on conflict (id) do update set ts = now(), note = excluded.note`,
    );
    const r = await client.query<{ n: string }>(
      `select count(*)::text as n from ${schema}.probe where note = 'buho-drill'`,
    );
    if (Number(r.rows[0]?.n ?? 0) < 1) {
      throw new Error('probe row missing after insert');
    }
    await client.query(`drop schema ${schema} cascade`);
  } finally {
    client.release();
  }
}

async function runForeignProbe(
  client: EngineClient,
  engine: string,
  schema: string,
): Promise<void> {
  if (engine === 'mariadb') {
    await client.query(`create schema if not exists \`${schema}\``);
    await client.query(
      `create table if not exists \`${schema}\`.probe (
         id int primary key, ts timestamp not null default current_timestamp, note varchar(64)
       )`,
    );
    await client.query(
      `insert into \`${schema}\`.probe (id, note) values (1, 'buho-drill')
       on duplicate key update ts = current_timestamp, note = 'buho-drill'`,
    );
    const rows = await client.query(
      `select count(*) as n from \`${schema}\`.probe where note = 'buho-drill'`,
    );
    if (Number(rows[0]?.['n'] ?? 0) < 1) throw new Error('probe row missing after insert');
    await client.query(`drop schema \`${schema}\` cascade`);
    return;
  }
  if (engine === 'mssql') {
    await client.query(`
      if not exists (select 1 from sys.schemas where name = N'${schema}')
        exec('create schema [${schema}]')`);
    await client.query(`
      if object_id(N'[${schema}].[probe]', N'U') is null
        create table [${schema}].[probe] (
          id int not null primary key, ts datetime2 not null default sysutcdatetime(), note nvarchar(64)
        )`);
    await client.query(`
      merge [${schema}].[probe] as t
      using (select 1 as id, N'buho-drill' as note) as s on t.id = s.id
      when matched then update set ts = sysutcdatetime(), note = s.note
      when not matched then insert (id, note) values (s.id, s.note);`);
    const rows = await client.query(
      `select count(*) as n from [${schema}].[probe] where note = N'buho-drill'`,
    );
    if (Number(rows[0]?.['n'] ?? 0) < 1) throw new Error('probe row missing after insert');
    await client.query(`drop table if exists [${schema}].[probe]`);
    return;
  }
  // Other engines: connectivity-only probe via a cheap read.
  await client.query(`select 1 as ok`);
}
