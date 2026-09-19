import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const HEALTH = JSON.stringify({ es: 'cluster.health' });
const NODE_STATS = JSON.stringify({ es: 'nodes.stats' });

export const ELASTICSEARCH_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'es_cluster_status',
    title: 'Cluster health status',
    description: 'green / yellow / red',
    sql: () => HEALTH,
    evaluate: (rows) => {
      const status = String(rows[0]?.['status'] ?? '');
      if (status === 'green' || status === '') return [];
      return [
        {
          severity: status === 'red' ? 'critical' : 'warning',
          object: 'cluster',
          message: `Cluster status is ${status}.`,
          remediation:
            status === 'red'
              ? 'Restore missing primaries; check disk and node availability.'
              : 'Unassigned replicas — check allocation and replica count.',
          value: status === 'red' ? 2 : 1,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'es_unassigned_shards',
    title: 'Unassigned shards',
    description: 'Shards waiting for allocation',
    sql: () => HEALTH,
    evaluate: (rows) => {
      const n = num(rows[0]?.['unassigned_shards']);
      if (n < 1) return [];
      return [
        {
          severity: n >= 10 ? 'critical' : 'warning',
          object: 'shards',
          message: `${n} unassigned shard(s).`,
          remediation: 'Inspect allocation explain; free disk or add data nodes.',
          value: n,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'es_jvm_heap',
    title: 'JVM heap pressure',
    description: 'Heap used across nodes',
    sql: () => NODE_STATS,
    evaluate: (rows) => {
      const nodes = (rows[0]?.['nodes'] as Record<string, Record<string, unknown>>) ?? {};
      const findings: Finding[] = [];
      for (const [id, node] of Object.entries(nodes)) {
        const jvm = (node['jvm'] as Record<string, unknown> | undefined) ?? {};
        const mem = (jvm['mem'] as Record<string, unknown> | undefined) ?? {};
        const used = num(mem['heap_used_in_bytes']);
        const max = num(mem['heap_max_in_bytes']);
        if (max <= 0) continue;
        const pct = (used / max) * 100;
        if (pct < 85) continue;
        findings.push({
          severity: pct >= 95 ? 'critical' : 'warning',
          object: String(node['name'] ?? id),
          message: `JVM heap at ${pct.toFixed(0)}% on ${node['name'] ?? id}.`,
          remediation: 'Reduce heap pressure, fix circuit breakers, or scale the node.',
          value: pct,
        });
      }
      return findings;
    },
  },
  {
    id: 'es_disk',
    title: 'Node disk watermarks',
    description: 'Filesystem used percent',
    sql: () => NODE_STATS,
    evaluate: (rows) => {
      const nodes = (rows[0]?.['nodes'] as Record<string, Record<string, unknown>>) ?? {};
      const findings: Finding[] = [];
      for (const [id, node] of Object.entries(nodes)) {
        const fs = (node['fs'] as Record<string, unknown> | undefined) ?? {};
        const total = (fs['total'] as Record<string, unknown> | undefined) ?? {};
        const tot = num(total['total_in_bytes']);
        const avail = num(total['available_in_bytes']);
        if (tot <= 0) continue;
        const pct = ((tot - avail) / tot) * 100;
        if (pct < 85) continue;
        findings.push({
          severity: pct >= 95 ? 'critical' : 'warning',
          object: String(node['name'] ?? id),
          message: `Disk at ${pct.toFixed(0)}% on ${node['name'] ?? id}.`,
          remediation: 'Delete old indices, shrink, or add disk capacity before flood stage.',
          value: pct,
        });
      }
      return findings;
    },
  },
];
