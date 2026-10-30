import type { CheckResult, Severity } from './types';

/**
 * Default system alert pack (Redgate-style): fixed catalog, user only edits
 * enabled + warning/critical thresholds. Custom SQL alerts cover everything else.
 *
 * checkId = `pack.<id>`. Evaluated from the latest metric samples.
 */

export type PackDirection = 'high' | 'low';

export interface PackThresholds {
  enabled: boolean;
  warning: number;
  critical: number;
}

export interface PackItemMeta {
  id: string;
  title: string;
  description: string;
  metric: string;
  /** high = fire when value >= threshold; low = fire when value <= threshold */
  direction: PackDirection;
  unit: string;
  remediation: string;
  defaults: PackThresholds;
  /** Host metrics need hostMetrics configured; skip quietly if missing. */
  requiresHost?: boolean;
}

export const ALERT_PACK_CATALOG: PackItemMeta[] = [
  {
    id: 'host_cpu',
    title: 'Host CPU high',
    description: 'CPU usage on the database host',
    metric: 'host_cpu_pct',
    direction: 'high',
    unit: '%',
    requiresHost: true,
    remediation:
      'Identify top wait events and queries. If steal is also high, the VM is overcommitted.',
    defaults: { enabled: true, warning: 85, critical: 95 },
  },
  {
    id: 'host_memory',
    title: 'Host memory high',
    description: 'RAM used on the database host',
    metric: 'host_mem_used_pct',
    direction: 'high',
    unit: '%',
    requiresHost: true,
    remediation:
      'Check shared_buffers / buffer pool sizing and for memory leaks or oversized work_mem grants.',
    defaults: { enabled: true, warning: 85, critical: 95 },
  },
  {
    id: 'host_swap',
    title: 'Host swap in use',
    description: 'Swap usage — databases hate paging',
    metric: 'host_swap_used_pct',
    direction: 'high',
    unit: '%',
    requiresHost: true,
    remediation:
      'Reduce memory pressure. Sustained swap destroys latency even when CPU looks idle.',
    defaults: { enabled: true, warning: 10, critical: 40 },
  },
  {
    id: 'host_disk',
    title: 'Host disk almost full',
    description: 'Data volume used percent',
    metric: 'host_disk_used_pct',
    direction: 'high',
    unit: '%',
    requiresHost: true,
    remediation:
      'Free WAL/binlog/temp files, expand the volume, or move archives off the data disk.',
    defaults: { enabled: true, warning: 85, critical: 95 },
  },
  {
    id: 'host_load',
    title: 'Host load high',
    description: '1-minute load average per CPU core',
    metric: 'host_load1_per_core',
    direction: 'high',
    unit: '×/core',
    requiresHost: true,
    remediation:
      'Load above ~1 per core means a persistent run queue — correlate with CPU and I/O wait.',
    defaults: { enabled: true, warning: 1.5, critical: 3 },
  },
  {
    id: 'host_iowait',
    title: 'Host I/O wait high',
    description: 'CPU time spent waiting on disk',
    metric: 'host_cpu_iowait_pct',
    direction: 'high',
    unit: '%',
    requiresHost: true,
    remediation:
      'Usually missing indexes or a small buffer cache forcing reads — not a reason to buy disks first.',
    defaults: { enabled: true, warning: 25, critical: 50 },
  },
  {
    id: 'connections',
    title: 'Connection saturation',
    description: 'Sessions vs configured maximum',
    metric: 'connections_used_pct',
    direction: 'high',
    unit: '%',
    remediation:
      'Add a pooler (PgBouncer / ProxySQL / driver pool) instead of raising max_connections blindly.',
    defaults: { enabled: true, warning: 75, critical: 90 },
  },
  {
    id: 'blocking',
    title: 'Sessions blocked',
    description: 'Number of sessions waiting on locks',
    metric: 'blocked_sessions',
    direction: 'high',
    unit: 'sessions',
    remediation:
      'Open the blocking / sessions screen. Kill or finish the blocker; look for missing indexes on writers.',
    defaults: { enabled: true, warning: 3, critical: 10 },
  },
  {
    id: 'block_wait',
    title: 'Long lock wait',
    description: 'Worst blocked session wait time',
    metric: 'max_blocked_seconds',
    direction: 'high',
    unit: 's',
    remediation:
      'A wait over a few minutes is an incident. Find the blocker and the object it holds.',
    defaults: { enabled: true, warning: 30, critical: 120 },
  },
  {
    id: 'replication_lag',
    title: 'Replication lag high',
    description: 'Replay / apply lag from replicas or AG secondaries',
    metric: 'replication_replay_lag_seconds',
    direction: 'high',
    unit: 's',
    remediation:
      'Check network, apply performance on the standby, and whether the primary is flooding WAL/binlog.',
    defaults: { enabled: true, warning: 30, critical: 120 },
  },
  {
    id: 'rpo_exposure',
    title: 'RPO exposure high',
    description:
      'Seconds of potential data loss from inventory (WAL/binlog/log backup age). Broken chains report as a huge sentinel.',
    metric: 'rpo_exposure_seconds',
    direction: 'high',
    unit: 's',
    remediation:
      'Open Estate → RPO. Restore the recovery chain (PostgreSQL archive_mode, MariaDB/MySQL binlog, or SQL Server full+log backups). Override with tag rpo_seconds.',
    defaults: { enabled: true, warning: 900, critical: 3600 },
  },
  {
    id: 'cache_hit',
    title: 'Buffer cache hit low',
    description: 'Cache hit ratio (lower is worse)',
    metric: 'db_cache_hit_pct',
    direction: 'low',
    unit: '%',
    remediation:
      'Grow the engine buffer pool (InnoDB buffer pool on MariaDB/MySQL, shared_buffers on PostgreSQL), or fix queries that scan cold data repeatedly.',
    defaults: { enabled: true, warning: 95, critical: 90 },
  },
  {
    id: 'xid_age',
    title: 'Transaction ID age high',
    description: 'XID age as percent of wraparound limit (PostgreSQL)',
    metric: 'xid_age_pct',
    direction: 'high',
    unit: '%',
    remediation:
      'Autovacuum is falling behind freeze. Raise workers/cost limits or vacuum freeze urgently.',
    defaults: { enabled: true, warning: 50, critical: 75 },
  },
];

