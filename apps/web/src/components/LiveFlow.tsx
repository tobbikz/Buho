'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnit, type Unit } from '@/lib/units';

export interface LiveNode {
  name: string;
  depth: number;
  label: string;
}

export interface LiveLink {
  source: number;
  target: number;
  /** Weight per second. */
  value: number;
  kind?: 'write' | 'read';
}

interface Snapshot {
  nodes: LiveNode[];
  links: LiveLink[];
  windowMinutes: number;
  generatedAt: string;
  referenceRate: number | null;
  activeSessions: number | null;
  blockedSessions: number | null;
  error?: string;
}

interface Corridor {
  from: number;
  to: number;
  value: number;
  kind: 'write' | 'read';
}

interface Particle {
  corridor: number;
  t: number;
  speed: number;
  size: number;
  lane: number;
}

const PARTICLES_PER_RATE = 0.7;
const MAX_PARTICLES_PER_SECOND = 48;
const MAX_PARTICLES = 72;
const COMET_LEN = 0.07;
const COMET_SAMPLES = 6;

/**
 * TEMP stress-test: paint N synthetic tables so we can see scale.
 * Set to 0 to restore real live data only.
 */
const DEMO_TABLE_COUNT = 0;

/** Viewport packing — 10 detailed cards in 2 columns, fitted inside the stage. */
const PAGE_SIZE = 10;
const MAX_TABLE_COLS = 2;
const TABLE_CARD_W = 168;
const TABLE_COL_GAP = 14;
const TABLE_RIGHT_PAD = 18;
const STAGE_INSET = 10;

const WRITE = '#0a6e42';
const READ = '#005eb8';
const TABLE = '#8a5a00';
const MIN_NODE_HEIGHT = 26;

const THEME = {
  bg: '#eef1f4',
  stage: '#ffffff',
  stageBorder: '#d8dde5',
  card: '#ffffff',
  cardBorder: '#c9d0d9',
  label: 'rgba(55, 62, 71, 0.95)',
  labelMuted: 'rgba(110, 118, 128, 0.85)',
};

function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function pointOnCubic(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const medio = (a.x + b.x) / 2;
  const u = 1 - t;
  return {
    x: u ** 3 * a.x + 3 * u ** 2 * t * medio + 3 * u * t ** 2 * medio + t ** 3 * b.x,
    y: u ** 3 * a.y + 3 * u ** 2 * t * a.y + 3 * u * t ** 2 * b.y + t ** 3 * b.y,
  };
}

