import {
  BACKUP_STALE_HOURS,
  backupAgeHours,
  backupKindLabel,
  backupState,
  backupStateLabel,
  getBackups,
  getEngineVersions,
  type BackupRow,
} from '@/lib/estate';
import { formatDuration } from '@/lib/format';

/** SQL engines in product scope — RPO tab ignores endpoints / out-of-scope. */
const SQL_ENGINES = new Set(['postgres', 'mssql', 'mariadb', 'oracle']);

export type RpoStatus = 'met' | 'breached' | 'unknown' | 'broken';

export interface InstanceRpo {
  instanceId: number;
  alias: string;
  engine: string;
  /** Target RPO in seconds (default 15m unless engine posture says otherwise). */
  targetSeconds: number;
  /** true when target came from instance tag rpo_seconds / rpo_hours. */
  targetFromTag: boolean;
  /** Best provable exposure — how much data you could lose right now. */
  exposureSeconds: number | null;
  status: RpoStatus;
  /** Short label for the controlling signal (WAL / log backup / binlog / …). */
  signal: string;
  /** One-line DBA explanation. */
  detail: string;
  /** Engine-specific how we measure. */
  method: string;
  href: string;
}

const DEFAULT_TARGET_SECONDS = 15 * 60;

function targetFromTags(tags: Record<string, string> | undefined): {
  seconds: number;
  fromTag: boolean;
} {
  if (!tags) return { seconds: DEFAULT_TARGET_SECONDS, fromTag: false };
  const secRaw = tags['rpo_seconds'] ?? tags['rpo'];
  const sec = Number(secRaw);
  if (Number.isFinite(sec) && sec > 0) return { seconds: sec, fromTag: true };
  const hours = Number(tags['rpo_hours']);
  if (Number.isFinite(hours) && hours > 0) return { seconds: hours * 3600, fromTag: true };
  return { seconds: DEFAULT_TARGET_SECONDS, fromTag: false };
}

function statusOf(
  exposureSeconds: number | null,
  targetSeconds: number,
  broken: boolean,
): RpoStatus {
  if (broken) return 'broken';
  if (exposureSeconds === null) return 'unknown';
  return exposureSeconds <= targetSeconds ? 'met' : 'breached';
}

function fmtExposure(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return formatDuration(seconds);
}

function ageSeconds(row: BackupRow): number | null {
  const h = backupAgeHours(row);
  return h === null ? null : h * 3600;
}

function postgresRpo(rows: BackupRow[], targetSeconds: number): Omit<
  InstanceRpo,
  'instanceId' | 'alias' | 'engine' | 'href' | 'targetFromTag'
> {
  const wal = rows.find((r) => r.kind === 'wal_archive');
  const method =
    'PostgreSQL: provable RPO needs archive_mode=on (WAL). Dump/pgBackRest age is separate.';

  if (!wal) {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'unknown',
      signal: 'No WAL archive signal',
      detail: 'Collector has not reported pg_stat_archiver yet.',
      method,
    };
  }

  if (wal.detail['archive_mode'] === 'off') {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'broken',
      signal: 'Archive off',
      detail:
        'archive_mode=off — point-in-time recovery is unavailable. Crash recovery only to last checkpoint; RPO cannot be met for continuous protect.',
      method,
    };
  }

  // Prefer last_archived_time from detail when present; else finishedAt; else "on but age unknown".
  const lastArchived =
    (wal.detail['last_archived_time'] as string | null | undefined) ?? null;
  let exposure: number | null = null;
  if (lastArchived) {
    const t = new Date(lastArchived).getTime();
    if (Number.isFinite(t)) exposure = Math.max(0, (Date.now() - t) / 1000);
  } else {
    exposure = ageSeconds(wal);
  }

  const failed = Number(wal.detail['failed_count'] ?? 0);
  if (failed > 0 && (wal.detail['last_failed_time'] as string | undefined)) {
    return {
      targetSeconds,
      exposureSeconds: exposure,
      status: 'breached',
      signal: 'WAL archive failing',
      detail: `${backupStateLabel(wal)}. Archive has failures — treat RPO as at risk until last_archived advances.`,
      method,
    };
  }

  return {
    targetSeconds,
    exposureSeconds: exposure ?? 0,
    status: statusOf(exposure ?? 0, targetSeconds, false),
    signal: exposure === null ? 'WAL archive on' : `WAL age ${fmtExposure(exposure)}`,
    detail:
      exposure === null
        ? 'archive_mode=on — PITR possible; waiting for last_archived_time sample to quantify exposure.'
        : `Continuous WAL archiving. Exposure ≈ time since last archived WAL (${fmtExposure(exposure)}).`,
    method,
  };
}

