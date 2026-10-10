/**
 * Configuration / posture checks tank health in labs without backups or HA.
 * The score stays honest; the UI separates posture gaps from live on-call pain.
 */
const POSTURE_CHECK_IDS = new Set([
  'wal_archive_failing',
  'mssql_log_backup_chain',
  'mssql_backup_week_coverage',
  'mssql_databases',
  'mssql_log_reuse_pressure',
  'mssql_replication_inactive',
  'mssql_replication_lag',
  'mssql_unsafe_durability',
  'mssql_memory_config',
  'mssql_server_config',
  'mariadb_binlog_health',
  'mariadb_unsafe_durability',
  'mariadb_replication_inactive',
  'mariadb_replication_lag',
  'mariadb_weak_password_hash',
  'unsafe_durability',
  'weak_password_encryption',
  'inactive_replication_slot',
  'replication_lag',
  'autovacuum_disabled',
  'mariadb_stats_auto_disabled',
  'mssql_auto_stats_disabled',
  'mariadb_perf_schema_state',
  'pg_stat_statements_state',
  'mssql_query_store_state',
  'missing_timeouts',
  'mariadb_missing_timeouts',
  'mssql_missing_timeouts',
  'oracle_archivelog_gap',
  'oracle_weak_password_policy',
  'pack.rpo_exposure',
  'pack.replication_lag',
  'pack.xid_age',
  // Host packs are infra posture for on-call — page for load/locks/cache, not disk/swap in lab demos.
  'pack.host_cpu',
  'pack.host_memory',
  'pack.host_swap',
  'pack.host_disk',
  'pack.host_load',
  'pack.host_iowait',
]);

const POSTURE_PREFIXES = [
  'mssql_backup',
  'mssql_log_backup',
  'mariadb_binlog',
  'wal_archive',
  'oracle_archivelog',
  'pack.host_',
];

export function isPostureCheckId(checkId: string): boolean {
  if (POSTURE_CHECK_IDS.has(checkId)) return true;
  if (checkId.startsWith('pack.rpo')) return true;
  return POSTURE_PREFIXES.some((prefix) => checkId.startsWith(prefix));
}

export type FindingLike = {
  checkId: string;
  severity: 'critical' | 'warning' | 'info';
};

export type FindingLane = 'live' | 'posture';

export function findingLane(checkId: string): FindingLane {
  return isPostureCheckId(checkId) ? 'posture' : 'live';
}

export function partitionFindings<T extends FindingLike>(findings: T[]): {
  live: T[];
  posture: T[];
} {
  const live: T[] = [];
  const posture: T[] = [];
  for (const finding of findings) {
    if (findingLane(finding.checkId) === 'posture') posture.push(finding);
    else live.push(finding);
  }
  return { live, posture };
}

/** True when most critical/warning weight is configuration posture, not live load. */
export function scoreIsMostlyPosture(findings: FindingLike[]): boolean {
  const actionable = findings.filter((f) => f.severity === 'critical' || f.severity === 'warning');
  if (actionable.length === 0) return false;
  const posture = actionable.filter((f) => isPostureCheckId(f.checkId)).length;
  return posture / actionable.length >= 0.6;
}

export function postureHint(findings: FindingLike[]): string | null {
  if (!scoreIsMostlyPosture(findings)) return null;
  return 'Score is mostly config / recovery posture (backups, HA, RPO) — not a live outage. Use Live critical for on-call; Posture gaps for production hardening.';
}

/** Soften score colour when the drag is posture, so labs do not look like a SEV-1. */
export function toneForHealthScore(
  score: number | null,
  mostlyPosture: boolean,
): 'neutral' | 'ok' | 'warn' | 'error' {
  if (score === null) return 'neutral';
  if (mostlyPosture) {
    if (score < 60) return 'warn';
    if (score < 85) return 'warn';
    return 'ok';
  }
  if (score < 60) return 'error';
  if (score < 85) return 'warn';
  return 'ok';
}
