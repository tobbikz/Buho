'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrmLayer, OrmModel, OrmNode, OrmTable } from '@/lib/orm-types';
import { formatBytesShort } from '@/lib/orm-types';
import { formatUnit, type Unit } from '@/lib/units';

const WRITE = '#0a6e42';
const READ = '#005eb8';
const SCHEMA = '#5c6b7a';
const TABLE = '#8a5a00';
const BG = '#f7f8f9';
const FK = 'rgba(120, 132, 148, 0.38)';
const MEMBERSHIP = 'rgba(168, 176, 186, 0.14)';

interface SimNode {
  id: string;
  kind: 'schema' | 'table';
  label: string;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  r: number;
  data: OrmNode;
  pinned: boolean;
}

interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

interface Curve {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  perpX: number;
  perpY: number;
}

function tableRadius(sizeBytes: number, maxSize: number): number {
  if (sizeBytes <= 0) return 5;
  const t = Math.log10(sizeBytes + 1) / Math.log10(maxSize + 1);
  return 5 + t * 9;
}

function schemaRadius(tableCount: number): number {
  return 28 + Math.min(tableCount, 14) * 2.2;
}

function screenToWorld(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
}

function linkCurve(a: SimNode, b: SimNode): Curve {
  const x1 = a.x;
  const y1 = a.y;
  const x2 = b.x;
  const y2 = b.y;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(48, 12 + len * 0.08);
  const cx = mx - (dy / len) * bow;
  const cy = my + (dx / len) * bow;
  return { x1, y1, cx, cy, x2, y2, perpX: -dy / len, perpY: dx / len };
}

function strokeQuad(ctx: CanvasRenderingContext2D, curve: Curve) {
  ctx.beginPath();
  ctx.moveTo(curve.x1, curve.y1);
  ctx.quadraticCurveTo(curve.cx, curve.cy, curve.x2, curve.y2);
  ctx.stroke();
}

function drawLabelPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { dim?: boolean; strong?: boolean } = {},
) {
  ctx.font = `${opts.strong ? 600 : 500} 10px var(--font-jetbrains, ui-monospace, monospace)`;
  const w = ctx.measureText(text).width;
  const padX = 5;
  const padY = 3;
  const boxW = w + padX * 2;
  const boxH = 12 + padY * 2;
  const left = x - boxW / 2;
  const top = y - boxH / 2;

  ctx.fillStyle = opts.dim ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.94)';
  ctx.strokeStyle = opts.dim ? 'rgba(205, 211, 218, 0.45)' : 'rgba(205, 211, 218, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(left, top, boxW, boxH);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = opts.dim ? 'rgba(122, 130, 140, 0.55)' : '#4a525c';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function clusterRadius(tableCount: number, hubRadius: number): number {
  return hubRadius + 22 + Math.sqrt(Math.max(tableCount, 1)) * 26;
}

/** Schemas sit on a ring; each schema's tables sit in a sunflower around it. */
function seedLayout(nodes: SimNode[], width: number, height: number): void {
  const schemas = nodes.filter((node) => node.kind === 'schema');
  const bySchema = new Map<string, SimNode[]>();
  for (const table of nodes) {
    if (table.kind !== 'table') continue;
    const key = table.data.schema ?? '';
    const list = bySchema.get(key);
    if (list) list.push(table);
    else bySchema.set(key, [table]);
  }

  const golden = Math.PI * (3 - Math.sqrt(5));
  const clusters = schemas.map((schema) => {
    const members = bySchema.get(schema.label) ?? [];
    return { schema, members, radius: clusterRadius(members.length, schema.r) };
  });
  const placed = new Set(clusters.flatMap((cluster) => cluster.members.map((member) => member.id)));
  const orphans = nodes.filter((node) => node.kind === 'table' && !placed.has(node.id));

  const cx = width / 2;
  const cy = height / 2;
  const padding = 56;
  const orbit =
    clusters.length <= 1
      ? 0
      : Math.max(
          240,
          clusters.reduce((sum, cluster) => sum + cluster.radius * 2 + padding, 0) / (2 * Math.PI),
        );

  let theta = -Math.PI / 2;
  for (const cluster of clusters) {
    const arc = clusters.length <= 1 ? 0 : (cluster.radius * 2 + padding) / Math.max(orbit, 1);
    const angle = clusters.length <= 1 ? 0 : theta + arc / 2;
    cluster.schema.x = cx + Math.cos(angle) * orbit;
    cluster.schema.y = cy + Math.sin(angle) * orbit;
    cluster.members.forEach((table, index) => {
      const ang = index * golden;
      const rad = cluster.schema.r + 18 + Math.sqrt(index + 1) * (table.r * 2.2 + 8);
      table.x = cluster.schema.x + Math.cos(ang) * rad;
      table.y = cluster.schema.y + Math.sin(ang) * rad;
    });
    theta += arc;
  }

  orphans.forEach((table, index) => {
    const ang = index * golden;
    const rad = 90 + Math.sqrt(index + 1) * 30;
    table.x = cx + Math.cos(ang) * rad;
    table.y = cy + Math.sin(ang) * rad;
  });
}

