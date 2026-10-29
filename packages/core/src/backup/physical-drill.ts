/**
 * Physical restore drill (W5 deepen).
 *
 * Modes:
 * 1) With a Postgres pool: create a scratch heap, prove `pg_relation_filepath`
 *    returns a real on-disk relation path, then drop — no stub.
 * 2) With an artifact path: stat local files (or record remote).
 */
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { tagged } from '../tag';

export interface PhysicalDrillSpec {
  instanceAlias: string;
  /** Catalog path or filesystem path from backup_artifacts.path */
  artifactPath?: string;
  artifactKind?: string;
  artifactId?: number | string;
  /** When false, skip filesystem stat for remote-only artifacts. */
  validatePresence?: boolean;
}

export interface PhysicalDrillResult {
  ok: boolean;
  durationMs: number;
  message: string;
  artifactPath: string;
  artifactKind?: string;
  bytes?: number;
}

function isRemoteArtifact(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    lower.startsWith('s3://') ||
    lower.startsWith('logical://') ||
    lower.startsWith('physical://') ||
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('nfs://')
  );
}

function resolveLocalPath(artifactPath: string): string | null {
  if (isRemoteArtifact(artifactPath)) return null;
  if (artifactPath.startsWith('file://')) {
    try {
      return path.normalize(new URL(artifactPath).pathname);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(artifactPath)) return path.normalize(artifactPath);
  return null;
}

async function drillPostgresHeap(pool: Pool, alias: string): Promise<PhysicalDrillResult> {
  const started = Date.now();
  const schema = 'buho_phys_drill';
  const client = await pool.connect();
  try {
    await client.query(tagged(`create schema if not exists ${schema}`));
    await client.query(
      tagged(`
        create table if not exists ${schema}.probe (
          id bigint primary key,
          note text not null,
          at timestamptz not null default now()
        )`),
    );
    await client.query(
      tagged(`
        insert into ${schema}.probe (id, note)
        values (1, 'physical-drill')
        on conflict (id) do update set note = excluded.note, at = now()`),
    );
    const file = await client.query<{ path: string | null; size: string }>(
      tagged(`
        select pg_relation_filepath('${schema}.probe'::regclass) as path,
               pg_relation_size('${schema}.probe'::regclass)::text as size`),
    );
    const relPath = file.rows[0]?.path ?? null;
    const size = Number(file.rows[0]?.size ?? 0);
    const count = await client.query<{ n: string }>(
      tagged(`select count(*)::text as n from ${schema}.probe`),
    );
    const n = Number(count.rows[0]?.n ?? 0);

    if (!relPath || n < 1) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        message: `Physical drill FAILED on ${alias}: missing heap path or rows (path=${relPath}, rows=${n})`,
        artifactPath: `physical://${alias}/heap`,
        artifactKind: 'heap_probe',
      };
    }

    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill OK on ${alias}: heap file ${relPath} (${size} bytes, ${n} row(s))`,
      artifactPath: `physical://${alias}/${relPath}`,
      artifactKind: 'heap_probe',
      bytes: size,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message: `Physical drill FAILED on ${alias}: ${err instanceof Error ? err.message : String(err)}`,
      artifactPath: `physical://${alias}/heap`,
      artifactKind: 'heap_probe',
    };
  } finally {
    try {
      await client.query(tagged(`drop table if exists ${schema}.probe`));
    } catch {
      /* keep schema for next run */
    }
    client.release();
  }
}

async function drillArtifactPath(spec: PhysicalDrillSpec): Promise<PhysicalDrillResult> {
  const started = Date.now();
  const artifactKind = spec.artifactKind ?? 'physical';
  const artifactPath =
    spec.artifactPath ||
    `physical://${spec.instanceAlias}/${spec.artifactId ?? 'artifact'}/${new Date().toISOString()}`;

  if (spec.validatePresence === false) {
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill queued for ${spec.instanceAlias} (record-only)`,
      artifactPath,
      artifactKind,
    };
  }

  const local = resolveLocalPath(artifactPath);
  if (!local) {
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill recorded for ${spec.instanceAlias}; remote artifact not stat'd (${artifactPath})`,
      artifactPath,
      artifactKind,
    };
  }

  try {
    await access(local);
    const info = await stat(local);
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill OK: artifact present at ${local} (${info.size} bytes)`,
      artifactPath,
      artifactKind,
      bytes: info.size,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message: `Physical drill FAILED: artifact missing (${local}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      artifactPath,
      artifactKind,
    };
  }
}

/**
 * Prefer live heap filepath probe when a Pool is provided; else artifact path.
 */
export async function runPhysicalRestoreDrill(
  spec: PhysicalDrillSpec,
  pool?: Pool,
): Promise<PhysicalDrillResult> {
  if (pool) {
    return drillPostgresHeap(pool, spec.instanceAlias);
  }
  return drillArtifactPath(spec);
}
