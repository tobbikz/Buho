import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

/**
 * MongoDB checks — command documents as JSON (EngineClient.query accepts `{...}`).
 * Focused on what a DBA acts on: connections, WT cache, tickets, lock waits, lag.
 */

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const SERVER_STATUS = JSON.stringify({
  serverStatus: 1,
  repl: 0,
  metrics: 0,
  wiredTiger: 1,
});

export const MONGODB_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'mongo_connections',
    title: 'Connection usage',
    description: 'Current connections vs available',
    sql: () => SERVER_STATUS,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const connections = (doc['connections'] as Record<string, unknown>) ?? {};
      const current = num(connections['current']);
      const available = num(connections['available']);
      const max = current + available;
      if (max <= 0) return [];
      const pct = (current / max) * 100;
      if (pct < 80) return [];
      return [
        {
          severity: pct >= 95 ? 'critical' : 'warning',
          object: 'connections',
          message: `Connections at ${pct.toFixed(0)}% (${current}/${max}).`,
          remediation: 'Raise maxIncomingConnections or find connection leaks in drivers.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'mongo_wt_cache',
    title: 'WiredTiger cache pressure',
    description: 'Cache bytes used vs configured max',
    sql: () => SERVER_STATUS,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const cache =
        ((doc['wiredTiger'] as Record<string, unknown> | undefined)?.['cache'] as
          | Record<string, unknown>
          | undefined) ?? {};
      const max = num(cache['maximum bytes configured']);
      const used = num(cache['bytes currently in the cache']);
      if (max <= 0) return [];
      const pct = (used / max) * 100;
      if (pct < 90) return [];
      return [
        {
          severity: pct >= 98 ? 'critical' : 'warning',
          object: 'wiredTiger.cache',
          message: `WT cache at ${pct.toFixed(0)}% (${Math.round(used / 1e6)}MB / ${Math.round(max / 1e6)}MB).`,
          remediation: 'Raise cacheSizeGB or reduce working set / index bloat.',
          value: pct,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'mongo_tickets',
    title: 'WiredTiger ticket saturation',
    description: 'concurrentTransactions tickets nearly exhausted',
    sql: () => SERVER_STATUS,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const concurrent =
        ((doc['wiredTiger'] as Record<string, unknown> | undefined)?.[
          'concurrentTransactions'
        ] as Record<string, unknown> | undefined) ?? {};
      const findings: Finding[] = [];
      for (const side of ['read', 'write'] as const) {
        const ticket = (concurrent[side] as Record<string, unknown> | undefined) ?? {};
        const out = num(ticket['out']);
        const total = num(ticket['total']);
        if (total <= 0) continue;
        const pct = (out / total) * 100;
        if (pct < 85) continue;
        findings.push({
          severity: pct >= 95 ? 'critical' : 'warning',
          object: `tickets.${side}`,
          message: `${side} tickets at ${pct.toFixed(0)}% (${out}/${total}).`,
          remediation: 'Find slow ops holding tickets (Sessions tab / currentOp); avoid collection scans.',
          value: pct,
        });
      }
      return findings;
    },
  },
  {
    id: 'mongo_lock_queue',
    title: 'Global lock queue',
    description: 'Readers/writers queued on global lock',
    sql: () => SERVER_STATUS,
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const queue =
        ((doc['globalLock'] as Record<string, unknown> | undefined)?.['currentQueue'] as
          | Record<string, unknown>
          | undefined) ?? {};
      const total = num(queue['total']);
      if (total < 5) return [];
      return [
        {
          severity: total >= 20 ? 'critical' : 'warning',
          object: 'globalLock.currentQueue',
          message: `${total} clients queued on global lock.`,
          remediation: 'Open Locks / Sessions; look for long writers and waitingForLock ops.',
          value: total,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'mongo_repl_lag',
    title: 'Replica set lag',
    description: 'Secondary optime lag vs primary',
    appliesTo: (caps) => caps.features.alwaysOn,
    sql: () => JSON.stringify({ replSetGetStatus: 1 }),
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      const members = Array.isArray(doc['members']) ? (doc['members'] as Record<string, unknown>[]) : [];
      const primary = members.find((m) => num(m['state']) === 1);
      const self = members.find((m) => m['self'] === true);
      if (!primary || !self || primary === self) return [];
      const p = primary['optimeDate'] instanceof Date ? primary['optimeDate'].getTime() : 0;
      const s = self['optimeDate'] instanceof Date ? (self['optimeDate'] as Date).getTime() : 0;
      if (p <= 0 || s <= 0) return [];
      const lag = (p - s) / 1000;
      if (lag < 10) return [];
      return [
        {
          severity: lag >= 60 ? 'critical' : 'warning',
          object: String(self['name'] ?? 'secondary'),
          message: `Replica lag ${lag.toFixed(0)}s.`,
          remediation: 'Check secondary disk/CPU and network; pause heavy index builds on secondaries.',
          value: lag,
        } satisfies Finding,
      ];
    },
  },
];
