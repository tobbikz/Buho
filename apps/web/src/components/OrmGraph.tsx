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
  const settledRef = useRef(0);

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
    const golden = Math.PI * (3 - Math.sqrt(5));

    const schemas = model.nodes.filter((n) => n.kind === 'schema');
    const tables = model.nodes.filter((n) => n.kind === 'table');
    const schemaPos = new Map<string, { x: number; y: number }>();
    const schemaCount = Math.max(1, schemas.length);
    schemas.forEach((node, i) => {
      const col = i % Math.ceil(Math.sqrt(schemaCount));
      const row = Math.floor(i / Math.ceil(Math.sqrt(schemaCount)));
      const cols = Math.ceil(Math.sqrt(schemaCount));
      const rows = Math.ceil(schemaCount / cols);
      schemaPos.set(node.label, {
        x: w * (0.18 + (0.64 * (col + 0.5)) / cols),
        y: h * (0.18 + (0.64 * (row + 0.5)) / rows),
      });
    });
    const tablesBySchema = new Map<string, typeof tables>();
    for (const node of tables) {
      const schema = node.id.includes('.')
        ? node.id.replace(/^table:/, '').split('.')[0] ?? 'public'
        : 'public';
      const list = tablesBySchema.get(schema) ?? [];
      list.push(node);
      tablesBySchema.set(schema, list);
    }

    nodesRef.current = model.nodes.map((node, i) => {
      const r =
        node.kind === 'schema'
          ? schemaRadius(model.schemas.find((s) => s.name === node.label)?.tableCount ?? 1)
          : tableRadius(node.sizeBytes, model.maxSize);
      let x: number;
      let y: number;
      if (node.kind === 'schema') {
        const pos = schemaPos.get(node.label) ?? { x: w / 2, y: h / 2 };
        x = pos.x;
        y = pos.y;
      } else {
        const schema = node.id.replace(/^table:/, '').split('.')[0] ?? 'public';
        const home = schemaPos.get(schema) ?? { x: w / 2, y: h / 2 };
        const siblings = tablesBySchema.get(schema) ?? [node];
        const idx = siblings.findIndex((s) => s.id === node.id);
        const angle = idx * golden;
        const ring = 36 + Math.sqrt(idx + 1) * (siblings.length > 40 ? 14 : 22);
        x = home.x + Math.cos(angle) * ring;
        y = home.y + Math.sin(angle) * ring;
      }
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        x,
        y,
        vx: 0,
        vy: 0,
        r,
        data: node,
        // Huge catalogs start nearly settled so they do not explode.
        pinned: model.nodes.length > 180,
      };
    });

    viewportRef.current = { scale: 1, tx: 0, ty: 0 };
    settledRef.current = 0;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let last = performance.now();

    const nodeById = () => {
      const map = new Map<string, SimNode>();
      for (const n of nodesRef.current) map.set(n.id, n);
      return map;
    };

    const simulate = (dt: number) => {
      const nodes = nodesRef.current;
      const alpha = Math.min(1, dt * 1.1);
      const ids = nodeById();
      const huge = nodes.length > 120;
      const large = nodes.length > 60;

      for (const n of nodes) {
        if (n.pinned) continue;
        n.vx += (w / 2 - n.x) * (huge ? 0.0002 : large ? 0.0004 : 0.001) * alpha;
        n.vy += (h / 2 - n.y) * (huge ? 0.0002 : large ? 0.0004 : 0.001) * alpha;
      }

      // Spatial hash: O(n) neighbor checks instead of O(n²) — huge catalogs
      // used to explode and bounce forever.
      const cell = huge ? 56 : large ? 72 : 0;
      if (cell > 0) {
        const grid = new Map<string, number[]>();
        const key = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
        for (let i = 0; i < nodes.length; i += 1) {
          const n = nodes[i]!;
          const k = key(n.x, n.y);
          const bucket = grid.get(k);
          if (bucket) bucket.push(i);
          else grid.set(k, [i]);
        }
        const pushPair = (i: number, j: number) => {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const minDist = a.r + b.r + (a.kind === 'schema' && b.kind === 'schema' ? 40 : 12);
          if (dist >= minDist + (huge ? 24 : 48)) return;
          if (dist < minDist) {
            const push = ((minDist - dist) / dist) * (huge ? 0.7 : 1.1) * alpha;
            if (!a.pinned) {
              a.vx -= dx * push;
              a.vy -= dy * push;
            }
            if (!b.pinned) {
              b.vx += dx * push;
              b.vy += dy * push;
            }
          }
          const repulse =
            (a.kind === 'schema' || b.kind === 'schema' ? 180 : 90) /
            (dist * dist * Math.max(1, Math.sqrt(nodes.length / 12)));
          if (!a.pinned) {
            a.vx -= (dx / dist) * repulse * alpha;
            a.vy -= (dy / dist) * repulse * alpha;
          }
          if (!b.pinned) {
            b.vx += (dx / dist) * repulse * alpha;
            b.vy += (dy / dist) * repulse * alpha;
          }
        };
        for (const [k, bucket] of grid) {
          const [cx, cy] = k.split(':').map(Number) as [number, number];
          for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
              const other = grid.get(`${cx + dx}:${cy + dy}`);
              if (!other) continue;
              for (const i of bucket) {
                for (const j of other) {
                  if (j <= i) continue;
                  pushPair(i, j);
                }
              }
            }
          }
        }
      } else {
        for (let i = 0; i < nodes.length; i += 1) {
          for (let j = i + 1; j < nodes.length; j += 1) {
            const a = nodes[i]!;
            const b = nodes[j]!;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const minDist = a.r + b.r + (a.kind === 'schema' && b.kind === 'schema' ? 48 : 14);
            if (dist < minDist) {
              const push = ((minDist - dist) / dist) * 2.2 * alpha;
              if (!a.pinned) {
                a.vx -= dx * push;
                a.vy -= dy * push;
              }
              if (!b.pinned) {
                b.vx += dx * push;
                b.vy += dy * push;
              }
            }
            const repulse =
              (a.kind === 'schema' || b.kind === 'schema' ? 420 : 180) /
              (dist * dist * Math.max(1, Math.sqrt(nodes.length / 8)));
            if (!a.pinned) {
              a.vx -= (dx / dist) * repulse * alpha;
              a.vy -= (dy / dist) * repulse * alpha;
            }
            if (!b.pinned) {
              b.vx += (dx / dist) * repulse * alpha;
              b.vy += (dy / dist) * repulse * alpha;
            }
          }
        }
      }

      const capa = layerRef.current;
      for (const link of linkIndex) {
        if (capa === 'estructura' && link.kind === 'traffic') continue;
        if (capa === 'trafico' && link.kind === 'membership') continue;
        if (capa === 'trafico' && link.kind === 'fk') continue;

        const a = ids.get(link.source);
        const b = ids.get(link.target);
        if (!a || !b) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const target =
          link.kind === 'membership'
            ? 38 + a.r + b.r
            : link.kind === 'fk'
              ? 96 + a.r + b.r
              : 92 + a.r + b.r;
        const strength =
          link.kind === 'membership' ? 0.06 : link.kind === 'fk' ? 0.024 : 0.018;
        const force = (dist - target) * strength * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.pinned) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!b.pinned) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      let movement = 0;
      for (const n of nodes) {
        if (n.pinned) continue;
        n.vx *= nodes.length > 120 ? 0.55 : nodes.length > 60 ? 0.65 : 0.84;
        n.vy *= nodes.length > 120 ? 0.55 : nodes.length > 60 ? 0.65 : 0.84;
        n.x += n.vx * alpha;
        n.y += n.vy * alpha;
        movement += Math.abs(n.vx) + Math.abs(n.vy);
      }
      settledRef.current = movement < 0.5 ? settledRef.current + 1 : 0;
      if (settledRef.current >= (nodes.length > 120 ? 28 : nodes.length > 60 ? 40 : 90)) {
        for (const n of nodes) {
          n.pinned = true;
          n.vx = 0;
          n.vy = 0;
        }
      }
    };

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
      const now = performance.now();
      const dt = Math.min((now - last) / 16, 2);
      last = now;

      if (settledRef.current < (nodesRef.current.length > 120 ? 28 : nodesRef.current.length > 60 ? 40 : 90)) simulate(dt);

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

      const ids = nodeById();

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
    viewportRef.current = { scale: 1, tx: 0, ty: 0 };
    for (const n of nodesRef.current) {
      n.pinned = false;
      n.vx = 0;
      n.vy = 0;
    }
    settledRef.current = 0;
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
