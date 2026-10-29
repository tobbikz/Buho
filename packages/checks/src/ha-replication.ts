import type { Sample } from '@buho/core';
import type { CheckResult, Severity } from './types';

/**
 * HA / replication SLO checks from latest metric samples (not SQL checks).
 * Used by alert evaluation, MCP, and HaSloPanel.
 */

export const HA_LAG_METRIC_CANDIDATES = [
  'replication_replay_lag_seconds',
  'replication_write_lag_seconds',
  'replication_flush_lag_seconds',
  'replication_lag_seconds',
  'standby_replay_delay_seconds',
  'replication_subscription_lag_seconds',
] as const;

export interface HaReplicationSlo {
  lagWarningSeconds: number;
  lagCriticalSeconds: number;
  /** Cumulative wal_buffers_full counter spike — informational unless sustained. */
  walBuffersFullWarning: number;
}

export function defaultHaReplicationSlo(): HaReplicationSlo {
  return {
    lagWarningSeconds: 30,
    lagCriticalSeconds: 120,
    walBuffersFullWarning: 1,
  };
}

const WAL_STATUS_RANK: Record<string, number> = {
  lost: 0,
  unreserved: 1,
  extended: 2,
  unknown: 3,
  reserved: 4,
};

function lagSeverity(value: number, slo: HaReplicationSlo): Severity | null {
  if (value >= slo.lagCriticalSeconds) return 'critical';
  if (value >= slo.lagWarningSeconds) return 'warning';
  return null;
}

function maxScalar(samples: Sample[], metrics: readonly string[]): number | null {
  let max: number | null = null;
  for (const s of samples) {
    if (!metrics.includes(s.metric as (typeof metrics)[number])) continue;
    if (!Number.isFinite(s.value)) continue;
    max = max === null ? s.value : Math.max(max, s.value);
  }
  return max;
}

function labeledRows(samples: Sample[], metric: string): Array<{ labels: Record<string, string>; value: number }> {
  const out: Array<{ labels: Record<string, string>; value: number }> = [];
  for (const s of samples) {
    if (s.metric !== metric || !Number.isFinite(s.value)) continue;
    out.push({ labels: s.labels ?? {}, value: s.value });
  }
  return out;
}

/**
 * Lag SLO + slot/WAL risk from collector samples.
 */
export function evaluateHaReplicationSamples(
  samples: Sample[],
  slo: HaReplicationSlo = defaultHaReplicationSlo(),
): CheckResult[] {
  const results: CheckResult[] = [];

  const lag = maxScalar(samples, HA_LAG_METRIC_CANDIDATES);
  if (lag !== null) {
    const sev = lagSeverity(lag, slo);
    if (sev) {
      results.push({
        checkId: 'ha.replication_lag_slo',
        title: 'Replication lag SLO',
        severity: sev,
        object: 'replication',
        message: `Worst replication lag ${Math.round(lag)}s (SLO warn ${slo.lagWarningSeconds}s / crit ${slo.lagCriticalSeconds}s).`,
        remediation:
          'Check network, standby apply/read I/O, and primary WAL generation. Open Replication or Blame for standby breakdown.',
        value: lag,
      });
    }
  }

  const paused = samples.find((s) => s.metric === 'standby_replay_paused' && s.value >= 1);
  if (paused) {
    results.push({
      checkId: 'ha.standby_replay_paused',
      title: 'Standby replay paused',
      severity: 'critical',
      object: 'standby',
      message: 'WAL replay is paused on this standby.',
      remediation: 'SELECT pg_wal_replay_resume(); if paused on purpose, document and silence.',
      value: 1,
    });
  }

  for (const row of labeledRows(samples, 'replication_slot_active')) {
    if (row.value >= 1) continue;
    const slot = row.labels['slot'] ?? row.labels['slot_name'] ?? 'slot';
    const walStatus = (row.labels['wal_status'] ?? 'unknown').toLowerCase();
    const rank = WAL_STATUS_RANK[walStatus] ?? 3;
    const extendedRank = WAL_STATUS_RANK['extended'] ?? 2;
    const severity: Severity = walStatus === 'lost' || rank <= extendedRank ? 'critical' : 'warning';
    results.push({
      checkId: 'ha.inactive_replication_slot',
      title: 'Inactive replication slot',
      severity,
      object: slot,
      message: `Slot ${slot} inactive (wal_status=${walStatus}).`,
      remediation:
        'Inactive slots retain WAL and block freeze. Drop dead slots or restart the consumer.',
      value: row.value,
    });
  }

  for (const row of labeledRows(samples, 'replication_slot_safe_wal_size_bytes')) {
    const slot = row.labels['slot'] ?? 'slot';
    const walStatus = (row.labels['wal_status'] ?? '').toLowerCase();
    if (row.value > 0) continue;
    if (walStatus === 'lost') {
      results.push({
        checkId: 'ha.slot_wal_lost',
        title: 'Replication slot WAL lost',
        severity: 'critical',
        object: slot,
        message: `Slot ${slot} reports wal_status=lost (safe_wal_size exhausted).`,
        remediation: 'Recreate the slot and re-sync the consumer; disk may already be full on the publisher.',
        value: 0,
      });
    }
  }

  const walFull = samples.find((s) => s.metric === 'wal_buffers_full' && s.value >= slo.walBuffersFullWarning);
  if (walFull && walFull.value > 0) {
    results.push({
      checkId: 'ha.wal_buffers_pressure',
      title: 'WAL buffer pressure',
      severity: walFull.value >= 10 ? 'warning' : 'info',
      object: 'wal',
      message: `wal_buffers_full=${Math.round(walFull.value)} (cumulative).`,
      remediation: 'Sustained values suggest wal_buffers too small or very heavy WAL generation.',
      value: walFull.value,
    });
  }

  return results;
}

/** Flat latest-value map (e.g. alert pack) → same HA findings. */
export function evaluateHaReplicationMetrics(
  metrics: Record<string, number>,
  slo: HaReplicationSlo = defaultHaReplicationSlo(),
): CheckResult[] {
  const samples: Sample[] = Object.entries(metrics).map(([metric, value]) => ({ metric, value }));
  return evaluateHaReplicationSamples(samples, slo);
}
