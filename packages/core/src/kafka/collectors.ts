import type { ForeignCaps, ForeignCollector } from '../foreign/types';

export const KAFKA_COLLECTORS: ForeignCollector[] = [
  {
    id: 'kafka_cluster',
    tier: 'normal',
    description: 'Broker count and controller',
    sql: () => JSON.stringify({ kafka: 'describeCluster' }),
    toSamples: (rows) => {
      const doc = rows[0] ?? {};
      const brokers = Array.isArray(doc['brokers']) ? doc['brokers'] : [];
      return [
        { metric: 'kafka_brokers', value: brokers.length },
        {
          metric: 'kafka_controller_id',
          value: Number(doc['controller'] ?? -1),
        },
      ];
    },
  },
  {
    id: 'kafka_topics',
    tier: 'normal',
    description: 'Topic count',
    sql: () => JSON.stringify({ kafka: 'listTopics' }),
    toSamples: (rows) => {
      const topics = Array.isArray(rows[0]?.['topics']) ? (rows[0]!['topics'] as unknown[]) : [];
      return [{ metric: 'kafka_topics', value: topics.length }];
    },
  },
  {
    id: 'kafka_under_replicated',
    tier: 'normal',
    description: 'Under-replicated partitions',
    sql: () => JSON.stringify({ kafka: 'describeTopics' }),
    toSamples: (rows) => {
      const ur = Array.isArray(rows[0]?.['underReplicated'])
        ? (rows[0]!['underReplicated'] as unknown[])
        : [];
      return [{ metric: 'kafka_under_replicated_partitions', value: ur.length }];
    },
  },
  {
    id: 'kafka_group_lag',
    tier: 'fast',
    description: 'Consumer group lag totals',
    sql: () => JSON.stringify({ kafka: 'groupLag' }),
    toSamples: (rows, _caps: ForeignCaps) => {
      const groups = Array.isArray(rows[0]?.['groups'])
        ? (rows[0]!['groups'] as Record<string, unknown>[])
        : [];
      const samples = [];
      let total = 0;
      for (const g of groups) {
        if (g['error']) continue;
        const lag = Number(g['lagTotal'] ?? 0);
        total += lag;
        samples.push({
          metric: 'kafka_group_lag',
          value: lag,
          labels: { group: String(g['groupId'] ?? '') },
        });
      }
      samples.push({ metric: 'kafka_group_lag_total', value: total });
      return samples;
    },
  },
];

export const CDC_COLLECTORS: ForeignCollector[] = [
  ...KAFKA_COLLECTORS,
  {
    id: 'cdc_datasync_health',
    tier: 'normal',
    description: 'DataSync daemon HTTP health',
    sql: () => JSON.stringify({ kafka: 'cdcHealth' }),
    toSamples: (rows) => {
      const doc = rows[0] ?? {};
      if (!doc['configured']) return [];
      return [
        {
          metric: 'cdc_datasync_up',
          value: doc['ok'] ? 1 : 0,
        },
      ];
    },
  },
];
