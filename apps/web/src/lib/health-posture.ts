/**
 * Configuration / posture checks tank health in labs without backups or HA.
 * The score stays honest; the UI explains that the drag is posture, not a live outage.
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
]);

const POSTURE_PREFIXES = [
  'mssql_backup',
  'mssql_log_backup',
  'mariadb_binlog',
  'wal_archive',
];

export function isPostureCheckId(checkId: string): boolean {
  if (POSTURE_CHECK_IDS.has(checkId)) return true;
  return POSTURE_PREFIXES.some((prefix) => checkId.startsWith(prefix));
}

export type FindingLike = {
  checkId: string;
  severity: 'critical' | 'warning' | 'info';
};

/** True when most critical/warning weight is configuration posture, not live load. */
export function scoreIsMostlyPosture(findings: FindingLike[]): boolean {
  const actionable = findings.filter((f) => f.severity === 'critical' || f.severity === 'warning');
  if (actionable.length === 0) return false;
  const posture = actionable.filter((f) => isPostureCheckId(f.checkId)).length;
  return posture / actionable.length >= 0.6;
}

export function postureHint(findings: FindingLike[]): string | null {
  if (!scoreIsMostlyPosture(findings)) return null;
  return 'Most of this score is configuration posture (backups, HA, durability, observability) — not a live incident. Fix backups/HA when you intend production protection; a lab without backups will correctly sit near 0.';
}
