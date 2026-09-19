'use client';

import { ResponsiveContainer, Sankey, Tooltip } from 'recharts';

export interface ReplicationSankeyNode {
  name: string;
  /** Bipartite layout: masters left, replicas right (ring-safe). */
  side?: 'source' | 'target';
}

export interface ReplicationSankeyLink {
  source: number;
  target: number;
  value: number;
  lagSeconds?: number | null;
}

export interface ReplicationSankeyData {
  nodes: ReplicationSankeyNode[];
  links: ReplicationSankeyLink[];
}

const NODE = '#1f5f8b';
const LINK = '#2f6b4f';

function LinkShape(props: {
  sourceX?: number;
  targetX?: number;
  sourceY?: number;
  targetY?: number;
  sourceControlX?: number;
  targetControlX?: number;
  linkWidth?: number;
  payload?: ReplicationSankeyLink;
}) {
  const {
    sourceX = 0,
    targetX = 0,
    sourceY = 0,
    targetY = 0,
    sourceControlX = 0,
    targetControlX = 0,
    linkWidth = 0,
    payload,
  } = props;
  const lag = payload?.lagSeconds ?? 0;
  const color = lag >= 60 ? '#b01818' : lag >= 10 ? '#9a4a00' : LINK;
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(linkWidth, 8)}
      strokeOpacity={0.45}
    />
  );
}

function NodeShape(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ReplicationSankeyNode & { value?: number };
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  const label = payload?.name ?? '';
  const onRight = payload?.side === 'target';
  const h = Math.max(height, 18);
  return (
    <g>
      <rect x={x} y={y} width={width} height={h} fill={NODE} rx={2} />
      <text
        x={onRight ? x - 6 : x + width + 6}
        y={y + h / 2}
        textAnchor={onRight ? 'end' : 'start'}
        dominantBaseline="middle"
        fontSize={11}
        fill="currentColor"
      >
        {label}
      </text>
    </g>
  );
}

/**
 * Master → replica flow for MariaDB ring / tree topologies.
 * Link color warns on lag; bipartite nodes keep circular rings drawable.
 */
export function ReplicationSankey({
  data,
  height = 280,
}: {
  data: ReplicationSankeyData;
  height?: number;
}) {
  if (data.nodes.length < 2 || data.links.length === 0) {
    return (
      <div className="empty text-[12px]">
        Not enough replication edges to draw a Sankey yet. Wait for inventory on each ring peer.
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <Sankey
          data={data}
          nodeWidth={14}
          nodePadding={24}
          margin={{ top: 12, right: 88, bottom: 12, left: 88 }}
          link={<LinkShape />}
          node={<NodeShape />}
        >
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const raw = payload[0].payload as unknown;
              if (!raw || typeof raw !== 'object') return null;
              const row = raw as {
                source?: number | { name?: string };
                target?: number | { name?: string };
                lagSeconds?: number;
              };
              const from =
                typeof row.source === 'number'
                  ? data.nodes[row.source]?.name
                  : row.source?.name;
              const to =
                typeof row.target === 'number'
                  ? data.nodes[row.target]?.name
                  : row.target?.name;
              if (!from || !to) return null;
              return (
                <div className="rounded border border-border bg-surface px-2 py-1 text-[11px] shadow">
                  <div className="font-semibold">
                    {from} → {to}
                  </div>
                  {typeof row.lagSeconds === 'number' ? (
                    <div>lag {row.lagSeconds}s</div>
                  ) : (
                    <div>replicating</div>
                  )}
                </div>
              );
            }}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}
