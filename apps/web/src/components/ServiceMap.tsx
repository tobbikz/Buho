'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { IconDatabase, IconHttp } from '@/components/ServiceDepEdge';
import type { ServiceMapEdge, ServiceMapNode } from '@/lib/service-map';

const ENGINE_SHORT: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  endpoint: 'HTTP',
};

function engineLabel(engine: string): string {
  return ENGINE_SHORT[engine] ?? engine;
}

function scoreTone(score: number | null, critical: number): 'ok' | 'warn' | 'error' | 'idle' {
  if (score == null) return 'idle';
  if (critical > 0 || score < 60) return 'error';
  if (score < 85) return 'warn';
  return 'ok';
}

function hrefFor(node: ServiceMapNode): string | null {
  if (node.kind === 'http') {
    if (node.label) {
      return `/observability/services/${encodeURIComponent(node.label)}`;
    }
    if (node.instanceId != null) return `/observability/monitors/${node.instanceId}`;
    return null;
  }
  if (node.instanceId == null) return null;
  return `/instances/${node.instanceId}`;
}

type LaidOut = {
  node: ServiceMapNode;
  x: number;
  y: number;
  w: number;
  h: number;
};

const NODE_W = 172;
const NODE_H = 52;
const PAD_X = 40;
const PAD_Y = 32;
const COL_GAP = 260;

function layoutBipartite(
  nodes: ServiceMapNode[],
): { laid: LaidOut[]; width: number; height: number } {
  const left = nodes.filter((n) => n.kind !== 'db');
  const right = nodes.filter((n) => n.kind === 'db');
  const rows = Math.max(left.length, right.length, 1);
  const height = PAD_Y * 2 + rows * (NODE_H + 24) - 24;
  const width = PAD_X * 2 + NODE_W * 2 + COL_GAP;

  const place = (list: ServiceMapNode[], colX: number): LaidOut[] => {
    if (list.length === 0) return [];
    const span = Math.max(height - PAD_Y * 2 - NODE_H, 0);
    return list.map((node, i) => {
      const y =
        list.length === 1
          ? Math.round(height / 2 - NODE_H / 2)
          : Math.round(PAD_Y + (span * i) / Math.max(list.length - 1, 1));
      return { node, x: colX, y, w: NODE_W, h: NODE_H };
    });
  };

  return {
    laid: [...place(left, PAD_X), ...place(right, PAD_X + NODE_W + COL_GAP)],
    width,
    height: Math.max(height, 220),
  };
}