/**
 * A few capped steps to separate overlaps and let foreign keys tug neighbors.
 * No stored velocity: the old integrator kept full-strength springs forever, and
 * with hundreds of tables the motion never dropped under the settle threshold.
 */
function relaxLayout(nodes: SimNode[], links: { source: string; target: string; kind: string }[]): void {
  const steps = nodes.length > 220 ? 8 : 16;
  const cell = 80;
  const index = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    node.homeX = node.x;
    node.homeY = node.y;
  }

  for (let step = 0; step < steps; step += 1) {
    for (const link of links) {
      if (link.kind !== 'fk') continue;
      const a = index.get(link.source);
      const b = index.get(link.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const target = 140 + a.r + b.r;
      const delta = Math.max(-1.2, Math.min(1.2, (dist - target) * 0.01));
      const ux = dx / dist;
      const uy = dy / dist;
      a.x += ux * delta;
      a.y += uy * delta;
      b.x -= ux * delta;
      b.y -= uy * delta;
    }

    for (const node of nodes) {
      node.x += (node.homeX - node.x) * 0.45;
      node.y += (node.homeY - node.y) * 0.45;
    }

    const bins = new Map<string, SimNode[]>();
    for (const node of nodes) {
      const key = `${Math.floor(node.x / cell)}:${Math.floor(node.y / cell)}`;
      const bin = bins.get(key);
      if (bin) bin.push(node);
      else bins.set(key, [node]);
    }

    for (const node of nodes) {
      const gx = Math.floor(node.x / cell);
      const gy = Math.floor(node.y / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bin = bins.get(`${gx + ox}:${gy + oy}`);
          if (!bin) continue;
          for (const other of bin) {
            if (other.id <= node.id) continue;
            const dx = other.x - node.x;
            const dy = other.y - node.y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const gap = node.kind === 'schema' || other.kind === 'schema' ? 20 : 8;
            const minDist = node.r + other.r + gap;
            if (dist >= minDist) continue;
            const push = Math.min((minDist - dist) * 0.5, 3);
            const ux = dx / dist;
            const uy = dy / dist;
            node.x -= ux * push;
            node.y -= uy * push;
            other.x += ux * push;
            other.y += uy * push;
          }
        }
      }
    }
  }

  for (const node of nodes) {
    node.vx = 0;
    node.vy = 0;
    node.homeX = node.x;
    node.homeY = node.y;
  }
}

function fitViewport(nodes: SimNode[], width: number, height: number): Viewport {
  if (nodes.length === 0) return { scale: 1, tx: 0, ty: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.r);
    minY = Math.min(minY, node.y - node.r);
    maxX = Math.max(maxX, node.x + node.r);
    maxY = Math.max(maxY, node.y + node.r);
  }
  const pad = 48;
  const spanX = Math.max(maxX - minX + pad * 2, 1);
  const spanY = Math.max(maxY - minY + pad * 2, 1);
  const scale = Math.min(1, width / spanX, height / spanY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return { scale, tx: width / 2 - midX * scale, ty: height / 2 - midY * scale };
}

function tableBorderColor(node: OrmNode, capa: OrmLayer): string {
  if (capa === 'estructura') return 'rgba(120, 132, 148, 0.55)';
  const write = node.writeHeat;
  const read = node.readHeat;
  if (write <= 0 && read <= 0) return 'rgba(120, 132, 148, 0.55)';
  if (write >= read * 1.15) return 'rgba(10, 110, 66, 0.75)';
  if (read >= write * 1.15) return 'rgba(0, 94, 184, 0.75)';
  return TABLE;
}

