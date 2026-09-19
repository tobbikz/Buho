import type { EngineClient } from '../engine';
import type { InventoryNote, InventorySnapshot } from './types';
import { eolFor } from './eol';

/**
 * Redis inventory: INFO server/memory + keyspace summary.
 */
export async function collectRedis(client: EngineClient): Promise<InventorySnapshot> {
  if (!client.command) throw new Error('cliente Redis sin command()');

  const notes: InventoryNote[] = [];
  const info = await client.command({ info: 'all' });
  const versionText = String(info['redis_version'] ?? 'desconocida');
  const versionNum = (() => {
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionText);
    if (!m) return null;
    return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Math.min(Number(m[3] ?? 0), 99);
  })();

  const role = String(info['role'] ?? 'master');
  const replication = [];
  if (role === 'slave' || role === 'replica') {
    replication.push({
      role: 'replica' as const,
      peer: String(info['master_host'] ?? ''),
      state: String(info['master_link_status'] ?? ''),
      detail: { lag: info['master_last_io_seconds_ago'] },
    });
  } else if (Number(info['connected_slaves'] ?? 0) > 0) {
    replication.push({
      role: 'primary' as const,
      peer: `${info['connected_slaves']} slave(s)`,
      state: 'master',
      detail: {},
    });
  } else {
    notes.push({
      domain: 'replication',
      level: 'info',
      message: 'Standalone Redis (no replicas attached).',
    });
  }

  notes.push({
    domain: 'engine',
    level: 'info',
    message:
      'Redis: INFO + CLIENT LIST (Sessions/Locks). No SQL digests; use SLOWLOG externally if needed.',
  });

  const used = Number(info['used_memory'] ?? 0);

  return {
    engine: {
      engine: 'redis',
      versionNum,
      versionText,
      edition: String(info['redis_mode'] ?? 'standalone'),
      startedAt:
        Number(info['uptime_in_seconds'] ?? 0) > 0
          ? new Date(Date.now() - Number(info['uptime_in_seconds']) * 1000)
          : null,
      cores: null,
      memoryBytes: used > 0 ? used : null,
      eolDate: eolFor('redis', versionText),
    },
    settings: [
      { name: 'maxmemory', value: String(info['maxmemory'] ?? '0'), category: 'memory' },
      {
        name: 'maxmemory_policy',
        value: String(info['maxmemory_policy'] ?? ''),
        category: 'memory',
      },
      {
        name: 'connected_clients',
        value: String(info['connected_clients'] ?? ''),
        category: 'connections',
      },
      { name: 'aof_enabled', value: String(info['aof_enabled'] ?? '0'), category: 'persistence' },
    ],
    disks: [
      {
        kind: 'database' as const,
        name: 'redis',
        sizeBytes: used,
        usedBytes: used,
      },
    ],
    replication,
    backups: [],
    jobs: [],
    licensing: {
      edition: 'Redis OSS / Stack',
      productionOk: true,
      note: 'Redis OSS is free; Redis Enterprise is licensed separately.',
    },
    notes,
  };
}
