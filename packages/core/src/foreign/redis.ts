import type { Sample } from '../types';
import type { ForeignCollector } from './types';
import { num, str } from './types';

/**
 * Redis DBA metrics — INFO sections + commandstats.
 * Shared names where honest; redis_* for engine-specific.
 */

function flattenInfo(doc: Record<string, unknown>): Sample[] {
  const samples: Sample[] = [
    { metric: 'uptime_seconds', value: num(doc['uptime_in_seconds']) },
    { metric: 'connections_total', value: num(doc['connected_clients']) },
    { metric: 'connections_active', value: num(doc['connected_clients']) },
    { metric: 'blocked_sessions', value: num(doc['blocked_clients']) },
    { metric: 'redis_blocked_clients', value: num(doc['blocked_clients']) },
    { metric: 'redis_tracking_clients', value: num(doc['tracking_clients']) },
    { metric: 'redis_clients_in_timeout_table', value: num(doc['clients_in_timeout_table']) },
    { metric: 'redis_used_memory_bytes', value: num(doc['used_memory']) },
    { metric: 'redis_used_memory_rss_bytes', value: num(doc['used_memory_rss']) },
    { metric: 'redis_used_memory_peak_bytes', value: num(doc['used_memory_peak']) },
    { metric: 'redis_used_memory_dataset_bytes', value: num(doc['used_memory_dataset']) },
    { metric: 'redis_used_memory_overhead_bytes', value: num(doc['used_memory_overhead']) },
    { metric: 'redis_mem_fragmentation_ratio', value: num(doc['mem_fragmentation_ratio']) },
    { metric: 'redis_allocator_allocated', value: num(doc['allocator_allocated']) },
    { metric: 'redis_allocator_active', value: num(doc['allocator_active']) },
    { metric: 'redis_allocator_resident', value: num(doc['allocator_resident']) },
    { metric: 'redis_total_commands', value: num(doc['total_commands_processed']), counter: true },
    { metric: 'redis_instantaneous_ops', value: num(doc['instantaneous_ops_per_sec']) },
    { metric: 'redis_instantaneous_input_kbps', value: num(doc['instantaneous_input_kbps']) },
    { metric: 'redis_instantaneous_output_kbps', value: num(doc['instantaneous_output_kbps']) },
    { metric: 'redis_keyspace_hits', value: num(doc['keyspace_hits']), counter: true },
    { metric: 'redis_keyspace_misses', value: num(doc['keyspace_misses']), counter: true },
    { metric: 'redis_evicted_keys', value: num(doc['evicted_keys']), counter: true },
    { metric: 'redis_expired_keys', value: num(doc['expired_keys']), counter: true },
    { metric: 'redis_rejected_connections', value: num(doc['rejected_connections']), counter: true },
    { metric: 'redis_total_net_input_bytes', value: num(doc['total_net_input_bytes']), counter: true },
    { metric: 'redis_total_net_output_bytes', value: num(doc['total_net_output_bytes']), counter: true },
    { metric: 'redis_connected_slaves', value: num(doc['connected_slaves']) },
    { metric: 'redis_repl_backlog_active', value: num(doc['repl_backlog_active']) },
    { metric: 'redis_repl_backlog_size', value: num(doc['repl_backlog_size']) },
    { metric: 'redis_repl_backlog_histlen', value: num(doc['repl_backlog_histlen']) },
    { metric: 'redis_aof_enabled', value: num(doc['aof_enabled']) },
    { metric: 'redis_aof_rewrite_in_progress', value: num(doc['aof_rewrite_in_progress']) },
    { metric: 'redis_aof_last_rewrite_status', value: str(doc['aof_last_bgrewrite_status'], 'ok') === 'ok' ? 1 : 0 },
    { metric: 'redis_aof_current_size', value: num(doc['aof_current_size']) },
    { metric: 'redis_rdb_bgsave_in_progress', value: num(doc['rdb_bgsave_in_progress']) },
    { metric: 'redis_rdb_last_bgsave_status', value: str(doc['rdb_last_bgsave_status'], 'ok') === 'ok' ? 1 : 0 },
    { metric: 'redis_rdb_last_save_time', value: num(doc['rdb_last_save_time']) },
    { metric: 'redis_rdb_changes_since_last_save', value: num(doc['rdb_changes_since_last_save']) },
    { metric: 'redis_pubsub_channels', value: num(doc['pubsub_channels']) },
    { metric: 'redis_pubsub_patterns', value: num(doc['pubsub_patterns']) },
    { metric: 'redis_latest_fork_usec', value: num(doc['latest_fork_usec']) },
    { metric: 'redis_io_threaded_reads_processed', value: num(doc['io_threaded_reads_processed']), counter: true },
    { metric: 'redis_io_threaded_writes_processed', value: num(doc['io_threaded_writes_processed']), counter: true },
  ];

  // used_cpu_* are cumulative seconds → counters for per_sec.
  const cpuSys = num(doc['used_cpu_sys']);
  const cpuUser = num(doc['used_cpu_user']);
  if (cpuSys > 0 || cpuUser > 0) {
    samples.push({ metric: 'redis_cpu_sys', value: cpuSys, counter: true });
    samples.push({ metric: 'redis_cpu_user', value: cpuUser, counter: true });
  }

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

  const role = str(doc['role'], 'master');
  if (role === 'slave' || role === 'replica') {
    const lag = num(doc['master_last_io_seconds_ago']);
    if (lag >= 0) samples.push({ metric: 'replication_lag_seconds', value: lag });
    samples.push({ metric: 'redis_master_sync_in_progress', value: num(doc['master_sync_in_progress']) });
    samples.push({
      metric: 'redis_master_link_up',
      value: str(doc['master_link_status'], '') === 'up' ? 1 : 0,
    });
  }

  // Seconds since last RDB save (0 if never / unknown).
  const lastSave = num(doc['rdb_last_save_time']);
  if (lastSave > 1_000_000_000) {
    samples.push({
      metric: 'redis_rdb_seconds_since_save',
      value: Math.max(0, Date.now() / 1000 - lastSave),
    });
  }

  return samples;
}

