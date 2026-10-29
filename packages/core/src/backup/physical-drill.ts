/**
 * Physical restore drill STUB (W5 deepen).
 *
 * Records drill intent and optionally verifies that a backup artifact exists on
 * a local path. Does **not** run pg_restore / RESTORE DATABASE — safe for lab.
 */
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

export interface PhysicalDrillSpec {
  instanceAlias: string;
  /** Catalog path or filesystem path from backup_artifacts.path */
  artifactPath: string;
  artifactKind?: string;
  artifactId?: number | string;
  /** When false, record-only (same as logical drill without conn). */
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

/**
 * Physical restore drill: intent + optional local artifact stat.
 */
export async function runPhysicalRestoreDrill(
  spec: PhysicalDrillSpec,
): Promise<PhysicalDrillResult> {
  const started = Date.now();
  const artifactKind = spec.artifactKind ?? 'physical';
  const intent = `physical://${spec.instanceAlias}/${spec.artifactId ?? 'artifact'}/${new Date().toISOString()}`;

  if (spec.validatePresence === false) {
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill queued for ${spec.instanceAlias} (record-only; validatePresence=false)`,
      artifactPath: spec.artifactPath || intent,
      artifactKind,
    };
  }

  const local = resolveLocalPath(spec.artifactPath);
  if (!local) {
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill recorded for ${spec.instanceAlias}; remote artifact not stat'd (${spec.artifactPath})`,
      artifactPath: spec.artifactPath,
      artifactKind,
    };
  }

  try {
    await access(local);
    const info = await stat(local);
    if (!info.isFile() && !info.isDirectory()) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        message: `Artifact path is not a file or directory: ${local}`,
        artifactPath: spec.artifactPath,
        artifactKind,
      };
    }
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: `Physical drill OK: artifact present at ${local} (${info.size} bytes)`,
      artifactPath: spec.artifactPath,
      artifactKind,
      bytes: info.size,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message: `Physical drill FAILED: artifact missing or unreadable (${local}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      artifactPath: spec.artifactPath,
      artifactKind,
    };
  }
}
