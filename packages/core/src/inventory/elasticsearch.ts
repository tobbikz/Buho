import type { EngineClient } from '../engine';
import type { InventoryNote, InventorySnapshot } from './types';
import { eolFor } from './eol';

export async function collectElasticsearch(client: EngineClient): Promise<InventorySnapshot> {
  if (!client.command) throw new Error('cliente Elasticsearch sin command()');
  const notes: InventoryNote[] = [];
  const info = await client.command({ es: 'info' });
  const health = await client.command({ es: 'cluster.health' });
  const stats = await client.command({ es: 'cluster.stats' }).catch(() => null);

  const versionText = String(
    (info['version'] as Record<string, unknown> | undefined)?.['number'] ?? 'desconocida',
  );
  const versionNum = (() => {
    const m = /(\d+)\.(\d+)/.exec(versionText);
    if (!m) return null;
    return Number(m[1]) * 10_000 + Number(m[2]) * 100;
  })();

  const indices = (stats?.['indices'] as Record<string, unknown> | undefined) ?? {};
  const store = (indices['store'] as Record<string, unknown> | undefined) ?? {};
  const storeBytes = Number(store['size_in_bytes'] ?? 0);

  notes.push({
    domain: 'engine',
    level: 'info',
    message:
      'Elasticsearch: cluster.health, nodes.stats, cat.indices, tasks. Security audit pack not included.',
  });

  const status = String(health['status'] ?? 'unknown');
  if (status !== 'green') {
    notes.push({
      domain: 'replication',
      level: status === 'red' ? 'warn' : 'info',
      message: `Cluster status ${status}; unassigned=${health['unassigned_shards'] ?? 0}.`,
    });
  }

  return {
    engine: {
      engine: 'elasticsearch',
      versionNum,
      versionText,
      edition: String(info['tagline'] ?? 'Elasticsearch'),
      startedAt: null,
      cores: null,
      memoryBytes: null,
      eolDate: eolFor('elasticsearch', versionText),
    },
    settings: [
      { name: 'cluster_name', value: String(health['cluster_name'] ?? ''), category: 'cluster' },
      { name: 'status', value: status, category: 'cluster' },
      {
        name: 'number_of_nodes',
        value: String(health['number_of_nodes'] ?? ''),
        category: 'cluster',
      },
    ],
    disks: [
      {
        kind: 'database' as const,
        name: 'elasticsearch',
        sizeBytes: storeBytes,
        usedBytes: storeBytes,
      },
    ],
    replication: [
      {
        role: 'primary' as const,
        peer: String(health['cluster_name'] ?? ''),
        state: status,
        detail: {
          nodes: health['number_of_nodes'],
          unassigned: health['unassigned_shards'],
        },
      },
    ],
    backups: [],
    jobs: [],
    licensing: {
      edition: 'Elasticsearch',
      productionOk: true,
      note: 'License depends on distribution (OSS / Basic / Platinum).',
    },
    notes,
  };
}
