import type { EngineClient } from '../engine';
import type { InventoryNote, InventorySnapshot } from './types';
import { eolFor } from './eol';

export async function collectCassandra(client: EngineClient): Promise<InventorySnapshot> {
  const notes: InventoryNote[] = [];
  const [local] = await client.query(`
    SELECT cluster_name, data_center, rack, release_version, host_id, bootstrapped
      FROM system.local`);
  const peers = await client.query(`SELECT peer, data_center, release_version FROM system.peers`).catch(() => []);

  const versionText = String(local?.['release_version'] ?? 'desconocida');
  const versionNum = (() => {
    const m = /(\d+)\.(\d+)/.exec(versionText);
    if (!m) return null;
    return Number(m[1]) * 10_000 + Number(m[2]) * 100;
  })();

  let disks: InventorySnapshot['disks'] = [];
  try {
    const usage = await client.query(`
      SELECT keyspace_name, mebibytes FROM system_views.disk_usage`);
    disks = usage.map((r) => ({
      kind: 'database' as const,
      name: String(r['keyspace_name']),
      sizeBytes: Number(r['mebibytes'] ?? 0) * 1024 * 1024,
      usedBytes: Number(r['mebibytes'] ?? 0) * 1024 * 1024,
    }));
  } catch (error) {
    notes.push({
      domain: 'disk',
      level: 'warn',
      message: `disk_usage: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  notes.push({
    domain: 'engine',
    level: 'info',
    message:
      'Cassandra: system_views (clients, thread_pools, caches, disk). JMX/nodetool metrics not required.',
  });

  const replication = [
    {
      role: 'primary' as const,
      peer: String(local?.['cluster_name'] ?? ''),
      state: String(local?.['bootstrapped'] ?? ''),
      detail: {
        dc: local?.['data_center'],
        rack: local?.['rack'],
        peers: peers.length,
      },
    },
  ];

  return {
    engine: {
      engine: 'cassandra',
      versionNum,
      versionText,
      edition: String(local?.['data_center'] ?? null),
      startedAt: null,
      cores: null,
      memoryBytes: null,
      eolDate: eolFor('cassandra', versionText),
    },
    settings: [
      { name: 'cluster_name', value: String(local?.['cluster_name'] ?? ''), category: 'cluster' },
      { name: 'data_center', value: String(local?.['data_center'] ?? ''), category: 'topology' },
      { name: 'rack', value: String(local?.['rack'] ?? ''), category: 'topology' },
      { name: 'peers', value: String(peers.length), category: 'cluster' },
    ],
    disks,
    replication,
    backups: [],
    jobs: [],
    licensing: {
      edition: 'Apache Cassandra',
      productionOk: true,
      note: 'Open source; DataStax Enterprise licensed separately.',
    },
    notes,
  };
}
