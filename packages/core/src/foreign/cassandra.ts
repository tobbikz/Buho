import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Cassandra DBA metrics via system / system_views (CQL).
 * Column names match Cassandra 4.0+ virtual tables (4.1 verified).
 */

const SYSTEM_KS = new Set([
  'system',
  'system_schema',
  'system_traces',
  'system_auth',
  'system_distributed',
  'system_views',
  'system_virtual_schema',
]);

const localNode: ForeignCollector = {
  id: 'cassandra_local',
  tier: 'fast',
  description: 'system.local: cluster membership / bootstrap',
  sql: () => `
    SELECT cluster_name, data_center, rack, release_version, bootstrapped,
           gossip_generation, native_protocol_version, host_id
      FROM system.local`,
  toSamples: (rows) => {
    const row = rows[0] ?? {};
    return [
      { metric: 'cassandra_gossip_generation', value: num(row['gossip_generation']) },
      {
        metric: 'cassandra_bootstrapped',
        value: str(row['bootstrapped'], '') === 'COMPLETED' ? 1 : 0,
      },
    ];
  },
};

const peers: ForeignCollector = {
  id: 'cassandra_peers',
  tier: 'normal',
  description: 'Cluster peer count',
  sql: () => `SELECT peer, data_center, rack, release_version FROM system.peers`,
  toSamples: (rows) => [
    { metric: 'cassandra_peer_count', value: rows.length },
    { metric: 'cassandra_cluster_nodes', value: rows.length + 1 },
  ],
};

const clients: ForeignCollector = {
  id: 'cassandra_clients',
  tier: 'fast',
  description: 'Connected native clients (system_views.clients)',
  sql: () => `SELECT count(*) AS total FROM system_views.clients`,
  toSamples: (rows) => {
    const total = num(rows[0]?.['total'] ?? rows[0]?.['count']);
    return [
      { metric: 'connections_total', value: total },
      { metric: 'connections_active', value: total },
      { metric: 'cassandra_clients', value: total },
    ];
  },
};

const threadPools: ForeignCollector = {
  id: 'cassandra_thread_pools',
  tier: 'fast',
  description: 'Thread pool active/pending/blocked',
  sql: () => `
    SELECT name, active_tasks, pending_tasks, blocked_tasks, completed_tasks
      FROM system_views.thread_pools`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    let blocked = 0;
    let pending = 0;
    let active = 0;
    for (const row of rows) {
      const name = str(row['name'], 'pool');
      const labels = { pool: name };
      const a = num(row['active_tasks']);
      const p = num(row['pending_tasks']);
      const b = num(row['blocked_tasks']);
      active += a;
      pending += p;
      blocked += b;
      samples.push({ metric: 'cassandra_pool_active', value: a, labels });
      samples.push({ metric: 'cassandra_pool_pending', value: p, labels });
      samples.push({ metric: 'cassandra_pool_blocked', value: b, labels });
      samples.push({
        metric: 'cassandra_pool_completed',
        value: num(row['completed_tasks']),
        labels,
        counter: true,
      });
    }
    samples.push({ metric: 'cassandra_pools_active', value: active });
    samples.push({ metric: 'cassandra_pools_pending', value: pending });
    samples.push({ metric: 'blocked_sessions', value: blocked });
    return samples;
  },
};

