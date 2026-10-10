'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber } from '@/lib/format';

export interface TopologyBubbleEdge {
  actor: string;
  relation: string;
  label: string;
  weight: number;
  samples: number;
  kind: 'write' | 'read';
}

interface SimNode {
  id: string;
  kind: 'app' | 'table';
  label: string;
  weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pinned: boolean;
}

interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

const WRITE = '#0a6e42';
const READ = '#005eb8';
const APP = '#5c6b7a';
const BG = '#f7f8f9';

function radiusFor(weight: number, maxWeight: number, kind: 'app' | 'table'): number {
  const t = maxWeight > 0 ? Math.log10(weight + 1) / Math.log10(maxWeight + 1) : 0;
  const base = kind === 'app' ? 16 : 10;
  return base + t * (kind === 'app' ? 22 : 18);
}

function screenToWorld(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
}

export function TopologyBubbles({
  edges,
  height = 480,
}: {
  edges: TopologyBubbleEdge[];
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const viewportRef = useRef<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ kind: 'pan' | 'node'; id?: string; ox: number; oy: number } | null>(null);
  const animRef = useRef(0);
  const [selected, setSelected] = useState<SimNode | null>(null);
  const selectedRef = useRef<SimNode | null>(null);

  const { nodesSeed, links, maxWeight, truncated } = useMemo(() => {
    const appWeight = new Map<string, number>();
    const tableWeight = new Map<string, { label: string; weight: number }>();
    const linksLocal: { source: string; target: string; weight: number; kind: 'write' | 'read' }[] =
      [];

    for (const edge of edges) {
      if (edge.weight <= 0) continue;
      appWeight.set(edge.actor, (appWeight.get(edge.actor) ?? 0) + edge.weight);
      const prev = tableWeight.get(edge.relation);
      tableWeight.set(edge.relation, {
        label: edge.label,
        weight: (prev?.weight ?? 0) + edge.weight,
      });
      linksLocal.push({
        source: `app:${edge.actor}`,
        target: `table:${edge.relation}`,
        weight: edge.weight,
        kind: edge.kind,
      });
    }

    const max = Math.max(
      ...[...appWeight.values(), ...[...tableWeight.values()].map((t) => t.weight)],
      1,
    );

    const seeds: Omit<SimNode, 'x' | 'y' | 'vx' | 'vy' | 'pinned'>[] = [
      ...[...appWeight.entries()].map(([actor, weight]) => ({
        id: `app:${actor}`,
        kind: 'app' as const,
        label: actor,
        weight,
        r: radiusFor(weight, max, 'app'),
      })),
      ...[...tableWeight.entries()].map(([relation, info]) => ({
        id: `table:${relation}`,
        kind: 'table' as const,
        label: info.label,
        weight: info.weight,
        r: radiusFor(info.weight, max, 'table'),
      })),
    ].sort((a, b) => b.weight - a.weight);

    const CAP = 48;
    const kept = new Set(seeds.slice(0, CAP).map((s) => s.id));
    const cappedSeeds = seeds.slice(0, CAP);
    const cappedLinks = linksLocal.filter((l) => kept.has(l.source) && kept.has(l.target));
    return { nodesSeed: cappedSeeds, links: cappedLinks, maxWeight: max, truncated: seeds.length > CAP };
  }, [edges]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodesSeed.length === 0) return;

    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || height;
    const apps = nodesSeed.filter((n) => n.kind === 'app');
    const tables = nodesSeed.filter((n) => n.kind === 'table');

    nodesRef.current = nodesSeed.map((seed) => {
      const list = seed.kind === 'app' ? apps : tables;
      const index = list.findIndex((n) => n.id === seed.id);
      const colX = seed.kind === 'app' ? w * 0.22 : w * 0.78;
      const paso = h / (list.length + 1);
      return {
        ...seed,
        x: colX + ((index % 3) - 1) * 8,
        y: paso * (index + 1),
        vx: 0,
        vy: 0,
        pinned: false,
      };
    });

    viewportRef.current = { scale: 1, tx: 0, ty: 0 };
    let settledFrames = 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let last = performance.now();

    const byId = () => {
      const map = new Map<string, SimNode>();
      for (const n of nodesRef.current) map.set(n.id, n);
      return map;
    };

    const simulate = (dt: number) => {
      const nodes = nodesRef.current;
      const alpha = Math.min(1, dt * 1.15);
      const ids = byId();

      for (const n of nodes) {
        if (n.pinned) continue;
        const homeX = n.kind === 'app' ? w * 0.28 : w * 0.72;
        n.vx += (homeX - n.x) * 0.008 * alpha;
        n.vy += (h / 2 - n.y) * 0.0008 * alpha;
      }

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const minDist = a.r + b.r + 36;
          if (dist < minDist) {
            const push = ((minDist - dist) / dist) * 1.35 * alpha;
            if (!a.pinned) {
              a.vx -= dx * push;
              a.vy -= dy * push;
            }
            if (!b.pinned) {
              b.vx += dx * push;
              b.vy += dy * push;
            }
          }
        }
      }

      for (const link of links) {
        const a = ids.get(link.source);
        const b = ids.get(link.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const target = 180 + a.r + b.r;
        const force = (dist - target) * 0.014 * alpha;
        if (!a.pinned) {
          a.vx += (dx / dist) * force;
          a.vy += (dy / dist) * force;
        }
        if (!b.pinned) {
          b.vx -= (dx / dist) * force;
          b.vy -= (dy / dist) * force;
        }
      }

      let movement = 0;
      for (const n of nodes) {
        if (n.pinned) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= 0.72;
        n.vy *= 0.72;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.min(w - 20, Math.max(20, n.x));
        n.y = Math.min(h - 20, Math.max(20, n.y));
        movement += Math.abs(n.vx) + Math.abs(n.vy);
      }
      settledFrames = movement < 0.28 ? settledFrames + 1 : 0;
      if (settledFrames >= 28) {
        for (const n of nodes) {
          n.pinned = true;
          n.vx = 0;
          n.vy = 0;
        }
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (settledFrames < 28) simulate(dt);

      const width = canvas.clientWidth || w;
      const tall = canvas.clientHeight || h;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(tall * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(tall * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, tall);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, width, tall);

      const v = viewportRef.current;
      ctx.save();
      ctx.translate(v.tx, v.ty);
      ctx.scale(v.scale, v.scale);

      const ids = byId();
      const sel = selectedRef.current;

      for (const link of links) {
        const a = ids.get(link.source);
        const b = ids.get(link.target);
        if (!a || !b) continue;
        const dim = sel && sel.id !== a.id && sel.id !== b.id;
        const t = maxWeight > 0 ? link.weight / maxWeight : 0;
        const color = link.kind === 'write' ? WRITE : READ;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 - 18;
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.strokeStyle = color;
        ctx.globalAlpha = dim ? 0.05 : 0.12 + t * 0.35;
        ctx.lineWidth = 1 + Math.sqrt(t) * 8;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (const n of nodesRef.current) {
        const dim = sel && sel.id !== n.id;
        const color = n.kind === 'app' ? APP : READ;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = dim ? 'rgba(168,176,186,0.35)' : `${color}22`;
        ctx.fill();
        ctx.strokeStyle = dim ? 'rgba(168,176,186,0.55)' : color;
        ctx.lineWidth = sel?.id === n.id ? 2.4 : 1.4;
        ctx.stroke();

        ctx.font = `${n.kind === 'app' ? 600 : 500} 11px var(--font-jetbrains, ui-monospace, monospace)`;
        ctx.fillStyle = dim ? 'rgba(122,130,140,0.55)' : '#4a525c';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
        ctx.fillText(label, n.x, n.y + n.r + 4);
      }

      ctx.restore();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [nodesSeed, links, maxWeight, height]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(viewportRef.current, e.clientX - rect.left, e.clientY - rect.top);
    let hit: SimNode | null = null;
    for (const n of [...nodesRef.current].reverse()) {
      if (Math.hypot(n.x - world.x, n.y - world.y) <= n.r + 4) {
        hit = n;
        break;
      }
    }
    if (hit) {
      hit.pinned = true;
      setSelected(hit);
      dragRef.current = { kind: 'node', id: hit.id, ox: world.x - hit.x, oy: world.y - hit.y };
    } else {
      setSelected(null);
      dragRef.current = {
        kind: 'pan',
        ox: e.clientX - viewportRef.current.tx,
        oy: e.clientY - viewportRef.current.ty,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    if (drag.kind === 'pan') {
      viewportRef.current = {
        ...viewportRef.current,
        tx: e.clientX - drag.ox,
        ty: e.clientY - drag.oy,
      };
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(viewportRef.current, e.clientX - rect.left, e.clientY - rect.top);
    const node = nodesRef.current.find((n) => n.id === drag.id);
    if (!node) return;
    node.x = world.x - drag.ox;
    node.y = world.y - drag.oy;
    node.vx = 0;
    node.vy = 0;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const drag = dragRef.current;
    if (drag?.kind === 'node') {
      const node = nodesRef.current.find((n) => n.id === drag.id);
      if (node) node.pinned = false;
    }
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const v = viewportRef.current;
    const next = Math.min(2.4, Math.max(0.45, v.scale * (e.deltaY < 0 ? 1.08 : 0.92)));
    viewportRef.current = { ...v, scale: next };
  };

  if (edges.length === 0) {
    return <div className="empty">Nothing to draw for this week.</div>;
  }

  const related =
    selected === null
      ? []
      : links
          .filter((l) => l.source === selected.id || l.target === selected.id)
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 8);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-foreground-muted">
        <span>Bubble size = attributed time · drag nodes · scroll zoom · pan background{truncated ? ' · top 48 by weight' : ''}</span>
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: APP }} />
            App
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: WRITE }} />
            Table / writes
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-[1px]" style={{ background: READ, opacity: 0.7 }} />
            Reads
          </span>
        </span>
      </div>
      <div
        className="relative overflow-hidden rounded-[3px] border border-border"
        style={{ height }}
      >
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
        />
        <button
          type="button"
          className="absolute right-2 top-2 rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[10px] text-foreground-secondary hover:text-foreground"
          onClick={() => {
            viewportRef.current = { scale: 1, tx: 0, ty: 0 };
            setSelected(null);
          }}
        >
          Reset view
        </button>
      </div>
      {selected && (
        <div className="mt-2 rounded-[3px] border border-border bg-[var(--surface)] px-3 py-2 text-[12px]">
          <div className="font-mono text-[11px]">
            {selected.kind === 'app' ? 'App' : 'Table'} · {selected.label}
          </div>
          <div className="text-foreground-muted">
            Weight {formatNumber(selected.weight, 0)} ms · {related.length} link(s)
          </div>
          {related.length > 0 && (
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-foreground-secondary">
              {related.map((l) => {
                const other = l.source === selected.id ? l.target : l.source;
                const otherNode = nodesRef.current.find((n) => n.id === other);
                return (
                  <li key={`${l.source}-${l.target}`}>
                    ↔ {otherNode?.label ?? other.replace(/^(app|table):/, '')} ·{' '}
                    {formatNumber(l.weight, 0)} ms
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