export type AlertPackConfig = Record<string, PackThresholds>;

export function defaultAlertPack(): AlertPackConfig {
  const pack: AlertPackConfig = {};
  for (const item of ALERT_PACK_CATALOG) {
    pack[item.id] = { ...item.defaults };
  }
  return pack;
}

export function mergeAlertPack(stored: Partial<AlertPackConfig> | null | undefined): AlertPackConfig {
  const base = defaultAlertPack();
  if (!stored) return base;
  for (const item of ALERT_PACK_CATALOG) {
    const row = stored[item.id];
    if (!row) continue;
    base[item.id] = {
      enabled: row.enabled ?? item.defaults.enabled,
      warning: Number.isFinite(Number(row.warning)) ? Number(row.warning) : item.defaults.warning,
      critical: Number.isFinite(Number(row.critical))
        ? Number(row.critical)
        : item.defaults.critical,
    };
  }
  return base;
}

function crossed(
  value: number,
  direction: PackDirection,
  threshold: number,
): boolean {
  return direction === 'high' ? value >= threshold : value <= threshold;
}

function formatValue(value: number, unit: string): string {
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 's') return `${value.toFixed(0)}s`;
  if (unit === '×/core') return `${value.toFixed(2)} per core`;
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * Turn latest metric map into pack findings. Missing metrics = skip (no false alarm).
 */
export function evaluateAlertPack(
  metrics: Record<string, number>,
  pack: AlertPackConfig,
): CheckResult[] {
  const results: CheckResult[] = [];
  const config = mergeAlertPack(pack);

  for (const item of ALERT_PACK_CATALOG) {
    const thresholds = config[item.id] ?? item.defaults;
    if (!thresholds.enabled) continue;
    const value = metrics[item.metric];
    if (value === undefined || !Number.isFinite(value)) continue;

    let severity: Severity | null = null;
    if (crossed(value, item.direction, thresholds.critical)) severity = 'critical';
    else if (crossed(value, item.direction, thresholds.warning)) severity = 'warning';
    if (!severity) continue;

    const bound =
      severity === 'critical'
        ? thresholds.critical
        : thresholds.warning;

    results.push({
      checkId: `pack.${item.id}`,
      title: item.title,
      severity,
      object: item.metric,
      message: `${item.title}: ${formatValue(value, item.unit)} (threshold ${formatValue(bound, item.unit)}).`,
      remediation: item.remediation,
      value,
    });
  }

  return results;
}

export function alertPackMetricNames(): string[] {
  return [...new Set(ALERT_PACK_CATALOG.map((item) => item.metric))];
}