function mssqlRpo(rows: BackupRow[], targetSeconds: number): Omit<
  InstanceRpo,
  'instanceId' | 'alias' | 'engine' | 'href' | 'targetFromTag'
> {
  const method =
    'SQL Server: FULL/BULK → RPO ≈ newest log backup; SIMPLE → RPO ≈ newest full/diff.';

  const fullish = rows.filter((r) => r.kind === 'full' || r.kind === 'differential');
  const logs = rows.filter((r) => r.kind === 'log');
  const anyFullRecovery = rows.some(
    (r) => String(r.detail['recovery_model'] ?? '').toUpperCase() === 'FULL',
  );

  if (rows.length === 0) {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'unknown',
      signal: 'No msdb backup rows',
      detail: 'No backup_state from msdb yet.',
      method,
    };
  }

  // Prefer log-backup RPO when any DB is FULL.
  if (anyFullRecovery) {
    const logAges = logs
      .map((r) => ({ r, age: ageSeconds(r) }))
      .filter((x) => x.age !== null) as { r: BackupRow; age: number }[];
    if (logAges.length === 0) {
      const never = logs.length > 0 || fullish.some((r) => backupState(r) === 'sin_recuperacion');
      return {
        targetSeconds,
        exposureSeconds: null,
        status: never ? 'broken' : 'unknown',
        signal: 'No log backup',
        detail:
          'FULL recovery without a log backup — PITR chain broken. RPO is unbounded until log backups run.',
        method,
      };
    }
    // Worst (oldest) log backup across FULL DBs drives fleet RPO for the instance.
    const worst = logAges.reduce((a, b) => (a.age > b.age ? a : b));
    const logTarget = Math.min(targetSeconds, (BACKUP_STALE_HOURS.log ?? 4) * 3600);
    return {
      targetSeconds: logTarget,
      exposureSeconds: worst.age,
      status: statusOf(worst.age, logTarget, false),
      signal: `Log backup ${fmtExposure(worst.age)}`,
      detail: `Worst log backup age across FULL databases · ${backupKindLabel(worst.r)} · ${backupStateLabel(worst.r)}.`,
      method,
    };
  }

  // SIMPLE only: full/diff age.
  const ages = fullish
    .map((r) => ({ r, age: ageSeconds(r) }))
    .filter((x) => x.age !== null) as { r: BackupRow; age: number }[];
  if (ages.length === 0) {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'broken',
      signal: 'No full/diff backup',
      detail: 'SIMPLE recovery and no completed full/differential backup in msdb.',
      method,
    };
  }
  const worst = ages.reduce((a, b) => (a.age > b.age ? a : b));
  const fullTarget = Math.min(targetSeconds * 4, (BACKUP_STALE_HOURS.full ?? 168) * 3600);
  return {
    targetSeconds: fullTarget,
    exposureSeconds: worst.age,
    status: statusOf(worst.age, fullTarget, false),
    signal: `Full/diff ${fmtExposure(worst.age)}`,
    detail: `SIMPLE recovery — RPO bounded by full/diff only · ${backupStateLabel(worst.r)}.`,
    method,
  };
}

function mariaRpo(rows: BackupRow[], targetSeconds: number): Omit<
  InstanceRpo,
  'instanceId' | 'alias' | 'engine' | 'href' | 'targetFromTag'
> {
  const method =
    'MariaDB/MySQL: in-server RPO signal is binary log (PITR). Dumps (mariabackup) are outside the engine.';
  const binlog = rows.find((r) => r.source === 'binlog' || r.kind === 'wal_archive');

  if (!binlog) {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'unknown',
      signal: 'No binlog posture',
      detail: 'Collector has not reported log_bin yet.',
      method,
    };
  }

  if (binlog.detail['log_bin'] !== true) {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'broken',
      signal: 'Binlog off',
      detail: 'log_bin=off — no in-server PITR. Crash recovery only; dumps are external.',
      method,
    };
  }

  const expireSec = Number(binlog.detail['expire_seconds'] ?? 0);
  // Binlog on ⇒ continuous RPO ~ seconds (flush lag). We cannot see apply lag without a replica probe.
  const exposure = 0;
  const retain =
    expireSec > 0
      ? `Retention ~${formatDuration(expireSec)} (expire_logs).`
      : 'Binlog retention not reported.';

  return {
    targetSeconds,
    exposureSeconds: exposure,
    status: 'met',
    signal: 'Binlog on',
    detail: `PITR possible via binary log. ${retain} Pair with external full backups for base restore.`,
    method,
  };
}

function oracleRpo(rows: BackupRow[], targetSeconds: number): Omit<
  InstanceRpo,
  'instanceId' | 'alias' | 'engine' | 'href' | 'targetFromTag'
