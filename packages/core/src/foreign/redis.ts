import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Redis metrics from INFO (+ keyspace). Align shared names with other engines
 * where the concept matches; prefix redis_* for engine-specific gauges.
 */

function flattenInfo(doc: Record<string, unknown>): Sample[] {
  const samples: Sample[] = [
    { metric: 'uptime_seconds', value: num(doc['uptime_in_seconds']) },
    { metric: 'connections_total', value: num(doc['connected_clients']) },
    { metric: 'connections_active', value: num(doc['connected_clients']) },
    { metric: 'blocked_sessions', value: num(doc['blocked_clients']) },
    { metric: 'redis_blocked_clients', value: num(doc['blocked_clients']) },
    { metric: 'redis_used_memory_bytes', value: num(doc['used_memory']) },
    { metric: 'redis_used_memory_rss_bytes', value: num(doc['used_memory_rss']) },
    { metric: 'redis_used_memory_peak_bytes', value: num(doc['used_memory_peak']) },
    { metric: 'redis_mem_fragmentation_ratio', value: num(doc['mem_fragmentation_ratio']) },
    { metric: 'redis_total_commands', value: num(doc['total_commands_processed']), counter: true },
    { metric: 'redis_instantaneous_ops', value: num(doc['instantaneous_ops_per_sec']) },
    { metric: 'redis_keyspace_hits', value: num(doc['keyspace_hits']), counter: true },
    { metric: 'redis_keyspace_misses', value: num(doc['keyspace_misses']), counter: true },
    { metric: 'redis_evicted_keys', value: num(doc['evicted_keys']), counter: true },
    { metric: 'redis_expired_keys', value: num(doc['expired_keys']), counter: true },
    { metric: 'redis_rejected_connections', value: num(doc['rejected_connections']), counter: true },
    { metric: 'redis_total_net_input_bytes', value: num(doc['total_net_input_bytes']), counter: true },
    { metric: 'redis_total_net_output_bytes', value: num(doc['total_net_output_bytes']), counter: true },
    { metric: 'redis_connected_slaves', value: num(doc['connected_slaves']) },
    { metric: 'redis_aof_enabled', value: num(doc['aof_enabled']) },
    { metric: 'redis_rdb_last_bgsave_status', value: str(doc['rdb_last_bgsave_status'], 'ok') === 'ok' ? 1 : 0 },
  ];

  const maxClients = num(doc['maxclients']);
  if (maxClients > 0) {
    samples.push({ metric: 'connections_max', value: maxClients });
    samples.push({
      metric: 'connections_used_pct',
      value: (num(doc['connected_clients']) / maxClients) * 100,
    });
  }

  const hits = num(doc['keyspace_hits']);
  const misses = num(doc['keyspace_misses']);
  const total = hits + misses;
  if (total > 0) {
    samples.push({ metric: 'db_cache_hit_pct', value: (hits / total) * 100 });
  }

  const maxmemory = num(doc['maxmemory']);
  if (maxmemory > 0) {
    samples.push({ metric: 'redis_maxmemory_bytes', value: maxmemory });
    samples.push({
      metric: 'redis_memory_used_pct',
      value: (num(doc['used_memory']) / maxmemory) * 100,
    });
  }

  // Replication lag (replica only): master_last_io_seconds_ago is a coarse signal.
  const role = str(doc['role'], 'master');
  if (role === 'slave' || role === 'replica') {
    const lag = num(doc['master_last_io_seconds_ago']);
    if (lag >= 0) {
      samples.push({ metric: 'replication_lag_seconds', value: lag });
    }
  }

  return samples;
}

const infoAll: ForeignCollector = {
  id: 'redis_info',
  tier: 'fast',
  description: 'INFO: clients, memory, stats, replication',
  command: () => ({ info: 'all' }),
  toSamples: (rows) => flattenInfo(rows[0] ?? {}),
};

const keyspace: ForeignCollector = {
  id: 'redis_keyspace',
  tier: 'normal',
  description: 'Keys / expires per logical DB',
  command: () => ({ info: 'keyspace' }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const samples: Sample[] = [];
    let totalKeys = 0;
    let totalExpires = 0;
    for (const [key, raw] of Object.entries(doc)) {
      if (!/^db\d+$/.test(key) || typeof raw !== 'string') continue;
      const keys = /keys=(\d+)/.exec(raw);
      const expires = /expires=(\d+)/.exec(raw);
      const k = keys ? Number(keys[1]) : 0;
      const e = expires ? Number(expires[1]) : 0;
      totalKeys += k;
      totalExpires += e;
      samples.push({
        metric: 'redis_db_keys',
        value: k,
        labels: { database: key },
      });
      samples.push({
        metric: 'redis_db_expires',
        value: e,
        labels: { database: key },
      });
    }
    samples.push({ metric: 'redis_keys_total', value: totalKeys });
    samples.push({ metric: 'redis_expires_total', value: totalExpires });
    samples.push({
      metric: 'database_size_bytes',
      value: num(doc['used_memory'] ?? 0),
      labels: { database: 'redis' },
    });
    return samples;
  },
};

const memoryStats: ForeignCollector = {
  id: 'redis_memory',
  tier: 'normal',
  description: 'used_memory as database_size_bytes',
  command: () => ({ info: 'memory' }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const used = num(doc['used_memory']);
    return [
      {
        metric: 'database_size_bytes',
        value: used,
        labels: { database: 'redis' },
      },
      { metric: 'redis_used_memory_bytes', value: used },
    ];
  },
};

export const REDIS_COLLECTORS: ForeignCollector[] = [infoAll, keyspace, memoryStats];