export function ServiceMap({
  nodes,
  edges,
}: {
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // SVG bipartite layout hydrates poorly under Next (React #418) — paint after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const { laid, width, height } = useMemo(() => layoutBipartite(nodes), [nodes]);
  const byId = useMemo(() => new Map(laid.map((l) => [l.node.id, l])), [laid]);

  const selected = selectedId ? (nodes.find((n) => n.id === selectedId) ?? null) : null;
  const selectedEdges = selected
    ? edges.filter((e) => e.fromId === selected.id || e.toId === selected.id)
    : [];

  if (nodes.length === 0) {
    return (
      <div className="empty">
        No dependencies yet.{' '}
        <Link href="/observability/apm/setup" className="underline">
          Add APM
        </Link>{' '}
        (OTLP <span className="font-mono">db.name</span>) or declare{' '}
        <span className="font-mono">service_deps</span>.
      </div>
    );
  }

  return (
    <div className="svc-map">
      <div className="svc-map__canvas panel">
        <div className="panel-header">
          <span className="panel-title">Service map</span>
          <span className="muted text-xs">
            {nodes.filter((n) => n.kind !== 'db').length} services ·{' '}
            {nodes.filter((n) => n.kind === 'db').length} databases · {edges.length} edges
          </span>
        </div>
        <div className="svc-map__svg-wrap">
          {!mounted ? (
            <div className="muted text-[12px] p-4">
              Loading map · {nodes.length} nodes · {edges.length} edges
            </div>
          ) : null}
          {mounted ? (
          <svg
            className="svc-map__svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Service dependency map"
          >
            <defs>
              <marker
                id="svc-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="svc-map__marker" />
              </marker>
            </defs>

            {edges.map((e) => {
              const a = byId.get(e.fromId);
              const b = byId.get(e.toId);
              if (!a || !b) return null;
              const x1 = a.x + a.w;
              const y1 = a.y + a.h / 2;
              const x2 = b.x;
              const y2 = b.y + b.h / 2;
              const mx = (x1 + x2) / 2;
              const active =
                !selectedId || e.fromId === selectedId || e.toId === selectedId;
              return (
                <path
                  key={e.id}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  className={`svc-map__edge${active ? '' : ' is-dim'}${
                    selectedId && active ? ' is-active' : ''
                  }`}
                  fill="none"
                  markerEnd="url(#svc-arrow)"
                />
              );
            })}

            {laid.map((l) => {
              const tone = scoreTone(l.node.score, l.node.critical);
              const linked =
                selectedId != null &&
                edges.some(
                  (e) =>
                    (e.fromId === selectedId && e.toId === l.node.id) ||
                    (e.toId === selectedId && e.fromId === l.node.id),
                );
              const active = !selectedId || selectedId === l.node.id || linked;
              const label =
                l.node.label.length > 18 ? `${l.node.label.slice(0, 16)}…` : l.node.label;
              return (
                <g
                  key={l.node.id}
                  className={`svc-map__node svc-map__node--${l.node.kind} svc-map__node--${tone}${
                    active ? '' : ' is-dim'
                  }${selectedId === l.node.id ? ' is-selected' : ''}`}
                  transform={`translate(${l.x}, ${l.y})`}
                  onClick={() =>
                    setSelectedId((prev) => (prev === l.node.id ? null : l.node.id))
                  }
                  style={{ cursor: 'pointer' }}
                >
                  <title>
                    {engineLabel(l.node.engine)} · {l.node.label}
                    {l.node.host ? ` · ${l.node.host}:${l.node.port}` : ''}
                    {l.node.score != null ? ` · score ${l.node.score}` : ''}
                  </title>
                  <rect width={l.w} height={l.h} rx={6} className="svc-map__card" />
                  <circle cx={14} cy={16} r={3.5} className={`svc-map__dot svc-map__dot--${tone}`} />
                  <text x={24} y={19} className="svc-map__engine-svg">
                    {engineLabel(l.node.engine)}
                  </text>
                  <text x={12} y={38} className="svc-map__label-svg">
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
          ) : null}
        </div>
      </div>

      <aside className="svc-map__detail panel">
        <div className="panel-header">
          <span className="panel-title">{selected ? selected.label : 'Details'}</span>
        </div>
        <div className="panel-body space-y-3 text-sm">
          {!selected && (
            <p className="muted text-[12px] m-0">
              Click a service or database. Edges = declared deps + OTLP{' '}
              <span className="font-mono">db.name</span>.
            </p>
          )}
          {selected && (
            <>
              <div className="flex items-center gap-2">
                {selected.kind === 'db' ? (
                  <IconDatabase className="dep-ico dep-ico--db" />
                ) : (
                  <IconHttp className="dep-ico dep-ico--http" />
                )}
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-foreground-muted">
                    {engineLabel(selected.engine)}
                  </div>
                  <div className="font-mono font-semibold">{selected.label}</div>
                  {selected.host != null && selected.host !== '' && (
                    <div className="font-mono text-[11px] text-foreground-muted">
                      {selected.host}
                      {selected.port != null ? `:${selected.port}` : ''}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <span
                  className={`tag ${
                    scoreTone(selected.score, selected.critical) === 'ok'
                      ? 'tag--ok'
                      : scoreTone(selected.score, selected.critical) === 'warn'
                        ? 'tag--warn'
                        : scoreTone(selected.score, selected.critical) === 'error'
                          ? 'tag--error'
                          : 'tag--muted'
                  }`}
                >
                  score {selected.score ?? '—'}
                </span>
                <span className="tag tag--muted">{selectedEdges.length} edge(s)</span>
              </div>
              <ul className="svc-map__edge-list">
                {selectedEdges.map((e) => {
                  const otherId = e.fromId === selected.id ? e.toId : e.fromId;
                  const other = nodes.find((n) => n.id === otherId);
                  if (!other) return null;
                  const dir = e.fromId === selected.id ? '→' : '←';
                  return (
                    <li key={e.id}>
                      <span className="text-foreground-muted">{dir}</span>{' '}
                      <button
                        type="button"
                        className="underline font-mono text-[12px]"
                        onClick={() => setSelectedId(other.id)}
                      >
                        {other.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2 pt-1">
                {hrefFor(selected) && (
                  <Link href={hrefFor(selected)!} className="btn btn--primary">
                    {selected.kind === 'http' ? 'Open service' : 'Open database'}
                  </Link>
                )}
                {selected.kind === 'db' && (
                  <Link
                    href={`/observability/synthetics?db=${encodeURIComponent(selected.label)}`}
                    className="btn btn--secondary"
                  >
                    Probes on this DB
                  </Link>
                )}
                <button type="button" className="btn" onClick={() => setSelectedId(null)}>
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