> {
  const method =
    'Oracle: ARCHIVELOG + v$archived_log for continuous RPO; v$backup_set for RMAN full/log.';

  if (rows.length === 0) {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'unknown',
      signal: 'No RMAN inventory',
      detail:
        'Oracle backup catalog not collected yet — enable RMAN / archive inventory on the monitor login to prove RPO.',
      method,
    };
  }

  const archive = rows.find((r) => r.kind === 'wal_archive');
  if (archive && String(archive.detail['log_mode'] ?? '').toUpperCase() !== 'ARCHIVELOG') {
    return {
      targetSeconds,
      exposureSeconds: null,
      status: 'broken',
      signal: 'NOARCHIVELOG',
      detail:
        'Database is in NOARCHIVELOG — no continuous redo archive. Crash recovery only; enable ARCHIVELOG for PITR.',
      method,
    };
  }

  const ages = rows
    .map((r) => ({ r, age: ageSeconds(r) }))
    .filter((x) => x.age !== null) as { r: BackupRow; age: number }[];
  if (ages.length === 0) {
    const broken = rows.some((r) => backupState(r) === 'sin_recuperacion');
    return {
      targetSeconds,
      exposureSeconds: archive && String(archive.detail['log_mode']).toUpperCase() === 'ARCHIVELOG' ? 0 : null,
      status:
        archive && String(archive.detail['log_mode']).toUpperCase() === 'ARCHIVELOG'
          ? 'met'
          : broken
            ? 'broken'
            : 'unknown',
      signal:
        archive && String(archive.detail['log_mode']).toUpperCase() === 'ARCHIVELOG'
          ? 'ARCHIVELOG on'
          : broken
            ? 'Recovery broken'
            : 'No finished backup time',
      detail: rows.map((r) => `${backupKindLabel(r)} · ${backupStateLabel(r)}`).join('; '),
      method,
    };
  }
  const best = ages.reduce((a, b) => (a.age < b.age ? a : b));
  return {
    targetSeconds,
    exposureSeconds: best.age,
    status: statusOf(best.age, targetSeconds, false),
    signal: `${backupKindLabel(best.r)} ${fmtExposure(best.age)}`,
    detail: `${backupStateLabel(best.r)} · best finished backup age.`,
    method,
  };
}

/** Fleet RPO for the four SQL engines only. */
export async function getFleetRpo(): Promise<InstanceRpo[]> {
  const { listInstances } = await import('@/lib/queries');
  const [engines, backups, instances] = await Promise.all([
    getEngineVersions(),
    getBackups(),
    listInstances().catch(() => []),
  ]);
  const tagsById = new Map(instances.map((i) => [i.instanceId, i.tags ?? {}]));
  const byInstance = new Map<number, BackupRow[]>();
  for (const row of backups) {
    const list = byInstance.get(row.instanceId) ?? [];
    list.push(row);
    byInstance.set(row.instanceId, list);
  }

  const out: InstanceRpo[] = [];
  for (const eng of engines) {
    if (!SQL_ENGINES.has(eng.engine)) continue;
    const rows = byInstance.get(eng.instanceId) ?? [];
    const { seconds: targetSeconds, fromTag } = targetFromTags(tagsById.get(eng.instanceId));
    let core: Omit<InstanceRpo, 'instanceId' | 'alias' | 'engine' | 'href' | 'targetFromTag'>;
    switch (eng.engine) {
      case 'postgres':
        core = postgresRpo(rows, targetSeconds);
        break;
      case 'mssql':
        core = mssqlRpo(rows, targetSeconds);
        break;
      case 'mariadb':
        core = mariaRpo(rows, targetSeconds);
        break;
      case 'oracle':
        core = oracleRpo(rows, targetSeconds);
        break;
      default:
        continue;
    }
    // Re-evaluate status against tag target when engine helpers used a different local target.
    const status =
      core.status === 'broken' || core.status === 'unknown'
        ? core.status
        : statusOf(core.exposureSeconds, targetSeconds, false);
    out.push({
      instanceId: eng.instanceId,
      alias: eng.alias,
      engine: eng.engine,
      href: `/instances/${eng.instanceId}/backups`,
      ...core,
      targetSeconds,
      targetFromTag: fromTag,
      status,
    });
  }

  const rank: Record<RpoStatus, number> = {
    broken: 0,
    breached: 1,
    unknown: 2,
    met: 3,
  };
  return out.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (b.exposureSeconds ?? 1e15) - (a.exposureSeconds ?? 1e15) ||
      a.alias.localeCompare(b.alias),
  );
}

export function formatRpoSeconds(seconds: number | null): string {
  return fmtExposure(seconds);
}
