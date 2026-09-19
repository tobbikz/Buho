import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

/**
 * Redis checks via INFO (EngineClient.query accepts JSON `{info:"all"}`).
 */

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const INFO_ALL = JSON.stringify({ info: 'all' });

export const REDIS_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'redis_memory',
    title: 'Memory pressure',
    description: 'used_memory vs maxmemory',
    sql: () => INFO_ALL,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const max = num(doc['maxmemory']);
      const used = num(doc['used_memory']);
      if (max <= 0) return [];
      const pct = (used / max) * 100;
      if (pct < 85) return [];
      return [
        {
          severity: pct >= 95 ? 'critical' : 'warning',
          object: 'maxmemory',
          message: `Memory at ${pct.toFixed(0)}% (${Math.round(used / 1e6)}MB / ${Math.round(max / 1e6)}MB).`,
          remediation: 'Raise maxmemory, tune eviction policy, or shrink keyspace.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'redis_connections',
    title: 'Client connection usage',
    description: 'connected_clients vs maxclients',
    sql: () => INFO_ALL,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const max = num(doc['maxclients']);
      const cur = num(doc['connected_clients']);
      if (max <= 0) return [];
      const pct = (cur / max) * 100;
      if (pct < 80) return [];
      return [
        {
          severity: pct >= 95 ? 'critical' : 'warning',
          object: 'clients',
          message: `Clients at ${pct.toFixed(0)}% (${cur}/${max}).`,
          remediation: 'Find connection leaks; raise maxclients if capacity allows.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'redis_evictions',
    title: 'Key evictions',
    description: 'evicted_keys growing under pressure',
    sql: () => INFO_ALL,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const evicted = num(doc['evicted_keys']);
      if (evicted < 100) return [];
      return [
        {
          severity: evicted >= 10_000 ? 'critical' : 'warning',
          object: 'evicted_keys',
          message: `${evicted} keys evicted since start.`,
          remediation: 'Increase maxmemory or reduce TTL/working set; check eviction policy.',
          value: evicted,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'redis_fragmentation',
    title: 'Memory fragmentation',
    description: 'mem_fragmentation_ratio',
    sql: () => INFO_ALL,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const ratio = num(doc['mem_fragmentation_ratio']);
      if (ratio > 0 && ratio < 1.5) return [];
      if (ratio <= 0) return [];
      return [
        {
          severity: ratio >= 2.5 ? 'warning' : 'info',
          object: 'mem_fragmentation_ratio',
          message: `Fragmentation ratio ${ratio.toFixed(2)}.`,
          remediation: 'Consider MEMORY PURGE / restart in a maintenance window if RSS is high.',
          value: ratio,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'redis_replica_lag',
    title: 'Replica lag',
    description: 'master_last_io_seconds_ago on replicas',
    appliesTo: (caps) => caps.features.alwaysOn && caps.role === 'replica',
    sql: () => INFO_ALL,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const lag = num(doc['master_last_io_seconds_ago']);
      if (lag < 5) return [];
      return [
        {
          severity: lag >= 30 ? 'critical' : 'warning',
          object: 'replication',
          message: `Replica IO lag ${lag}s.`,
          remediation: 'Check network and master load; verify replica link.',
          value: lag,
        } satisfies Finding,
      ];
    },
  },
];