export function OrmGraph({
  model,
  instanceId,
  unit,
  layer,
}: {
  model: OrmModel;
  instanceId: number;
  unit: Unit;
  layer: OrmLayer;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const viewportRef = useRef<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ kind: 'pan' | 'node'; nodeId?: string; ox: number; oy: number } | null>(null);
  const animRef = useRef(0);
  const viewHomeRef = useRef<Viewport>({ scale: 1, tx: 0, ty: 0 });

  const [selected, setSelected] = useState<OrmTable | null>(null);
  const [hover, setHover] = useState<OrmTable | null>(null);
  const selectedRef = useRef<OrmTable | null>(null);
  const hoverRef = useRef<OrmTable | null>(null);
  const layerRef = useRef(layer);
  const [search, setSearch] = useState('');
  const searchRef = useRef('');

  const linkIndex = useMemo(() => model.links, [model.links]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  useEffect(() => {
    layerRef.current = layer;
  }, [layer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || model.nodes.length === 0) return;

    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 520;

    nodesRef.current = model.nodes.map((node) => {
      const r =
        node.kind === 'schema'
          ? schemaRadius(model.schemas.find((s) => s.name === node.label)?.tableCount ?? 1)
          : tableRadius(node.sizeBytes, model.maxSize);
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        x: w / 2,
        y: h / 2,
        homeX: w / 2,
        homeY: h / 2,
        vx: 0,
        vy: 0,
        r,
        data: node,
        pinned: false,
      };
    });

    seedLayout(nodesRef.current, w, h);
    relaxLayout(nodesRef.current, linkIndex);
    const fitted = fitViewport(nodesRef.current, w, h);
    viewHomeRef.current = fitted;
    viewportRef.current = { ...fitted };

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const drawTrafficBand = (
      curve: Curve,
      color: string,
      width: number,
      offset: number,
      alpha: number,
    ) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(curve.x1 + curve.perpX * offset, curve.y1 + curve.perpY * offset);
      ctx.quadraticCurveTo(
        curve.cx + curve.perpX * offset,
        curve.cy + curve.perpY * offset,
        curve.x2 + curve.perpX * offset,
        curve.y2 + curve.perpY * offset,
      );
      ctx.stroke();
      ctx.restore();
    };

    const draw = () => {
      const ancho = canvas.clientWidth;
      const alto = canvas.clientHeight;
      if (canvas.width !== Math.floor(ancho * dpr) || canvas.height !== Math.floor(alto * dpr)) {
        canvas.width = Math.floor(ancho * dpr);
        canvas.height = Math.floor(alto * dpr);
      }

      const v = viewportRef.current;
      const nodes = nodesRef.current;
      const capa = layerRef.current;
      const needle = searchRef.current.trim().toLowerCase();
      const focusId = selectedRef.current
        ? `table:${selectedRef.current.relation}`
        : hoverRef.current
          ? `table:${hoverRef.current.relation}`
          : null;

      const neighborIds = new Set<string>();
      if (focusId) {
        neighborIds.add(focusId);
        for (const link of linkIndex) {
          if (link.source === focusId) neighborIds.add(link.target);
          if (link.target === focusId) neighborIds.add(link.source);
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ancho, alto);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, ancho, alto);

      ctx.save();
      ctx.translate(v.tx, v.ty);
      ctx.scale(v.scale, v.scale);

      const ids = new Map<string, SimNode>();
      for (const node of nodes) ids.set(node.id, node);

      for (const link of linkIndex) {
        if (capa === 'estructura' && link.kind === 'traffic') continue;
        if (capa === 'trafico' && link.kind === 'membership') continue;
        if (capa === 'trafico' && link.kind === 'fk') continue;

        const a = ids.get(link.source);
        const b = ids.get(link.target);
        if (!a || !b) continue;

        const dim = focusId !== null && !neighborIds.has(a.id) && !neighborIds.has(b.id);
        const curve = linkCurve(a, b);

        if (link.kind === 'membership') {
          ctx.save();
          ctx.strokeStyle = MEMBERSHIP;
          ctx.globalAlpha = dim ? 0.05 : 1;
          ctx.lineWidth = 0.75;
          strokeQuad(ctx, curve);
          ctx.restore();
          continue;
        }

        if (link.kind === 'fk') {
          ctx.save();
          ctx.strokeStyle = FK;
          ctx.globalAlpha = dim ? 0.07 : capa === 'ambos' ? 0.55 : 0.85;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 5]);
          strokeQuad(ctx, curve);
          ctx.setLineDash([]);
          ctx.restore();
          continue;
        }

        const t = model.maxTraffic > 0 ? link.traffic / model.maxTraffic : 0;
        if (t <= 0) continue;

        const writeShare = link.traffic > 0 ? link.writeTraffic / link.traffic : 0.5;
        const readShare = 1 - writeShare;
        const writeW = 1.2 + t * 5 * writeShare;
        const readW = 1.2 + t * 5 * readShare;
        const lane = 2.4 + t * 2.2;
        const baseAlpha = dim ? 0.08 : 0.22 + t * 0.28;

        drawTrafficBand(curve, WRITE, writeW, -lane * readShare, baseAlpha * (0.65 + writeShare * 0.35));
        drawTrafficBand(curve, READ, readW, lane * writeShare, baseAlpha * (0.65 + readShare * 0.35));
      }

      for (const n of nodes) {
        const matches =
          !needle || n.label.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle);
        const dim = focusId !== null ? !neighborIds.has(n.id) : !matches;
        const isSelected = selectedRef.current?.relation === n.data.table?.relation;
        const isHover = hoverRef.current?.relation === n.data.table?.relation;

        if (n.kind === 'schema') {
          ctx.save();
          ctx.globalAlpha = dim ? 0.2 : 1;
          ctx.strokeStyle = SCHEMA;
          ctx.lineWidth = 1.25;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(92, 107, 122, 0.06)';
          ctx.fill();
          ctx.restore();

          drawLabelPill(ctx, n.label, n.x, n.y, { dim, strong: true });
          continue;
        }

        const heat = model.maxHeat > 0 ? n.data.heat / model.maxHeat : 0;
        const showHeat = capa !== 'estructura' && heat > 0;

        ctx.save();
        ctx.globalAlpha = dim ? 0.22 : 1;

        if (showHeat) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 2.5, 0, Math.PI * 2);
          ctx.fillStyle =
            n.data.writeHeat >= n.data.readHeat
              ? `rgba(10, 110, 66, ${0.06 + heat * 0.12})`
              : `rgba(0, 94, 184, ${0.06 + heat * 0.12})`;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = isSelected ? READ : tableBorderColor(n.data, capa);
        ctx.lineWidth = isSelected ? 2 : isHover ? 1.75 : 1.25;
        ctx.stroke();
        ctx.restore();

        if (isSelected || isHover || n.r >= 7 || showHeat) {
          const label = n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label;
          drawLabelPill(ctx, label, n.x, n.y - n.r - 10, { dim });
        }
      }

      ctx.restore();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [model, linkIndex]);

  const pickNode = (sx: number, sy: number): SimNode | null => {
    const { x, y } = screenToWorld(viewportRef.current, sx, sy);
    let best: SimNode | null = null;
    let dist = Infinity;
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - x, n.y - y);
      const hit = n.kind === 'schema' ? n.r + 8 : n.r + 5;
      if (d < hit && d < dist) {
        dist = d;
        best = n;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const box = canvas.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    const node = pickNode(sx, sy);
    if (node?.kind === 'table' && node.data.table) {
      dragRef.current = { kind: 'node', nodeId: node.id, ox: sx, oy: sy };
      node.pinned = true;
      setSelected(node.data.table);
    } else if (node) {
      dragRef.current = { kind: 'node', nodeId: node.id, ox: sx, oy: sy };
      node.pinned = true;
    } else {
      dragRef.current = { kind: 'pan', ox: sx - viewportRef.current.tx, oy: sy - viewportRef.current.ty };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !drag) return;
    const box = canvas.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;

    if (drag.kind === 'pan') {
      viewportRef.current.tx = sx - drag.ox;
      viewportRef.current.ty = sy - drag.oy;
      return;
    }

    const node = nodesRef.current.find((n) => n.id === drag.nodeId);
    if (!node) return;
    const world = screenToWorld(viewportRef.current, sx, sy);
    node.x = world.x;
    node.y = world.y;
    node.vx = 0;
    node.vy = 0;
    if (node.data.table) setHover(node.data.table);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (dragRef.current?.kind === 'node') {
      const node = nodesRef.current.find((n) => n.id === dragRef.current?.nodeId);
      if (node) node.pinned = false;
    }
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    const v = viewportRef.current;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    const nextScale = Math.min(4, Math.max(0.25, v.scale * factor));
    const wx = (sx - v.tx) / v.scale;
    const wy = (sy - v.ty) / v.scale;
    v.scale = nextScale;
    v.tx = sx - wx * nextScale;
    v.ty = sy - wy * nextScale;
  };

  const onMouseMoveHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const node = pickNode(e.clientX - box.left, e.clientY - box.top);
    setHover(node?.kind === 'table' ? (node.data.table ?? null) : null);
  };

  const resetView = () => {
    viewportRef.current = { ...viewHomeRef.current };
    for (const n of nodesRef.current) {
      n.x = n.homeX;
      n.y = n.homeY;
      n.vx = 0;
      n.vy = 0;
      n.pinned = false;
    }
  };

  const foco = selected ?? hover;
  const focoHeat = foco ? foco.writeHeat + foco.readHeat : 0;
  const focoWritePct = foco && focoHeat > 0 ? Math.round((foco.writeHeat / focoHeat) * 100) : 0;

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_16rem]">
      <div
        className="relative overflow-hidden rounded-[3px] border border-border bg-[var(--surface-muted)]"
        style={{ height: '72vh', minHeight: 520 }}
      >
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          style={{ cursor: dragRef.current?.kind === 'pan' ? 'grabbing' : 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
          onMouseMove={onMouseMoveHover}
          onMouseLeave={() => !dragRef.current && setHover(null)}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter tables…"
              className="w-44 rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[10px] placeholder:text-foreground-muted"
            />
            <div className="flex items-center gap-2 rounded-[3px] border border-border bg-[var(--surface)]/95 px-2 py-1 text-[10px] text-foreground-muted">
              <span>Dashed ring = schema</span>
              <span className="text-border">|</span>
              <span>Dot = table</span>
              {layer !== 'estructura' ? (
                <>
                  <span className="text-border">|</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-1.5 w-3 rounded-[1px]" style={{ background: WRITE }} />
                    Write
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-1.5 w-3 rounded-[1px]" style={{ background: READ }} />
                    Read
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={resetView}
            className="pointer-events-auto rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[10px] text-foreground-secondary hover:text-foreground"
          >
            Reset view
          </button>
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[10px] text-foreground-muted">
          Pan · zoom · drag · curved FK · dual bands = write/read traffic
        </div>
      </div>

      <aside className="panel xl:sticky xl:top-4 xl:self-start">
        <div className="panel-header">
          <span className="panel-title">{foco ? foco.relation : 'Catalog graph'}</span>
        </div>
        <div className="panel-body text-[11px] leading-relaxed text-foreground-secondary">
          {!foco ? (
            <p>
              Schemas group tables; dashed curves are foreign keys. In traffic mode, each FK carries two
              bands — green for writes, blue for reads.
            </p>
          ) : (
            <>
              <dl className="space-y-2">
                <div>
                  <dt className="text-foreground-muted">Schema</dt>
                  <dd className="font-mono">{foco.schema}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">Size</dt>
                  <dd>{formatBytesShort(foco.sizeBytes)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">Live / dead tuples</dt>
                  <dd>
                    {foco.liveTuples.toLocaleString()} / {foco.deadTuples.toLocaleString()}
                  </dd>
                </div>
                {layer !== 'estructura' ? (
                  <>
                    <div>
                      <dt className="text-foreground-muted">Write heat</dt>
                      <dd>{formatUnit(foco.writeHeat, unit)}</dd>
                    </div>
                    <div>
                      <dt className="text-foreground-muted">Read heat</dt>
                      <dd>{formatUnit(foco.readHeat, unit)}</dd>
                    </div>
                    {focoHeat > 0 ? (
                      <div>
                        <dt className="mb-1 text-foreground-muted">Write / read mix</dt>
                        <dd>
                          <div className="flex h-2 w-full overflow-hidden rounded-[1px] bg-[var(--surface-muted)]">
                            <div className="h-full" style={{ width: `${focoWritePct}%`, background: WRITE }} />
                            <div
                              className="h-full"
                              style={{ width: `${100 - focoWritePct}%`, background: READ }}
                            />
                          </div>
                        </dd>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {foco.apps.length > 0 ? (
                  <div>
                    <dt className="text-foreground-muted">Apps seen</dt>
                    <dd className="font-mono text-[10px]">{foco.apps.slice(0, 4).join(', ')}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="mt-3 flex flex-col gap-1">
                <Link href={`/instances/${instanceId}/flow`} className="link">
                  Open in Flow
                </Link>
                <Link
                  href={`/instances/${instanceId}/queries?buscar=${encodeURIComponent(foco.name)}`}
                  className="link"
                >
                  See queries
                </Link>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