function tangentOnCubic(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const p0 = pointOnCubic(a, b, Math.max(0, t - 0.01));
  const p1 = pointOnCubic(a, b, Math.min(1, t + 0.01));
  return { x: p1.x - p0.x, y: p1.y - p0.y };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function shortRate(value: number, unit: Unit): string {
  if (unit === 'ms') return `${formatUnit(value, 'ms')}/s`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k/s`;
  if (value > 0 && value < 10) return `${value.toFixed(value < 1 ? 2 : 1)}/s`;
  return `${Math.round(value).toLocaleString('en')}/s`;
}

/** Zipf-ish traffic across many tables for the temporary stress demo. */
function buildDemoSnapshot(count: number, seed?: Snapshot | null): Snapshot {
  const nodes: LiveNode[] = [
    { name: 'app:writes', depth: 0, label: 'Application writes' },
    { name: 'app:reads', depth: 0, label: 'Application reads' },
  ];
  const links: LiveLink[] = [];
  const schemas = ['public', 'buho_demo', 'analytics', 'billing', 'ops', 'crm'];
  let writeTotal = 0;
  let readTotal = 0;

  for (let i = 0; i < count; i += 1) {
    const schema = schemas[i % schemas.length]!;
    const name = i === 0 && seed ? 'orders' : `t_${String(i).padStart(3, '0')}`;
    const label = `${schema}.${name}`;
    const idx = nodes.length;
    nodes.push({ name: `table:${label}`, depth: 2, label });

    // Hot head + long tail (first ~8 tables carry most traffic).
    const rank = i + 1;
    const write = Math.max(0.4, 6200 / Math.pow(rank, 1.15) + (i % 7 === 0 ? 180 : 0));
    const read = Math.max(0.15, 420 / Math.pow(rank, 1.05) + (i % 5 === 0 ? 40 : 0));
    writeTotal += write;
    readTotal += read;
    links.push({ source: 0, target: idx, value: write, kind: 'write' });
    links.push({ source: 1, target: idx, value: read, kind: 'read' });
  }

  return {
    nodes,
    links,
    windowMinutes: seed?.windowMinutes ?? 5,
    generatedAt: new Date().toISOString(),
    referenceRate: writeTotal + readTotal,
    activeSessions: seed?.activeSessions ?? 12,
    blockedSessions: seed?.blockedSessions ?? 0,
  };
}

interface SpikeGlow {
  until: number;
  kind: 'write' | 'read' | 'both';
  strength: number;
}

interface NodePos {
  x: number;
  y: number;
  label: string;
  depth: number;
  weight: number;
  name: string;
  writeIn: number;
  readIn: number;
  /** Card size used for drawing + ribbon docks (set each frame). */
  cardW?: number;
  cardH?: number;
  /** Aggregated tail of the long list. */
  isOthers?: boolean;
  othersCount?: number;
  /** Schema aggregate node (group mode). */
  isSchema?: boolean;
  tableCount?: number;
  isTopWrite?: boolean;
  isTopRead?: boolean;
  isTopAttacked?: boolean;
  /** Sudden W/R jump — soft glow while active. */
  spike?: SpikeGlow | null;
}

/** Table / schema / others — width fixed; height fitted to stage at layout time. */
function tableCardSize(opts: {
  dense: boolean;
  compact: boolean;
  isOthers?: boolean;
  isSchema?: boolean;
  fittedH?: number;
}): { w: number; h: number } {
  const w = TABLE_CARD_W;
  if (opts.fittedH !== undefined) return { w, h: opts.fittedH };
  if (opts.isOthers) return { w, h: 44 };
  if (opts.dense) return { w, h: 36 };
  if (opts.compact) return { w, h: 52 };
  return { w, h: 64 };
}

/** Ribbon dock: APP uses right edge (x); tables dock on left edge facing APP. */
function ribbonPoint(nodo: NodePos): { x: number; y: number } {
  const w = nodo.cardW ?? 0;
  if (nodo.depth >= 2 && w > 0) {
    return { x: nodo.x - w / 2, y: nodo.y };
  }
  return { x: nodo.x, y: nodo.y };
}

interface PackMeta {
  tableCols: number;
  hiddenCount: number;
  visibleTables: number;
  totalTables: number;
  page: number;
  pageCount: number;
  pageSize: number;
  rangeStart: number;
  rangeEnd: number;
  fittedCardH: number;
}

type GroupMode = 'table' | 'schema';

interface HeatRank {
  hottestWrite: { label: string; rate: number } | null;
  hottestRead: { label: string; rate: number } | null;
  /** Highest combined W+R — “most attacked”. */
  mostAttacked: { label: string; rate: number } | null;
}

function schemaOfLabel(label: string): string {
  const limpio = label.replace(/^[a-z]+:/i, '');
  if (limpio.includes('.')) return limpio.split('.')[0]!;
  return limpio || 'unknown';
}

/** Collapse table leaves into schema nodes for group view. */
function aggregateBySchema(snap: Snapshot): Snapshot {
  const apps = snap.nodes
    .map((nodo, indice) => ({ nodo, indice }))
    .filter(({ nodo }) => nodo.depth === 0);
  const nodes: LiveNode[] = apps.map(({ nodo }) => ({ ...nodo }));
  const appIndex = new Map<number, number>();
  apps.forEach(({ indice }, nuevo) => appIndex.set(indice, nuevo));

  const schemas = new Map<string, { write: number; read: number; tables: number }>();
  for (const enlace of snap.links) {
    const dst = snap.nodes[enlace.target];
    if (!dst || dst.depth < 2) continue;
    const schema = schemaOfLabel(dst.label);
    const slot = schemas.get(schema) ?? { write: 0, read: 0, tables: 0 };
    if (enlace.kind === 'write') slot.write += enlace.value;
    else if (enlace.kind === 'read') slot.read += enlace.value;
    schemas.set(schema, slot);
  }

  // Count distinct tables per schema from nodes.
  const seenTables = new Map<string, Set<string>>();
  for (const nodo of snap.nodes) {
    if (nodo.depth < 2) continue;
    const schema = schemaOfLabel(nodo.label);
    const set = seenTables.get(schema) ?? new Set<string>();
    set.add(nodo.name);
    seenTables.set(schema, set);
  }
  for (const [schema, set] of seenTables) {
    const slot = schemas.get(schema) ?? { write: 0, read: 0, tables: 0 };
    slot.tables = set.size;
    schemas.set(schema, slot);
  }

  const links: LiveLink[] = [];
  const writeApp = nodes.findIndex((n) => n.name.includes('writes'));
  const readApp = nodes.findIndex((n) => n.depth === 0 && !n.name.includes('writes'));

  for (const [schema, slot] of [...schemas.entries()].sort(
    (a, b) => b[1].write + b[1].read - (a[1].write + a[1].read),
  )) {
    const idx = nodes.length;
    nodes.push({
      name: `schema:${schema}`,
      depth: 2,
      label: schema,
    });
    if (slot.write > 0 && writeApp >= 0) {
      links.push({ source: writeApp, target: idx, value: slot.write, kind: 'write' });
    }
    if (slot.read > 0 && readApp >= 0) {
      links.push({ source: readApp, target: idx, value: slot.read, kind: 'read' });
    }
    // stash table count on name suffix for layout (parsed later)
    nodes[idx]!.name = `schema:${schema}|${slot.tables}`;
  }

  return { ...snap, nodes, links };
}

function rankHeat(nodos: NodePos[]): HeatRank {
  let hottestWrite: HeatRank['hottestWrite'] = null;
  let hottestRead: HeatRank['hottestRead'] = null;
  let mostAttacked: HeatRank['mostAttacked'] = null;
  for (const nodo of nodos) {
    if (!nodo || nodo.depth < 2 || nodo.isOthers) continue;
    if (!hottestWrite || nodo.writeIn > hottestWrite.rate) {
      hottestWrite = { label: nodo.label, rate: nodo.writeIn };
    }
    if (!hottestRead || nodo.readIn > hottestRead.rate) {
      hottestRead = { label: nodo.label, rate: nodo.readIn };
    }
    const total = nodo.writeIn + nodo.readIn;
    if (!mostAttacked || total > mostAttacked.rate) {
      mostAttacked = { label: nodo.label, rate: total };
    }
  }
  return { hottestWrite, hottestRead, mostAttacked };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function LiveFlow({
  scope,
  instanceId,
  weight,
  unit,
  height = 420,
  intervalMs = 5000,
  /** When false, packed APP→table map without moving particles. Default live (animated). */
  animated = true,
  /** Window used for /api/flow-live rates — match the Flow page window. */
  windowMinutes = 5,
}: {
  scope: 'instancia' | 'flota';
  instanceId?: number;
  weight: string;
  unit: Unit;
  height?: number;
  intervalMs?: number;
  animated?: boolean;
  windowMinutes?: number;
}) {
  const demoOn = DEMO_TABLE_COUNT > 0;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  const [zoomEnabled, setZoomEnabled] = useState(false);
  const [liveMotion, setLiveMotion] = useState(animated);
  const liveMotionRef = useRef(liveMotion);
  liveMotionRef.current = liveMotion;
  const viewportRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const [viewportH, setViewportH] = useState(
    typeof window !== 'undefined' ? window.innerHeight : 900,
  );

  useEffect(() => {
    if (!pantallaCompleta) return;
    const sync = () => setViewportH(window.innerHeight);
    sync();
    window.addEventListener('resize', sync);
    const onKey = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') setPantallaCompleta(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('resize', sync);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [pantallaCompleta]);

  /** Stage always matches viewport — layout packs into this, no tall scroll. */
  const marcoAlto = pantallaCompleta ? viewportH : height;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const packMetaRef = useRef<PackMeta>({
    tableCols: 1,
    hiddenCount: 0,
    visibleTables: 0,
    totalTables: 0,
    page: 0,
    pageCount: 1,
    pageSize: 10,
    rangeStart: 0,
    rangeEnd: 0,
    fittedCardH: 64,
  });
  const [packMeta, setPackMeta] = useState<PackMeta>(packMetaRef.current);
  const [tablePage, setTablePage] = useState(0);
  const tablePageRef = useRef(0);
  tablePageRef.current = tablePage;
  const prevHeatRef = useRef<Map<string, { w: number; r: number }>>(new Map());
  const spikeGlowsRef = useRef<Map<string, SpikeGlow>>(new Map());
  const smoothLinksRef = useRef<LiveLink[]>([]);
  const referenceRef = useRef(1);
  const unitRef = useRef(unit);
  unitRef.current = unit;
  const animatedRef = useRef(animated);
  animatedRef.current = animated;
  // Prefer the Live/Static toggle; prop is only the initial default.
  useEffect(() => {
    setLiveMotion(animated);
  }, [animated]);
  const posicionesRef = useRef<NodePos[]>([]);
  const [elegido, setElegido] = useState<{
    label: string;
    depth: number;
    name: string;
    writeIn: number;
    readIn: number;
    isTopWrite?: boolean;
    isTopRead?: boolean;
    isTopAttacked?: boolean;
    isSchema?: boolean;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(
    demoOn ? buildDemoSnapshot(DEMO_TABLE_COUNT) : null,
  );
  const [fallo, setFallo] = useState<string | null>(null);
  const [edad, setEdad] = useState(0);
  const [groupMode, setGroupMode] = useState<GroupMode>('table');
  const groupModeRef = useRef<GroupMode>('table');
  groupModeRef.current = groupMode;
  const [heatRank, setHeatRank] = useState<HeatRank>({
    hottestWrite: null,
    hottestRead: null,
    mostAttacked: null,
  });
  const heatRankRef = useRef<HeatRank>(heatRank);
  const lastRankPostRef = useRef(0);

  const url = useMemo(() => {
    const parametros = new URLSearchParams({
      alcance: scope,
      peso: weight,
      min: String(Math.max(1, Math.min(10080, Math.round(windowMinutes)))),
    });
    if (instanceId !== undefined) parametros.set('instancia', String(instanceId));
    return `/api/flow-live?${parametros.toString()}`;
  }, [scope, instanceId, weight, windowMinutes]);

  useEffect(() => {
    if (DEMO_TABLE_COUNT > 0) {
      const demo = buildDemoSnapshot(DEMO_TABLE_COUNT);
      snapshotRef.current = demo;
      referenceRef.current = demo.referenceRate ?? 1;
      setSnapshot(demo);
      setFallo(null);
      setEdad(0);

      // Gentle drift (not spikes): nudge a few mid-tail rates every ~6s so the
      // map stays alive without thrashing the numbers.
      const drift = setInterval(() => {
        const base = buildDemoSnapshot(DEMO_TABLE_COUNT);
        const tableIdx: number[] = [];
        base.nodes.forEach((n, i) => {
          if (n.depth >= 2) tableIdx.push(i);
        });
        if (tableIdx.length < 6) return;
        const picks = new Set<number>();
        while (picks.size < 4) {
          const rank = 3 + Math.floor(Math.random() * Math.min(30, tableIdx.length - 3));
          picks.add(tableIdx[rank]!);
        }
        const links = base.links.map((enlace) => {
          if (!picks.has(enlace.target)) return enlace;
          const factor = 0.92 + Math.random() * 0.2; // ±~8%
          return { ...enlace, value: Math.max(0.05, enlace.value * factor) };
        });
        const next: Snapshot = {
          ...base,
          links,
          generatedAt: new Date().toISOString(),
        };
        snapshotRef.current = next;
        setSnapshot(next);
        setEdad(0);
      }, 6000);

      return () => clearInterval(drift);
    }

    let vivo = true;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    const traer = async () => {
      try {
        const respuesta = await fetch(url, { cache: 'no-store' });
        const cuerpo = (await respuesta.json()) as Snapshot;
        if (!vivo) return;
        if (!respuesta.ok) {
          setFallo(cuerpo.error ?? `HTTP ${respuesta.status}`);
        } else {
          setFallo(null);
          const totalNuevo = cuerpo.links.reduce((suma, enlace) => suma + enlace.value, 0);
          referenceRef.current =
            cuerpo.referenceRate && cuerpo.referenceRate > 0
              ? Math.max(cuerpo.referenceRate, totalNuevo)
              : Math.max(totalNuevo, referenceRef.current * 0.985, 0.001);

          snapshotRef.current = cuerpo;
          setSnapshot(cuerpo);
          setEdad(0);
        }
      } catch (error) {
        if (vivo) setFallo(error instanceof Error ? error.message : String(error));
      }
      if (vivo) temporizador = setTimeout(traer, intervalMs);
    };

    traer();
    return () => {
      vivo = false;
      if (temporizador) clearTimeout(temporizador);
    };
  }, [url, intervalMs]);

  useEffect(() => {
    setTablePage(0);
  }, [groupMode]);

  useEffect(() => {
    if (tablePage > packMeta.pageCount - 1) {
      setTablePage(Math.max(0, packMeta.pageCount - 1));
    }
  }, [packMeta.pageCount, tablePage]);

  useEffect(() => {
    const reloj = setInterval(() => setEdad((valor) => valor + 1), 1000);
    return () => clearInterval(reloj);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particulas: Particle[] = [];
    const acumulado: number[] = [];
    let anterior = performance.now();
    let cuadro = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const layoutNodes = (
      snap: Snapshot,
      ancho: number,
      alto: number,
      enlaces: LiveLink[],
    ): { nodos: NodePos[]; meta: PackMeta; display: Snapshot } => {
      const pesoDe = new Map<number, number>();
      const writeIn = new Map<number, number>();
      const readIn = new Map<number, number>();

      for (const enlace of enlaces) {
        pesoDe.set(enlace.source, (pesoDe.get(enlace.source) ?? 0) + enlace.value);
        pesoDe.set(enlace.target, (pesoDe.get(enlace.target) ?? 0) + enlace.value);
        if (enlace.kind === 'write') {
          writeIn.set(enlace.target, (writeIn.get(enlace.target) ?? 0) + enlace.value);
        } else if (enlace.kind === 'read') {
          readIn.set(enlace.target, (readIn.get(enlace.target) ?? 0) + enlace.value);
        }
      }

      const apps: number[] = [];
      const tables: number[] = [];
      snap.nodes.forEach((nodo, indice) => {
        if (nodo.depth === 0) apps.push(indice);
        else if (nodo.depth >= 2) tables.push(indice);
      });

      apps.sort((a, b) => {
        const aw = snap.nodes[a]!.name.includes('writes') ? 0 : 1;
        const bw = snap.nodes[b]!.name.includes('writes') ? 0 : 1;
        return aw - bw;
      });
      tables.sort((a, b) => (pesoDe.get(b) ?? 0) - (pesoDe.get(a) ?? 0));

      const stageInset = STAGE_INSET;
      const topPad = Math.max(28, alto * 0.05);
      const botPad = Math.max(24, alto * 0.045);
      const utilY = Math.max(alto - topPad - botPad, 80);
      const appCardW = 108;
      const appCardH = 56;
      // Keep APP cards fully inside the white stage (left edge ≥ inset + pad).
      const appLeft = stageInset + 14;
      const margenIzq = appLeft + appCardW - 6;
      // Fixed page of 10 named tables in 2 columns. Pager for the rest (no +N chip in-grid).
      const pageSize = PAGE_SIZE;
      const totalTables = tables.length;
      const pageCount = Math.max(1, Math.ceil(totalTables / pageSize));
      const page = Math.min(Math.max(0, tablePageRef.current), pageCount - 1);
      const rangeStart = page * pageSize;
      const pageSlice = tables.slice(rangeStart, rangeStart + pageSize);
      const afterCount = totalTables - rangeStart - pageSlice.length;

      let visible = pageSlice;
      let hiddenCount = afterCount;
      let displayNodes = snap.nodes;
      let displayLinks = enlaces;

      if (pageSlice.length < tables.length || rangeStart > 0) {
        const headSet = new Set(pageSlice);
        displayLinks = enlaces.filter((enlace) => {
          const dst = snap.nodes[enlace.target];
          if (dst && dst.depth >= 2 && !headSet.has(enlace.target)) return false;
          const src = snap.nodes[enlace.source];
          if (src && src.depth >= 2 && !headSet.has(enlace.source)) return false;
          return true;
        });
      }

      const tableCols = Math.min(
        MAX_TABLE_COLS,
        Math.max(1, visible.length <= 5 ? 1 : 2),
      );
      const rowsPerCol = Math.ceil(visible.length / tableCols);
      const rowGap = 8;
      const fittedCardH = Math.max(
        48,
        Math.min(68, Math.floor(utilY / rowsPerCol) - rowGap),
      );
      const colPitch = TABLE_CARD_W + TABLE_COL_GAP;
      // Right edge of rightmost card stays inside the stage frame.
      const rightInner = ancho - stageInset - TABLE_RIGHT_PAD;
      const nodos: NodePos[] = [];

      const placeApps = () => {
        const paso = utilY / (apps.length + 1);
        apps.forEach((indice, orden) => {
          const nodo = displayNodes[indice]!;
          nodos[indice] = {
            x: margenIzq,
            y: topPad + paso * (orden + 1),
            label: nodo.label,
            depth: nodo.depth,
            weight: pesoDe.get(indice) ?? 0,
            name: nodo.name,
            writeIn: writeIn.get(indice) ?? 0,
            readIn: readIn.get(indice) ?? 0,
            cardW: appCardW,
            cardH: appCardH,
          };
        });
      };

      placeApps();

      visible.forEach((indice, orden) => {
        const col = Math.floor(orden / rowsPerCol);
        const row = orden % rowsPerCol;
        const inCol = Math.min(rowsPerCol, visible.length - col * rowsPerCol);
        // Even vertical packing so cards never spill past top/bottom pads.
        const pitch = utilY / inCol;
        const y = topPad + pitch * (row + 0.5);
        const x = rightInner - TABLE_CARD_W / 2 - (tableCols - 1 - col) * colPitch;
        const nodo = displayNodes[indice]!;
        nodos[indice] = {
          x,
          y,
          label: nodo.label,
          depth: nodo.depth,
          weight: pesoDe.get(indice) ?? 0,
          name: nodo.name,
          writeIn: writeIn.get(indice) ?? 0,
          readIn: readIn.get(indice) ?? 0,
          cardW: TABLE_CARD_W,
          cardH: fittedCardH,
        };
      });

      const namedOnPage = visible.length;
      const meta: PackMeta = {
        tableCols,
        hiddenCount,
        visibleTables: namedOnPage,
        totalTables,
        page,
        pageCount,
        pageSize,
        rangeStart: rangeStart + (namedOnPage > 0 ? 1 : 0),
        rangeEnd: rangeStart + namedOnPage,
        fittedCardH,
      };

      return {
        nodos,
        meta,
        display: {
          ...snap,
          nodes: displayNodes,
          links: displayLinks,
        },
      };
    };

    /** Collapse APP → schema → table into direct APP ↔ table corridors. */
    const buildCorridors = (snap: Snapshot, nodos: NodePos[], enlaces: LiveLink[]): Corridor[] => {
      const writeApp = snap.nodes.findIndex((n) => n.depth === 0 && n.name.includes('writes'));
      const readApp = snap.nodes.findIndex((n) => n.depth === 0 && !n.name.includes('writes'));
      const corridors: Corridor[] = [];

      snap.nodes.forEach((nodo, indice) => {
        if (nodo.depth < 2 || !nodos[indice]) return;
        const w = nodos[indice]!.writeIn;
        const r = nodos[indice]!.readIn;
        if (w > 0 && writeApp >= 0 && nodos[writeApp]) {
          corridors.push({ from: writeApp, to: indice, value: w, kind: 'write' });
        }
        if (r > 0 && readApp >= 0 && nodos[readApp]) {
          // Travel direction: table → APP read.
          corridors.push({ from: indice, to: readApp, value: r, kind: 'read' });
        }
      });

      // Fallback if writeIn/readIn empty: use leaf/root links.
      if (corridors.length === 0) {
        for (const enlace of enlaces) {
          if (enlace.value <= 0) continue;
          const src = snap.nodes[enlace.source];
          const dst = snap.nodes[enlace.target];
          if (!src || !dst) continue;
          if (enlace.kind === 'write' && src.depth === 0 && dst.depth >= 2) {
            corridors.push({
              from: enlace.source,
              to: enlace.target,
              value: enlace.value,
              kind: 'write',
            });
          }
        }
      }

      return corridors;
    };

    const dibujar = (ahora: number) => {
      const delta = Math.min((ahora - anterior) / 1000, 0.05);
      anterior = ahora;
      const unitNow = unitRef.current;

      const snap = snapshotRef.current;
      const ancho = canvas.clientWidth;
      const alto = Math.max(canvas.clientHeight, MIN_NODE_HEIGHT);
      if (canvas.width !== Math.floor(ancho * dpr) || canvas.height !== Math.floor(alto * dpr)) {
        canvas.width = Math.floor(ancho * dpr);
        canvas.height = Math.floor(alto * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ancho, alto);

      // Outer wash + inset stage so the diagram owns a defined frame.
      ctx.fillStyle = THEME.bg;
      ctx.fillRect(0, 0, ancho, alto);
      const inset = 10;
      roundRect(ctx, inset, inset, ancho - inset * 2, alto - inset * 2, 4);
      ctx.fillStyle = THEME.stage;
      ctx.fill();
      ctx.strokeStyle = THEME.stageBorder;
      ctx.lineWidth = 1;
      ctx.stroke();

      const vista = viewportRef.current;
      ctx.save();
      if (vista.scale !== 1 || vista.tx !== 0 || vista.ty !== 0) {
        ctx.translate(vista.tx, vista.ty);
        ctx.scale(vista.scale, vista.scale);
      }

      if (!snap || snap.links.length === 0) {
        ctx.restore();
        cuadro = requestAnimationFrame(dibujar);
        return;
      }

      const targetLinks = snap.links;
      if (smoothLinksRef.current.length !== targetLinks.length) {
        smoothLinksRef.current = targetLinks.map((enlace) => ({ ...enlace }));
      } else {
        const blend = 1 - Math.exp(-delta * 1.15); // slow ease — readable, still live
        for (let i = 0; i < targetLinks.length; i += 1) {
          const suave = smoothLinksRef.current[i]!;
          const objetivo = targetLinks[i]!;
          suave.value = lerp(suave.value, objetivo.value, blend);
          suave.source = objetivo.source;
          suave.target = objetivo.target;
          suave.kind = objetivo.kind;
        }
      }

      const enlaces = smoothLinksRef.current;
      const modo = groupModeRef.current;
      const baseSnap: Snapshot = {
        ...snap,
        links: enlaces,
        nodes: snap.nodes,
      };
      const viewSnap = modo === 'schema' ? aggregateBySchema(baseSnap) : baseSnap;
      const packed = layoutNodes(viewSnap, ancho, alto, viewSnap.links);
      const nodos = packed.nodos;
      const displaySnap = packed.display;
      posicionesRef.current = nodos.filter(Boolean);
      const prevMeta = packMetaRef.current;
      if (
        prevMeta.hiddenCount !== packed.meta.hiddenCount ||
        prevMeta.tableCols !== packed.meta.tableCols ||
        prevMeta.visibleTables !== packed.meta.visibleTables ||
        prevMeta.page !== packed.meta.page ||
        prevMeta.pageCount !== packed.meta.pageCount ||
        prevMeta.totalTables !== packed.meta.totalTables ||
        prevMeta.rangeStart !== packed.meta.rangeStart ||
        prevMeta.rangeEnd !== packed.meta.rangeEnd ||
        prevMeta.fittedCardH !== packed.meta.fittedCardH
      ) {
        packMetaRef.current = packed.meta;
        queueMicrotask(() => setPackMeta(packed.meta));
      }

      // Tag schema aggregates + heat crowns.
      for (const nodo of nodos) {
        if (!nodo || nodo.depth < 2) continue;
        if (nodo.name.startsWith('schema:')) {
          nodo.isSchema = true;
          const parts = nodo.name.split('|');
          const count = Number(parts[1] ?? 0);
          if (Number.isFinite(count) && count > 0) nodo.tableCount = count;
          nodo.label = (parts[0] ?? nodo.name).replace(/^schema:/, '');
        }
      }
      const ranks = rankHeat(nodos.filter(Boolean) as NodePos[]);
      for (const nodo of nodos) {
        if (!nodo || nodo.depth < 2) continue;
        nodo.isTopWrite = ranks.hottestWrite?.label === nodo.label;
        nodo.isTopRead = ranks.hottestRead?.label === nodo.label;
        nodo.isTopAttacked = ranks.mostAttacked?.label === nodo.label;
        nodo.spike = null;
      }
      if (ahora - lastRankPostRef.current > 500) {
        lastRankPostRef.current = ahora;
        const prev = heatRankRef.current;
        if (
          prev.hottestWrite?.label !== ranks.hottestWrite?.label ||
          prev.hottestRead?.label !== ranks.hottestRead?.label ||
          prev.mostAttacked?.label !== ranks.mostAttacked?.label ||
          prev.hottestWrite?.rate !== ranks.hottestWrite?.rate ||
          prev.hottestRead?.rate !== ranks.hottestRead?.rate ||
          prev.mostAttacked?.rate !== ranks.mostAttacked?.rate
        ) {
          heatRankRef.current = ranks;
          queueMicrotask(() => setHeatRank(ranks));
        }
      }

      const corridors = buildCorridors(displaySnap, nodos, displaySnap.links);
      const total = corridors.reduce((suma, c) => suma + c.value, 0);
      const referencia = Math.max(referenceRef.current, total, 0.001);
      const actividad = Math.min(1, total / referencia);

      const corTotal = corridors.reduce((suma, c) => suma + c.value, 0) || 1;
      const moving = liveMotionRef.current;

      // Size cards before ribbons — prefer sizes stamped at layout (fitted to stage).
      for (const nodo of nodos) {
        if (!nodo) continue;
        if (nodo.depth === 0) {
          nodo.cardW = nodo.cardW ?? 108;
          nodo.cardH = nodo.cardH ?? 56;
        } else if (nodo.depth >= 2) {
          const size = tableCardSize({
            dense: false,
            compact: false,
            isOthers: nodo.isOthers,
            isSchema: nodo.isSchema,
            fittedH: nodo.cardH ?? packed.meta.fittedCardH,
          });
          nodo.cardW = size.w;
          nodo.cardH = size.h;
        }
      }

      if (!moving) {
        // Ops map: no ribbons — APP + table chips only (corridors stay for layout/heat).
        particulas.length = 0;
      } else {
        // Particles — clean comets (optional / demo).
        const writes = corridors
          .map((cor, i) => ({ cor, i }))
          .filter(({ cor }) => cor.kind === 'write' && cor.value > 0);
        const reads = corridors
          .map((cor, i) => ({ cor, i }))
          .filter(({ cor }) => cor.kind === 'read' && cor.value > 0);

        const rawEmission = Math.min(
          DEMO_TABLE_COUNT > 0 ? 55 : MAX_PARTICLES_PER_SECOND * 0.55,
          Math.log10(1 + total) * 1.8 * PARTICLES_PER_RATE + Math.min(total, 6) * 0.08,
        );
        const writeShare =
          writes.length && reads.length ? 0.62 : writes.length ? 1 : 0;
        const readShare = 1 - writeShare;
        const particleLimit = DEMO_TABLE_COUNT > 0 ? 140 : MAX_PARTICLES;

        const emitPool = (
          pool: { cor: Corridor; i: number }[],
          budget: number,
        ) => {
          if (pool.length === 0 || budget <= 0) return;
          const pesos = pool.map(({ cor }) => Math.pow(cor.value, 0.4));
          const pesoTotal = pesos.reduce((s, p) => s + p, 0) || 1;
          const floor = Math.max(0.15, (budget * 0.2) / pool.length);
          pool.forEach(({ cor, i }, orden) => {
            const cuota = pesos[orden]! / pesoTotal;
            const rate = Math.max(floor, budget * cuota);
            acumulado[i] = (acumulado[i] ?? Math.random()) + delta * rate;
            while ((acumulado[i] ?? 0) >= 1 && particulas.length < particleLimit) {
              acumulado[i] = (acumulado[i] ?? 0) - 1;
              particulas.push({
                corridor: i,
                t: 0,
                // Slower comets — readable on 60 Hz without looking glued together.
                speed: 0.09 + Math.min(0.14, Math.log10(1 + cor.value) * 0.035),
                size: 2 + Math.min(2.8, Math.pow(cuota, 0.35) * 2.2),
                lane: (Math.random() - 0.5) * 1.1,
              });
            }
          });
        };

        emitPool(writes, rawEmission * writeShare);
        emitPool(reads, rawEmission * readShare);

        for (let i = particulas.length - 1; i >= 0; i -= 1) {
          const particula = particulas[i]!;
          particula.t += particula.speed * delta;
          if (particula.t >= 1) {
            particulas.splice(i, 1);
            continue;
          }

          const cor = corridors[particula.corridor];
          if (!cor) {
            particulas.splice(i, 1);
            continue;
          }
          const from = nodos[cor.from];
          const to = nodos[cor.to];
          if (!from || !to) {
            particulas.splice(i, 1);
            continue;
          }

          const color = cor.kind === 'write' ? WRITE : READ;
          const t = particula.t;
          const brillo = Math.sin(Math.PI * t);
          const laneSpread = 10 + Math.sqrt(cor.value / corTotal) * 18;
          const a = ribbonPoint(from);
          const b = ribbonPoint(to);

          const offsetPoint = (tt: number) => {
            const p = pointOnCubic(a, b, tt);
            const tan = tangentOnCubic(a, b, tt);
            const len = Math.hypot(tan.x, tan.y) || 1;
            const nx = -tan.y / len;
            const ny = tan.x / len;
            const spread = laneSpread * particula.lane;
            return { x: p.x + nx * spread, y: p.y + ny * spread };
          };

          const tTail = Math.max(0, t - COMET_LEN);
          ctx.beginPath();
          for (let s = 0; s <= COMET_SAMPLES; s += 1) {
            const u = s / COMET_SAMPLES;
            const tt = tTail + (t - tTail) * u;
            const p = offsetPoint(tt);
            if (s === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          ctx.strokeStyle = hexAlpha(color, 0.28 + brillo * 0.32);
          ctx.lineWidth = Math.max(1.4, particula.size * 0.9);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();

          const head = offsetPoint(t);
          ctx.beginPath();
          ctx.arc(head.x, head.y, Math.max(1.8, particula.size * 0.75), 0, Math.PI * 2);
          ctx.fillStyle = hexAlpha(color, 0.88 + brillo * 0.12);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(head.x, head.y, Math.max(0.8, particula.size * 0.3), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${0.55 + brillo * 0.3})`;
          ctx.fill();
        }
      }

      const pulso = moving
        ? 0.5 + 0.5 * Math.sin(ahora / (1100 - actividad * 450))
        : 0.55;

      nodos.forEach((nodo) => {
        if (!nodo) return;
        const activo = nodo.weight > 0;

        if (nodo.depth === 0) {
          const isWrite = nodo.name.includes('writes');
          const color = isWrite ? WRITE : READ;
          const cardW = nodo.cardW ?? 108;
          const cardH = nodo.cardH ?? 56;
          const x = nodo.x - cardW + 6;
          const y = nodo.y - cardH / 2;

          roundRect(ctx, x, y, cardW, cardH, 3);
          ctx.fillStyle = THEME.card;
          ctx.fill();
          ctx.strokeStyle = activo ? color : THEME.cardBorder;
          ctx.lineWidth = activo ? 1.6 : 1;
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.fillRect(x, y, 3, cardH);

          ctx.font = '600 8px ui-sans-serif, system-ui, sans-serif';
          ctx.fillStyle = THEME.labelMuted;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText('APPLICATION', x + 10, y + 8);

          ctx.font = '600 12px ui-monospace, SFMono-Regular, monospace';
          ctx.fillStyle = color;
          ctx.fillText(isWrite ? 'WRITE →' : '← READ', x + 10, y + 22);

          ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
          ctx.fillStyle = THEME.label;
          ctx.fillText(shortRate(nodo.weight, unitNow), x + 10, y + 38);

          ctx.beginPath();
          ctx.arc(nodo.x, nodo.y, 3 + pulso * 0.4, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          return;
        }

        if (nodo.depth >= 2) {
          const cardW = nodo.cardW ?? 118;
          const cardH = nodo.cardH ?? 30;
          const x = nodo.x - cardW / 2;
          const y = nodo.y - cardH / 2;

          if (nodo.isOthers) {
            roundRect(ctx, x, y, cardW, cardH, 3);
            ctx.fillStyle = '#f4f6f8';
            ctx.fill();
            ctx.strokeStyle = THEME.cardBorder;
            ctx.setLineDash([3, 2]);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
            ctx.fillStyle = THEME.labelMuted;
            ctx.fillText(`+${nodo.othersCount ?? 0} more →`, x + 10, nodo.y - 5);
            ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
            ctx.fillStyle = WRITE;
            ctx.fillText(`W ${shortRate(nodo.writeIn, unitNow)}`, x + 10, nodo.y + 8);
            ctx.fillStyle = READ;
            const wLab = `W ${shortRate(nodo.writeIn, unitNow)}`;
            ctx.fillText(
              `R ${shortRate(nodo.readIn, unitNow)}`,
              x + 10 + ctx.measureText(wLab).width + 10,
              nodo.y + 8,
            );
            return;
          }

          // Prefer name (`table:schema.rel`) — Sankey short labels drop the schema.
          const rawName = nodo.name.replace(/^(table|schema):/i, '').split('|')[0] ?? '';
          const fromName = rawName.includes('.') ? rawName.split('.') : null;
          const parts = nodo.label.includes('.')
            ? nodo.label.split('.')
            : fromName && fromName.length > 1
              ? fromName
              : [nodo.label];
          const schema = parts.length > 1 ? parts[0]! : '';
          const table = parts.length > 1 ? parts.slice(1).join('.') : nodo.label;
          const accent = nodo.isSchema ? '#5c6b7a' : TABLE;
          const hot = Boolean(nodo.isTopAttacked);

          // Solid chip on top of ribbons — no glow (keeps corridors readable behind).
          roundRect(ctx, x, y, cardW, cardH, 4);
          ctx.fillStyle = hot ? 'rgba(138, 90, 0, 0.07)' : THEME.card;
          ctx.fill();
          ctx.strokeStyle = activo ? accent : THEME.cardBorder;
          ctx.lineWidth = hot ? 1.8 : activo ? 1.4 : 1;
          ctx.stroke();
          ctx.fillStyle = accent;
          ctx.fillRect(x, y, 3, cardH);

          // Crowns — top-right inside the chip.
          const drawCrowns = (baselineY: number, rightX: number, fontPx: number) => {
            ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            let badgeX = rightX;
            if (nodo.isTopAttacked) {
              ctx.fillStyle = TABLE;
              ctx.fillText('HOT', badgeX, baselineY);
              badgeX -= fontPx * 2.6;
            }
            if (nodo.isTopWrite) {
              ctx.fillStyle = WRITE;
              ctx.fillText('W↑', badgeX, baselineY);
              badgeX -= fontPx * 2.1;
            }
            if (nodo.isTopRead) {
              ctx.fillStyle = READ;
              ctx.fillText('R↑', badgeX, baselineY);
            }
          };

          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          const tight = cardH < 58;

          if (nodo.isSchema) {
            ctx.font = '600 8px ui-sans-serif, system-ui, sans-serif';
            ctx.fillStyle = THEME.labelMuted;
            ctx.fillText('SCHEMA', x + 10, y + 6);
            ctx.font = `600 ${tight ? 12 : 13}px ui-monospace, SFMono-Regular, monospace`;
            ctx.fillStyle = THEME.label;
            const schemaLabel = nodo.label.length > 14 ? `${nodo.label.slice(0, 13)}…` : nodo.label;
            ctx.fillText(schemaLabel, x + 10, y + 18);
            ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
            ctx.fillStyle = WRITE;
            ctx.fillText(`W ${shortRate(nodo.writeIn, unitNow)}`, x + 10, y + (tight ? 34 : 38));
            ctx.fillStyle = READ;
            ctx.fillText(`R ${shortRate(nodo.readIn, unitNow)}`, x + 10, y + (tight ? 46 : 52));
            drawCrowns(y + 10, x + cardW - 8, 8);
            return;
          }

          if (schema) {
            ctx.font = '8px ui-monospace, SFMono-Regular, monospace';
            ctx.fillStyle = THEME.labelMuted;
            ctx.fillText(schema, x + 10, y + 5);
          }
          const nameY = schema ? y + 17 : y + 8;
          ctx.font = `600 ${tight ? 12 : 13}px ui-monospace, SFMono-Regular, monospace`;
          ctx.fillStyle = THEME.label;
          const tableLabel = table.length > 15 ? `${table.slice(0, 14)}…` : table;
          ctx.fillText(tableLabel, x + 10, nameY);

          ctx.font = `600 ${tight ? 10 : 11}px ui-monospace, SFMono-Regular, monospace`;
          ctx.fillStyle = WRITE;
          ctx.fillText(`W ${shortRate(nodo.writeIn, unitNow)}`, x + 10, y + (tight ? 34 : 40));
          ctx.fillStyle = READ;
          ctx.fillText(`R ${shortRate(nodo.readIn, unitNow)}`, x + 10, y + (tight ? 46 : 54));

          drawCrowns(y + 10, x + cardW - 8, 8);
        }
      });

      ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = WRITE;
      ctx.fillText('● WRITE', inset + 8, alto - inset - 6);
      ctx.fillStyle = READ;
      ctx.fillText('● READ', inset + 72, alto - inset - 6);
      if (packed.meta.pageCount > 1 || packed.meta.hiddenCount > 0) {
        ctx.fillStyle = THEME.labelMuted;
        ctx.fillText(
          `${packed.meta.rangeStart}–${packed.meta.rangeEnd} of ${packed.meta.totalTables}` +
            (packed.meta.hiddenCount ? ` · +${packed.meta.hiddenCount} quieter` : ''),
          inset + 140,
          alto - inset - 6,
        );
      }

      ctx.restore();
      cuadro = requestAnimationFrame(dibujar);
    };

    cuadro = requestAnimationFrame(dibujar);
    return () => cancelAnimationFrame(cuadro);
  }, []);

  const total = (snapshot?.links ?? [])
    .filter((enlace) => (snapshot?.nodes[enlace.source]?.depth ?? 0) === 0)
    .reduce((suma, enlace) => suma + enlace.value, 0);

  const tasa =
    unit === 'ms'
      ? formatUnit(total, 'ms')
      : total > 0 && total < 10
        ? total.toLocaleString('en', { maximumFractionDigits: total < 1 ? 2 : 1 })
        : formatUnit(total, unit);
  const quieto = !snapshot || snapshot.links.length === 0 || total <= 0;

  const alPinchar = (evento: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const caja = canvas.getBoundingClientRect();
    const x = evento.clientX - caja.left;
    const y = evento.clientY - caja.top;

    let mejor: NodePos | null = null;
    let mejorScore = Infinity;
    for (const nodo of posicionesRef.current) {
      const w = nodo.cardW ?? 40;
      const h = nodo.cardH ?? 28;
      let left: number;
      let top: number;
      if (nodo.depth === 0) {
        left = nodo.x - w + 6;
        top = nodo.y - h / 2;
      } else {
        left = nodo.x - w / 2;
        top = nodo.y - h / 2;
      }
      if (x >= left && x <= left + w && y >= top && y <= top + h) {
        const cx = left + w / 2;
        const cy = top + h / 2;
        const score = Math.hypot(cx - x, cy - y);
        if (score < mejorScore) {
          mejorScore = score;
          mejor = nodo;
        }
      }
    }
    if (mejor?.isOthers) {
      setTablePage((p) => Math.min(p + 1, Math.max(0, packMetaRef.current.pageCount - 1)));
      setElegido(null);
      return;
    }
    setElegido(
      mejor
        ? {
            label: mejor.label,
            depth: mejor.depth,
            name: mejor.name,
            writeIn:
              mejor.depth === 0 && mejor.name.includes('writes')
                ? mejor.weight
                : mejor.writeIn,
            readIn:
              mejor.depth === 0 && !mejor.name.includes('writes')
                ? mejor.weight
                : mejor.readIn,
            isTopWrite: mejor.isTopWrite,
            isTopRead: mejor.isTopRead,
            isTopAttacked: mejor.isTopAttacked,
            isSchema: mejor.isSchema,
          }
        : null,
    );
  };

  const objetivo = elegido ? elegido.name.replace(/^[a-z]+:/i, '') : null;
  const destinos: { href: string; label: string }[] = [];
  if (elegido && objetivo) {
    const base = instanceId !== undefined ? `/instances/${instanceId}` : null;
    if (base) {
      destinos.push({
        href: `${base}/queries?buscar=${encodeURIComponent(elegido.depth === 2 ? (objetivo.split('.').pop() ?? objetivo) : objetivo)}`,
        label: 'see its queries',
      });
      if (elegido.depth === 2) {
        destinos.push({ href: `${base}/vacuum`, label: 'vacuum and bloat' });
        destinos.push({ href: `${base}/indexes`, label: 'indexes and suggestions' });
      }
    }
  }

  return (
    <div>
      <div
        ref={stageRef}
        className={
          pantallaCompleta
            ? 'fixed inset-0 z-[200] flex flex-col overflow-hidden border-0 bg-[var(--surface-muted)]'
            : 'relative flex flex-col overflow-hidden rounded-[3px] border border-border bg-[var(--surface-muted)]'
        }
        style={{ height: marcoAlto }}
      >
        <div className="z-10 flex flex-wrap items-center gap-2 border-b border-border bg-[var(--surface)] px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              className={`tag ${groupMode === 'table' ? 'tag--info' : 'tag--muted'}`}
              onClick={() => setGroupMode('table')}
            >
              By table
            </button>
            <button
              type="button"
              className={`tag ${groupMode === 'schema' ? 'tag--info' : 'tag--muted'}`}
              onClick={() => setGroupMode('schema')}
            >
              By schema
            </button>
          </div>
          <span className="text-foreground-muted">·</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 font-mono text-[10px]">
            {heatRank.hottestWrite && (
              <span className="rounded-[3px] border border-[#0a6e42]/30 bg-[#0a6e42]/8 px-2 py-0.5 text-[#0a6e42]">
                Most written · {heatRank.hottestWrite.label} ·{' '}
                {shortRate(heatRank.hottestWrite.rate, unit)}
              </span>
            )}
            {heatRank.hottestRead && (
              <span className="rounded-[3px] border border-[#005eb8]/30 bg-[#005eb8]/8 px-2 py-0.5 text-[#005eb8]">
                Most read · {heatRank.hottestRead.label} · {shortRate(heatRank.hottestRead.rate, unit)}
              </span>
            )}
            {heatRank.mostAttacked && (
              <span className="rounded-[3px] border border-[#8a5a00]/35 bg-[#8a5a00]/10 px-2 py-0.5 text-[#8a5a00]">
                Most attacked · {heatRank.mostAttacked.label} ·{' '}
                {shortRate(heatRank.mostAttacked.rate, unit)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {packMeta.pageCount > 1 && (
              <div className="flex items-center gap-1 font-mono text-[10px]">
                <button
                  type="button"
                  className="tag tag--muted"
                  disabled={tablePage <= 0}
                  onClick={() => setTablePage((p) => Math.max(0, p - 1))}
                  title="Hotter tables"
                >
                  ← Hotter
                </button>
                <span className="px-1 text-foreground-muted">
                  {packMeta.rangeStart}–{packMeta.rangeEnd} of {packMeta.totalTables}
                </span>
                <button
                  type="button"
                  className="tag tag--muted"
                  disabled={tablePage >= packMeta.pageCount - 1}
                  onClick={() =>
                    setTablePage((p) => Math.min(packMeta.pageCount - 1, p + 1))
                  }
                  title="Quieter tables"
                >
                  Quieter →
                </button>
              </div>
            )}
            {demoOn && (
              <div className="pointer-events-none rounded-[3px] border border-amber-500/40 bg-amber-50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-amber-900">
                Demo · {DEMO_TABLE_COUNT}
              </div>
            )}
            <button
              type="button"
              className={`tag ${liveMotion ? 'tag--info' : 'tag--muted'}`}
              onClick={() => setLiveMotion((v) => !v)}
              aria-label={liveMotion ? 'Switch to static map' : 'Switch to live motion'}
              title={liveMotion ? 'Live motion on — click for static map' : 'Static map — click for live motion'}
            >
              {liveMotion ? 'Live' : 'Static'}
            </button>
            <button
              type="button"
              className={`tag ${zoomEnabled ? 'tag--info' : 'tag--muted'}`}
              onClick={() => {
                setZoomEnabled((v) => {
                  if (v) viewportRef.current = { scale: 1, tx: 0, ty: 0 };
                  return !v;
                });
              }}
              aria-label={zoomEnabled ? 'Disable zoom' : 'Enable zoom'}
              title={zoomEnabled ? 'Zoom on — scroll to zoom, drag to pan' : 'Enable zoom / pan'}
            >
              {zoomEnabled ? 'Zoom on' : 'Zoom'}
            </button>
            <button
              type="button"
              className="tag tag--muted"
              onClick={() => setPantallaCompleta((v) => !v)}
              aria-label={pantallaCompleta ? 'Exit fullscreen' : 'Enter fullscreen'}
              title={pantallaCompleta ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            >
              {pantallaCompleta ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <canvas
            ref={canvasRef}
            className={`h-full w-full ${zoomEnabled ? 'cursor-grab' : 'cursor-pointer'}`}
            onClick={(evento) => {
              if (zoomEnabled) return;
              alPinchar(evento);
            }}
            onWheel={(evento) => {
              if (!zoomEnabled) return;
              evento.preventDefault();
              const v = viewportRef.current;
              const factor = evento.deltaY < 0 ? 1.08 : 0.92;
              const next = Math.min(2.8, Math.max(0.55, v.scale * factor));
              viewportRef.current = { ...v, scale: next };
            }}
            onPointerDown={(evento) => {
              if (!zoomEnabled) return;
              const canvas = canvasRef.current;
              if (!canvas) return;
              canvas.setPointerCapture(evento.pointerId);
              (canvas as HTMLCanvasElement & { __pan?: { ox: number; oy: number } }).__pan = {
                ox: evento.clientX - viewportRef.current.tx,
                oy: evento.clientY - viewportRef.current.ty,
              };
            }}
            onPointerMove={(evento) => {
              if (!zoomEnabled) return;
              const canvas = canvasRef.current as
                | (HTMLCanvasElement & { __pan?: { ox: number; oy: number } })
                | null;
              const pan = canvas?.__pan;
              if (!pan) return;
              viewportRef.current = {
                ...viewportRef.current,
                tx: evento.clientX - pan.ox,
                ty: evento.clientY - pan.oy,
              };
            }}
            onPointerUp={(evento) => {
              const canvas = canvasRef.current as
                | (HTMLCanvasElement & { __pan?: { ox: number; oy: number } })
                | null;
              if (canvas?.hasPointerCapture(evento.pointerId)) {
                canvas.releasePointerCapture(evento.pointerId);
              }
              if (canvas) delete canvas.__pan;
            }}
          />

        {elegido && (
          <div className="absolute bottom-3 right-3 z-20 w-[min(100%-1.5rem,20rem)] rounded-[3px] border border-border bg-[var(--surface)] px-3 py-2.5 text-[11px] shadow-md">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                {elegido.depth === 0
                  ? 'application'
                  : elegido.isSchema || elegido.name.startsWith('schema:')
                    ? 'schema'
                    : 'table'}
              </div>
              <div className="flex gap-1 font-mono text-[9px]">
                {elegido.isTopAttacked ? (
                  <span className="text-[#8a5a00]">HOT</span>
                ) : null}
                {elegido.isTopWrite ? <span className="text-[#0a6e42]">W↑</span> : null}
                {elegido.isTopRead ? <span className="text-[#005eb8]">R↑</span> : null}
              </div>
            </div>
            <div className="mb-2 break-all font-mono text-[13px] font-semibold text-foreground">
              {elegido.name.replace(/^(table|schema):/i, '').split('|')[0] || elegido.label}
            </div>
            {elegido.depth >= 2 ? (
              <div className="mb-2 grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="rounded-[3px] border border-[#0a6e42]/25 bg-[#0a6e42]/8 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-[0.06em] text-[#0a6e42]">Write</div>
                  <div className="text-[13px] text-foreground">{shortRate(elegido.writeIn, unit)}</div>
                </div>
                <div className="rounded-[3px] border border-[#005eb8]/25 bg-[#005eb8]/8 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-[0.06em] text-[#005eb8]">Read</div>
                  <div className="text-[13px] text-foreground">{shortRate(elegido.readIn, unit)}</div>
                </div>
              </div>
            ) : (
              <div className="mb-2 font-mono text-[12px] text-foreground">
                {shortRate(
                  elegido.name.includes('writes') ? elegido.writeIn : elegido.readIn,
                  unit,
                )}
              </div>
            )}
            {destinos.length > 0 ? (
              <div className="mb-2 flex flex-col gap-1 border-t border-border pt-2">
                {destinos.map((destino) => (
                  <Link key={destino.href} href={destino.href} className="link">
                    {destino.label}
                  </Link>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setElegido(null)}
              className="font-mono text-[10px] text-foreground-muted hover:text-foreground-secondary"
            >
              close
            </button>
          </div>
        )}

        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
          <span>
            Live · {snapshot?.windowMinutes ?? 5} min window · updated {edad}s ago
          </span>
          <span className="text-foreground-secondary">
            {tasa}
            {unit === 'ms' ? ' per second' : '/s'}
            {snapshot?.activeSessions !== null && snapshot?.activeSessions !== undefined
              ? ` · ${snapshot.activeSessions} active session(s)`
              : ''}
            {snapshot?.blockedSessions ? ` · ${snapshot.blockedSessions} blocked` : ''}
          </span>
          {snapshot?.referenceRate && total > 0 ? (
            <span className="normal-case tracking-normal text-foreground-muted">
              {Math.round((total / snapshot.referenceRate) * 100)}% of this instance&apos;s usual rate
            </span>
          ) : total > 0 ? (
            <span className="normal-case tracking-normal text-foreground-muted">
              {total < 0.5 ? 'very light traffic' : total < 5 ? 'light traffic' : 'active'}
            </span>
          ) : null}
        </div>

        {quieto && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-[11px] leading-relaxed text-foreground-muted">
            {fallo
              ? `Could not read activity: ${fallo}`
              : 'No attributed traffic in this window.'}
          </div>
        )}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-foreground-muted">
        <strong>WRITE</strong> (green) Application → table; <strong>READ</strong> (blue) table →
        <strong>WRITE</strong> (green) and <strong>READ</strong> (blue) rates on APP and table chips.
        Hottest stay named; browse the long tail with <strong>← Hotter / Quieter →</strong> or click{' '}
        <strong>+N more →</strong>. Crowns:{' '}
        <span className="text-[#0a6e42]">W↑</span> most written,{' '}
        <span className="text-[#005eb8]">R↑</span> most read,{' '}
        <span className="text-[#8a5a00]">HOT</span> most attacked (W+R). Group by schema to roll up
        tables.
        {demoOn ? (
          <>
            {' '}
            <span className="text-amber-800">
              Temporary demo: {DEMO_TABLE_COUNT} tables · {PAGE_SIZE}/page · 2 cols. Set
              DEMO_TABLE_COUNT=0 to restore.
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