const caches: ForeignCollector = {
  id: 'cassandra_caches',
  tier: 'normal',
  description: 'Key / row / counter cache stats',
  sql: () => `
    SELECT name, capacity_bytes, size_bytes, hit_count, request_count, hit_ratio
      FROM system_views.caches`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    for (const row of rows) {
      const name = str(row['name'], 'cache');
      const labels = { cache: name };
      const hits = num(row['hit_count']);
      const requests = num(row['request_count']);
      const misses = Math.max(requests - hits, 0);
      samples.push({ metric: 'cassandra_cache_size_bytes', value: num(row['size_bytes']), labels });
      samples.push({
        metric: 'cassandra_cache_capacity_bytes',
        value: num(row['capacity_bytes']),
        labels,
      });
      samples.push({ metric: 'cassandra_cache_hits', value: hits, labels, counter: true });
      samples.push({ metric: 'cassandra_cache_misses', value: misses, labels, counter: true });
      const ratio = num(row['hit_ratio']);
      if (ratio > 0) {
        samples.push({ metric: 'cassandra_cache_hit_pct', value: ratio * 100, labels });
      } else if (requests > 0) {
        samples.push({
          metric: 'cassandra_cache_hit_pct',
          value: (hits / requests) * 100,
          labels,
        });
      }
      if (name.toLowerCase().includes('key') && (ratio > 0 || requests > 0)) {
        samples.push({
          metric: 'db_cache_hit_pct',
          value: ratio > 0 ? ratio * 100 : (hits / Math.max(requests, 1)) * 100,
        });
      }
    }
    return samples;
  },
};

const diskUsage: ForeignCollector = {
  id: 'cassandra_disk_usage',
  tier: 'normal',
  description: 'Disk usage per keyspace (system_views.disk_usage)',
  sql: () => `SELECT keyspace_name, table_name, mebibytes FROM system_views.disk_usage`,
  toSamples: (rows) => {
    const samples: Sample[] = [];
    const byKs = new Map<string, number>();
    for (const row of rows) {
      const ks = str(row['keyspace_name'], 'ks');
      if (SYSTEM_KS.has(ks)) continue;
      const bytes = num(row['mebibytes']) * 1024 * 1024;
      byKs.set(ks, (byKs.get(ks) ?? 0) + bytes);
    }
    let total = 0;
    for (const [ks, bytes] of byKs) {
      total += bytes;
      samples.push({
        metric: 'database_size_bytes',
        value: bytes,
        labels: { database: ks },
      });
      samples.push({
        metric: 'cassandra_keyspace_bytes',
        value: bytes,
        labels: { database: ks },
      });
    }
    if (total > 0) samples.push({ metric: 'cassandra_total_data_bytes', value: total });
    return samples;
  },
};

const tableSize: ForeignCollector = {
  id: 'cassandra_table_size',
  tier: 'slow',
  description: 'Estimated partition counts / sizes per table',
  sql: () => `
    SELECT keyspace_name, table_name, mean_partition_size, partitions_count
      FROM system.size_estimates`,
  toSamples: (rows) => {
    const byTable = new Map<string, { ks: string; table: string; bytes: number }>();
    for (const row of rows) {
      const ks = str(row['keyspace_name'], 'ks');
      if (SYSTEM_KS.has(ks)) continue;
      const table = str(row['table_name'], 't');
      const key = `${ks}.${table}`;
      const bytes =
        num(row['partitions_count']) * Math.max(num(row['mean_partition_size']), 1);
      const prev = byTable.get(key);
      byTable.set(key, {
        ks,
        table,
        bytes: (prev?.bytes ?? 0) + bytes,
      });
    }
    return [...byTable.values()].slice(0, 50).map((row) => ({
      metric: 'database_size_bytes',
      value: row.bytes,
      labels: { database: row.ks, table: row.table },
    }));
  },
};

const sstableTasks: ForeignCollector = {
  id: 'cassandra_compaction',
  tier: 'fast',
  description: 'Active SSTable / compaction tasks',
  sql: () => `
    SELECT count(*) AS tasks
      FROM system_views.sstable_tasks`,
  toSamples: (rows) => [
    { metric: 'cassandra_sstable_tasks', value: num(rows[0]?.['tasks'] ?? rows[0]?.['count']) },
  ],
};

export const CASSANDRA_COLLECTORS: ForeignCollector[] = [
  localNode,
  peers,
  clients,
  threadPools,
  caches,
  diskUsage,
  tableSize,
  sstableTasks,
];
