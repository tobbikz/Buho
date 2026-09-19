import { query } from './db';
import type { ReplicationSankeyData } from '@/components/ReplicationSankey';
import { hostsLikelySame, normalizeHost } from './replication';

interface EdgeRow {
  fromAlias: string;
  toAlias: string;
  lagSeconds: number | null;
}

/**
 * Build master → replica Sankey edges from fleet replication_state.
 *
 * Circular GTID rings are cycles; Recharts/d3-sankey cannot layout cycles (all
 * nodes collapse to the left with invisible links). We emit a **bipartite**
 * graph: masters on the left, replicas on the right (same alias may appear on
 * both sides), so every ring edge is left → right.
 */
export async function getMariaReplicationSankey(tenant = 'default'): Promise<ReplicationSankeyData> {
  const rows = await query<Record<string, unknown>>(
    `select i.alias as self_alias,
            i.host as self_host,
            r.role,
            r.peer,
            r.lag_seconds
       from buho.instances i
       join buho.replication_state r on r.instance_id = i.instance_id
      where i.tenant = $1
        and i.engine = 'mariadb'
        and r.role = 'replica'
        and coalesce(r.peer, '') <> ''`,
    [tenant],
  );

  const instances = await query<Record<string, unknown>>(
    `select alias, host, port from buho.instances where tenant = $1 and engine = 'mariadb'`,
    [tenant],
  );

  const resolveAlias = (peer: string): string | null => {
    const hostPart = normalizeHost(peer.split(':')[0] ?? peer);
    for (const inst of instances) {
      const alias = String(inst['alias']);
      const host = String(inst['host']);
      if (alias === hostPart || hostsLikelySame(host, hostPart) || hostsLikelySame(alias, hostPart)) {
        return alias;
      }
    }
    return hostPart || null;
  };

  const edges: EdgeRow[] = [];
  for (const row of rows) {
    const selfAlias = String(row['self_alias']);
    const peer = String(row['peer'] ?? '');
    const peerAlias = resolveAlias(peer);
    if (!peerAlias || peerAlias === selfAlias) continue;

    edges.push({
      fromAlias: peerAlias,
      toAlias: selfAlias,
      lagSeconds: row['lag_seconds'] == null ? null : Number(row['lag_seconds']),
    });
  }

  const best = new Map<string, EdgeRow>();
  for (const edge of edges) {
    const key = `${edge.fromAlias}→${edge.toAlias}`;
    const prev = best.get(key);
    if (!prev || (edge.lagSeconds != null && prev.lagSeconds == null)) best.set(key, edge);
  }
  const unique = [...best.values()];
  if (unique.length === 0) return { nodes: [], links: [] };

  const sources = [...new Set(unique.map((e) => e.fromAlias))].sort();
  const targets = [...new Set(unique.map((e) => e.toAlias))].sort();

  const nodes = [
    ...sources.map((name) => ({ name, side: 'source' as const })),
    ...targets.map((name) => ({ name, side: 'target' as const })),
  ];

  const links = unique
    .map((edge) => {
      const source = sources.indexOf(edge.fromAlias);
      const target = sources.length + targets.indexOf(edge.toAlias);
      return {
        source,
        target,
        // Flat weight so lag does not dominate ribbon width; color still encodes lag.
        value: 1,
        lagSeconds: edge.lagSeconds,
      };
    })
    .filter((link) => link.source >= 0 && link.target >= sources.length);

  return { nodes, links };
}
