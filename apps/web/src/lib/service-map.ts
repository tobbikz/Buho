import { query } from './db';

export type ServiceMapNode = {
  id: string;
  kind: 'http' | 'db' | 'other';
  engine: string;
  label: string;
  instanceId: number | null;
  host: string | null;
  port: number | null;
  score: number | null;
  critical: number;
};

export type ServiceMapEdge = {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
};

export type ServiceMapGraph = {
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
};

function kindOf(engine: string | null | undefined): 'http' | 'db' | 'other' {
  if (!engine || engine === 'endpoint') return engine === 'endpoint' ? 'http' : 'other';
  if (
    ['postgres', 'mariadb', 'mssql', 'oracle'].includes(
      engine,
    )
  ) {
    return 'db';
  }
  return 'other';
}

/** Declared dependencies as a bipartite service map (HTTP/apps → databases). */
export async function getServiceMapGraph(): Promise<ServiceMapGraph> {
  const rows = await query<Record<string, unknown>>(
    `with scores as (
       select distinct on (instance_id) instance_id, score, critical
         from buho.health_scores
        order by instance_id, ts desc
     )
     select d.dep_id,
            d.from_instance_id, d.from_service_name,
            f.alias as from_alias, f.engine as from_engine,
            f.host as from_host, f.port as from_port,
            fs.score as from_score, coalesce(fs.critical, 0) as from_critical,
            d.to_instance_id, t.alias as to_alias, t.engine as to_engine,
            t.host as to_host, t.port as to_port,
            ts.score as to_score, coalesce(ts.critical, 0) as to_critical,
            d.relation
       from buho.service_deps d
       left join buho.instances f on f.instance_id = d.from_instance_id
       left join scores fs on fs.instance_id = f.instance_id
       join buho.instances t on t.instance_id = d.to_instance_id
       left join scores ts on ts.instance_id = t.instance_id
      order by coalesce(f.alias, d.from_service_name), t.alias`,
  );

  const nodes = new Map<string, ServiceMapNode>();
  const edges: ServiceMapEdge[] = [];

  for (const row of rows) {
    const fromAlias = (row['from_alias'] as string | null) ?? null;
    const fromService = (row['from_service_name'] as string | null) ?? null;
    const fromLabel = fromAlias ?? fromService;
    if (!fromLabel) continue;

    const fromId = fromAlias
      ? `inst:${row['from_instance_id']}`
      : `svc:${fromService}`;
    const toId = `inst:${row['to_instance_id']}`;
    const fromEngine = String(row['from_engine'] ?? 'endpoint');
    const toEngine = String(row['to_engine'] ?? 'postgres');

    if (!nodes.has(fromId)) {
      nodes.set(fromId, {
        id: fromId,
        kind: kindOf(fromEngine),
        engine: fromEngine,
        label: fromLabel,
        instanceId:
          row['from_instance_id'] == null ? null : Number(row['from_instance_id']),
        host: (row['from_host'] as string | null) ?? null,
        port: row['from_port'] == null ? null : Number(row['from_port']),
        score: row['from_score'] == null ? null : Number(row['from_score']),
        critical: Number(row['from_critical'] ?? 0),
      });
    }
    if (!nodes.has(toId)) {
      nodes.set(toId, {
        id: toId,
        kind: kindOf(toEngine),
        engine: toEngine,
        label: String(row['to_alias']),
        instanceId: Number(row['to_instance_id']),
        host: String(row['to_host'] ?? ''),
        port: Number(row['to_port'] ?? 0),
        score: row['to_score'] == null ? null : Number(row['to_score']),
        critical: Number(row['to_critical'] ?? 0),
      });
    }

    edges.push({
      id: `e:${row['dep_id']}`,
      fromId,
      toId,
      relation: String(row['relation'] ?? 'depends_on'),
    });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.label.localeCompare(b.label)),
    edges,
  };
}
