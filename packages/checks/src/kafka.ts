import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const KAFKA_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'kafka_under_replicated',
    title: 'Under-replicated partitions',
    description: 'ISR smaller than replica set',
    sql: () => JSON.stringify({ kafka: 'describeTopics' }),
    evaluate: (rows) => {
      const ur = Array.isArray(rows[0]?.['underReplicated'])
        ? (rows[0]!['underReplicated'] as Record<string, unknown>[])
        : [];
      if (ur.length === 0) return [];
      return [
        {
          severity: ur.length >= 5 ? 'critical' : 'warning',
          object: 'partitions',
          message: `${ur.length} under-replicated partition(s).`,
          remediation:
            'Check broker disk/network; restore replicas until ISR matches replica count.',
          value: ur.length,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'kafka_consumer_lag',
    title: 'Consumer group lag',
    description: 'Total lag across configured groups',
    sql: () => JSON.stringify({ kafka: 'groupLag' }),
    evaluate: (rows) => {
      const groups = Array.isArray(rows[0]?.['groups'])
        ? (rows[0]!['groups'] as Record<string, unknown>[])
        : [];
      const findings: Finding[] = [];
      for (const g of groups) {
        if (g['error']) {
          findings.push({
            severity: 'warning',
            object: String(g['groupId'] ?? 'group'),
            message: `Cannot read lag: ${g['error']}`,
            remediation: 'Verify group id and ACL for describe/offsets.',
          });
          continue;
        }
        const lag = num(g['lagTotal']);
        if (lag < 10_000) continue;
        findings.push({
          severity: lag >= 100_000 ? 'critical' : 'warning',
          object: String(g['groupId'] ?? 'group'),
          message: `Consumer lag ${lag} messages.`,
          remediation:
            'Scale consumers, fix stuck members, or check producer burst / CDC apply path.',
          value: lag,
        });
      }
      return findings;
    },
  },
  {
    id: 'kafka_broker_count',
    title: 'Broker availability',
    description: 'Cluster must expose at least one broker',
    sql: () => JSON.stringify({ kafka: 'describeCluster' }),
    evaluate: (rows) => {
      const brokers = Array.isArray(rows[0]?.['brokers']) ? rows[0]!['brokers'] : [];
      if (brokers.length > 0) return [];
      return [
        {
          severity: 'critical',
          object: 'cluster',
          message: 'No brokers returned from describeCluster.',
          remediation: 'Check bootstrap servers, ACL, and listener config.',
          value: 0,
        } satisfies Finding,
      ];
    },
  },
];

export const CDC_CHECKS: ForeignCheckDefinition[] = [
  ...KAFKA_CHECKS,
  {
    id: 'cdc_datasync_down',
    title: 'DataSync health endpoint',
    description: 'Optional HTTP health for CDC daemon',
    sql: () => JSON.stringify({ kafka: 'cdcHealth' }),
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      if (!doc['configured']) return [];
      if (doc['ok']) return [];
      return [
        {
          severity: 'critical',
          object: 'datasync',
          message: `DataSync health failed: ${doc['error'] ?? doc['status'] ?? 'down'}`,
          remediation: 'Restart DataSync daemon; check Kafka connectivity and disk.',
        } satisfies Finding,
      ];
    },
  },
];