const infoAll: ForeignCollector = {
  id: 'redis_info',
  tier: 'fast',
  description: 'INFO all: clients, memory, stats, persistence, replication, cpu',
  command: () => ({ info: 'all' }),
  toSamples: (rows) => flattenInfo(rows[0] ?? {}),
};

const commandstats: ForeignCollector = {
  id: 'redis_commandstats',
  tier: 'fast',
  description: 'Top commands by usec (INFO commandstats)',
  command: () => ({ info: 'commandstats' }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const scored: { cmd: string; calls: number; usec: number; usecPerCall: number }[] = [];
    for (const [key, raw] of Object.entries(doc)) {
      if (!key.startsWith('cmdstat_') || typeof raw !== 'string') continue;
      const cmd = key.slice('cmdstat_'.length);
      const calls = Number(/calls=(\d+)/.exec(raw)?.[1] ?? 0);
      const usec = Number(/usec=(\d+)/.exec(raw)?.[1] ?? 0);
      const upc = Number(/usec_per_call=([\d.]+)/.exec(raw)?.[1] ?? 0);
      if (calls <= 0 && usec <= 0) continue;
      scored.push({ cmd, calls, usec, usecPerCall: upc });
    }
    scored.sort((a, b) => b.usec - a.usec);
    const samples: Sample[] = [];
    for (const row of scored.slice(0, 25)) {
      const labels = { command: row.cmd };
      samples.push({ metric: 'redis_cmd_calls', value: row.calls, labels, counter: true });
      samples.push({ metric: 'redis_cmd_usec', value: row.usec, labels, counter: true });
      samples.push({ metric: 'redis_cmd_usec_per_call', value: row.usecPerCall, labels });
    }
    return samples;
  },
};

const keyspace: ForeignCollector = {
  id: 'redis_keyspace',
  tier: 'normal',
  description: 'Keys / expires / avg_ttl per logical DB',
  command: () => ({ info: 'keyspace' }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const samples: Sample[] = [];
    let totalKeys = 0;
    let totalExpires = 0;
    for (const [key, raw] of Object.entries(doc)) {
      if (!/^db\d+$/.test(key) || typeof raw !== 'string') continue;
      const k = Number(/keys=(\d+)/.exec(raw)?.[1] ?? 0);
      const e = Number(/expires=(\d+)/.exec(raw)?.[1] ?? 0);
      const ttl = Number(/avg_ttl=(\d+)/.exec(raw)?.[1] ?? 0);
      totalKeys += k;
      totalExpires += e;
      samples.push({ metric: 'redis_db_keys', value: k, labels: { database: key } });
      samples.push({ metric: 'redis_db_expires', value: e, labels: { database: key } });
      samples.push({ metric: 'redis_db_avg_ttl_ms', value: ttl, labels: { database: key } });
    }
    samples.push({ metric: 'redis_keys_total', value: totalKeys });
    samples.push({ metric: 'redis_expires_total', value: totalExpires });
    return samples;
  },
};

const memoryStats: ForeignCollector = {
  id: 'redis_memory',
  tier: 'normal',
  description: 'Memory as capacity + database_size_bytes',
  command: () => ({ info: 'memory' }),
  toSamples: (rows) => {
    const doc = rows[0] ?? {};
    const used = num(doc['used_memory']);
    return [
      { metric: 'database_size_bytes', value: used, labels: { database: 'redis' } },
      { metric: 'redis_used_memory_bytes', value: used },
      { metric: 'redis_mem_fragmentation_ratio', value: num(doc['mem_fragmentation_ratio']) },
    ];
  },
};

const slowlogLen: ForeignCollector = {
  id: 'redis_slowlog_len',
  tier: 'fast',
  description: 'SLOWLOG LEN gauge',
  command: () => ({ slowlogLen: 1 }),
  toSamples: (rows) => [{ metric: 'redis_slowlog_len', value: num(rows[0]?.['len']) }],
};

const latency: ForeignCollector = {
  id: 'redis_latency',
  tier: 'normal',
  description: 'LATENCY LATEST events',
  command: () => ({ latencyLatest: 1 }),
  toSamples: (rows) => {
    const events = Array.isArray(rows[0]?.['events'])
      ? (rows[0]!['events'] as Record<string, unknown>[])
      : [];
    return events.map((ev) => ({
      metric: 'redis_latency_latest_ms',
      value: num(ev['time_ms']),
      labels: { event: str(ev['event'], 'unknown') },
    }));
  },
};

export const REDIS_COLLECTORS: ForeignCollector[] = [
  infoAll,
  commandstats,
  keyspace,
  memoryStats,
  slowlogLen,
  latency,
];
