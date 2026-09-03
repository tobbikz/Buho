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

interface Particle {
  link: number;
  t: number;
  speed: number;
  size: number;
}

const WRITE = '#0a6e42';
const READ = '#005eb8';
const NODE_COLORS = [WRITE, READ, '#5c6b7a', '#8a5a00'];
function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const MIN_NODE_HEIGHT = 26;

/** Visible particles per unit of measured rate (rows/s, calls/s, ms/s). */
const PARTICLES_PER_RATE = 0.35;
/** Hard cap so the canvas stays readable on hot instances. */
const MAX_PARTICLES_PER_SECOND = 18;
/** Max particles on screen at once. */
const MAX_PARTICLES = 28;

const THEME = {
  bg: '#f2f4f6',
  grid: 'rgba(160, 172, 190, 0.22)',
  edge: 'rgba(0, 94, 184, 0.14)',
  edgeHot: 'rgba(0, 94, 184, 0.32)',
  particle: 'rgba(0, 94, 184, 0.82)',
  particleGlow: 'rgba(0, 94, 184, 0.12)',
  label: 'rgba(74, 82, 92, 0.92)',
  labelMuted: 'rgba(122, 130, 140, 0.55)',
  nodeIdle: '#a8b0ba',
};

interface NodePos {
  x: number;
  y: number;
  label: string;
  depth: number;
  weight: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function LiveFlow({
  scope,
  instanceId,
  weight,
  unit,
  height = 420,
  intervalMs = 5000,
}: {
  scope: 'instancia' | 'flota';
  instanceId?: number;
  weight: string;
  unit: Unit;
  height?: number;
  intervalMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const smoothLinksRef = useRef<LiveLink[]>([]);
  const referenceRef = useRef(1);
  const posicionesRef = useRef<{ x: number; y: number; label: string; depth: number; name: string }[]>([]);
  const [elegido, setElegido] = useState<{ label: string; depth: number; name: string } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [edad, setEdad] = useState(0);

  const url = useMemo(() => {
    const parametros = new URLSearchParams({
      alcance: scope,
      peso: weight,
    });
    if (instanceId !== undefined) parametros.set('instancia', String(instanceId));
    return `/api/flow-live?${parametros.toString()}`;
  }, [scope, instanceId, weight]);

  useEffect(() => {
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

    const layoutNodes = (snap: Snapshot, ancho: number, alto: number): NodePos[] => {
      const nodos: NodePos[] = [];
      const pesoDe = new Map<number, number>();
      for (const enlace of snap.links) {
        pesoDe.set(enlace.source, (pesoDe.get(enlace.source) ?? 0) + enlace.value);
        pesoDe.set(enlace.target, (pesoDe.get(enlace.target) ?? 0) + enlace.value);
      }

      const columnas = new Map<number, number[]>();
      snap.nodes.forEach((nodo, indice) => {
        const lista = columnas.get(nodo.depth) ?? [];
        lista.push(indice);
        columnas.set(nodo.depth, lista);
      });

      const profundidades = [...columnas.keys()].sort((a, b) => a - b);
      const margenIzq = 96;
      const margenDer = 190;
      const utilX = Math.max(ancho - margenIzq - margenDer, 120);

      for (const profundidad of profundidades) {
        const lista = (columnas.get(profundidad) ?? []).slice();
        lista.sort((a, b) => (pesoDe.get(b) ?? 0) - (pesoDe.get(a) ?? 0));
        const x =
          profundidades.length === 1
            ? ancho / 2
            : margenIzq + (utilX * profundidad) / (profundidades.length - 1);
        const paso = alto / (lista.length + 1);
        lista.forEach((indice, orden) => {
          const nodo = snap.nodes[indice]!;
          nodos[indice] = {
            x,
            y: paso * (orden + 1),
            label: nodo.label,
            depth: nodo.depth,
            weight: pesoDe.get(indice) ?? 0,
          };
        });
      }
      return nodos;
    };

    const dibujar = (ahora: number) => {
      const delta = Math.min((ahora - anterior) / 1000, 0.05);
      anterior = ahora;

      const snap = snapshotRef.current;
      const ancho = canvas.clientWidth;
      const alto = Math.max(canvas.clientHeight, MIN_NODE_HEIGHT);
      if (canvas.width !== Math.floor(ancho * dpr) || canvas.height !== Math.floor(alto * dpr)) {
        canvas.width = Math.floor(ancho * dpr);
        canvas.height = Math.floor(alto * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ancho, alto);

      ctx.fillStyle = THEME.bg;
      ctx.fillRect(0, 0, ancho, alto);

      if (!snap || snap.links.length === 0) {
        cuadro = requestAnimationFrame(dibujar);
        return;
      }

      const targetLinks = snap.links;
      if (smoothLinksRef.current.length !== targetLinks.length) {
        smoothLinksRef.current = targetLinks.map((enlace) => ({ ...enlace }));
      } else {
        const blend = 1 - Math.exp(-delta * 5);
        for (let i = 0; i < targetLinks.length; i += 1) {
          const suave = smoothLinksRef.current[i]!;
          const objetivo = targetLinks[i]!;
          suave.value = lerp(suave.value, objetivo.value, blend);
          suave.source = objetivo.source;
          suave.target = objetivo.target;
        }
      }

      const enlaces = smoothLinksRef.current;
      const nodos = layoutNodes({ ...snap, links: enlaces }, ancho, alto);
      posicionesRef.current = nodos
        .map((nodo, indice) =>
          nodo
            ? {
                x: nodo.x,
                y: nodo.y,
                label: nodo.label,
                depth: nodo.depth,
                name: snap.nodes[indice]?.name ?? nodo.label,
              }
            : null,
        )
        .filter(
          (nodo): nodo is { x: number; y: number; label: string; depth: number; name: string } =>
            nodo !== null,
        );

      const total = enlaces.reduce((suma, enlace) => suma + enlace.value, 0);
      const referencia = Math.max(referenceRef.current, total, 0.001);
      const actividad = Math.min(1, total / referencia);

      for (const enlace of enlaces) {
        const origen = nodos[enlace.source];
        const destino = nodos[enlace.target];
        if (!origen || !destino) continue;
        const intensidad = total > 0 ? enlace.value / total : 0;
        const alpha = 0.06 + intensidad * 0.12 + actividad * 0.1;
        const color = enlace.kind === 'write' ? WRITE : enlace.kind === 'read' ? READ : '#005eb8';
        ctx.beginPath();
        ctx.moveTo(origen.x, origen.y);
        const medio = (origen.x + destino.x) / 2;
        ctx.bezierCurveTo(medio, origen.y, medio, destino.y, destino.x, destino.y);
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 0.5 + Math.sqrt(intensidad) * 2.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Emission uses log-scale of the measured rate so 12k/s does not flood the
      // canvas. Particles hop through schema→table when a first-hop finishes,
      // otherwise they visually pile up on the schema node.
      const rawEmission = Math.min(
        MAX_PARTICLES_PER_SECOND,
        Math.log10(1 + total) * 4.2 * PARTICLES_PER_RATE + Math.min(total, 2) * 0.15,
      );

      // Prefer spawning on depth-0 links (Writes/Reads → schema). Continuations
      // cover schema → table so the stream reaches the table.
      const roots = enlaces
        .map((enlace, i) => ({ enlace, i }))
        .filter(({ enlace }) => {
          if (enlace.value <= 0) return false;
          const depth = snap.nodes[enlace.source]?.depth ?? 0;
          return depth === 0;
        });
      const rootTotal = roots.reduce((suma, item) => suma + item.enlace.value, 0) || 1;

      for (const { enlace, i } of roots) {
        const cuota = enlace.value / rootTotal;
        acumulado[i] = (acumulado[i] ?? Math.random()) + delta * rawEmission * cuota;
        while ((acumulado[i] ?? 0) >= 1 && particulas.length < MAX_PARTICLES) {
          acumulado[i] = (acumulado[i] ?? 0) - 1;
          particulas.push({
            link: i,
            t: 0,
            speed: 0.35 + Math.min(0.55, Math.log10(1 + enlace.value) * 0.12),
            size: 1.35 + Math.min(1.4, Math.sqrt(cuota) * 1.2),
          });
        }
      }

      for (let i = particulas.length - 1; i >= 0; i -= 1) {
        const particula = particulas[i]!;
        particula.t += particula.speed * delta;
        if (particula.t >= 1) {
          const enlaceHecho = enlaces[particula.link];
          if (enlaceHecho && particulas.length < MAX_PARTICLES) {
            const siguientes = enlaces
              .map((enlace, indice) => ({ enlace, indice }))
              .filter(
                ({ enlace }) =>
                  enlace.source === enlaceHecho.target &&
                  enlace.value > 0 &&
                  (enlace.kind === undefined ||
                    enlaceHecho.kind === undefined ||
                    enlace.kind === enlaceHecho.kind),
              );
            if (siguientes.length > 0) {
              const peso = siguientes.reduce((suma, item) => suma + item.enlace.value, 0);
              let pick = Math.random() * peso;
              let elegido = siguientes[0]!;
              for (const candidato of siguientes) {
                pick -= candidato.enlace.value;
                if (pick <= 0) {
                  elegido = candidato;
                  break;
                }
              }
              particulas.push({
                link: elegido.indice,
                t: 0,
                speed: particula.speed * 1.05,
                size: particula.size,
              });
            }
          }
          particulas.splice(i, 1);
          continue;
        }
        const enlace = enlaces[particula.link];
        if (!enlace) {
          particulas.splice(i, 1);
          continue;
        }
        const origen = nodos[enlace.source];
        const destino = nodos[enlace.target];
        if (!origen || !destino) {
          particulas.splice(i, 1);
          continue;
        }
        const t = particula.t;
        const medio = (origen.x + destino.x) / 2;
        const x =
          (1 - t) ** 3 * origen.x +
          3 * (1 - t) ** 2 * t * medio +
          3 * (1 - t) * t ** 2 * medio +
          t ** 3 * destino.x;
        const y =
          (1 - t) ** 3 * origen.y +
          3 * (1 - t) ** 2 * t * origen.y +
          3 * (1 - t) * t ** 2 * destino.y +
          t ** 3 * destino.y;

        const brillo = Math.sin(Math.PI * t);
        const color = enlace.kind === 'write' ? WRITE : enlace.kind === 'read' ? READ : '#005eb8';
        ctx.beginPath();
        ctx.arc(x, y, particula.size, 0, Math.PI * 2);
        ctx.fillStyle = hexAlpha(color, 0.45 + brillo * 0.4);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, particula.size * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = hexAlpha(color, 0.04 + brillo * 0.08);
        ctx.fill();
      }

      const pulso = 0.5 + 0.5 * Math.sin(ahora / (1200 - actividad * 500));
      nodos.forEach((nodo, indice) => {
        if (!nodo) return;
        const snapNode = snap.nodes[indice]?.name ?? '';
        const color =
          nodo.depth === 0
            ? snapNode.includes('writes')
              ? WRITE
              : READ
            : NODE_COLORS[Math.min(nodo.depth, NODE_COLORS.length - 1)]!;
        const activo = nodo.weight > 0;
        const radio = activo ? 3 + pulso * (0.4 + actividad * 0.9) : 2.2;

        if (activo) {
          ctx.beginPath();
          ctx.arc(nodo.x, nodo.y, radio * 3.5, 0, Math.PI * 2);
          ctx.fillStyle = `${color}14`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(nodo.x, nodo.y, radio, 0, Math.PI * 2);
        ctx.fillStyle = activo ? color : THEME.nodeIdle;
        ctx.fill();

        ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
        ctx.fillStyle = activo ? THEME.label : THEME.labelMuted;
        ctx.textBaseline = 'middle';
        const etiqueta = nodo.label.length > 26 ? `${nodo.label.slice(0, 25)}…` : nodo.label;
        if (nodo.depth === 0) {
          ctx.textAlign = 'right';
          ctx.fillText(etiqueta, nodo.x - 8, nodo.y);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(etiqueta, nodo.x + 8, nodo.y);
        }
      });

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

    let mejor: { label: string; depth: number; name: string } | null = null;
    let distancia = 26;
    for (const nodo of posicionesRef.current) {
      const d = Math.hypot(nodo.x - x, nodo.y - y);
      if (d < distancia) {
        distancia = d;
        mejor = { label: nodo.label, depth: nodo.depth, name: nodo.name };
      }
    }
    setElegido(mejor);
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
        className="relative overflow-hidden rounded-[3px] border border-border bg-[var(--surface-muted)]"
        style={{ height }}
      >
        <canvas ref={canvasRef} className="h-full w-full cursor-pointer" onClick={alPinchar} />

        {elegido && destinos.length > 0 && (
          <div className="absolute bottom-3 right-3 rounded-[3px] border border-border bg-[var(--surface)] px-3 py-2 text-[11px] shadow-sm">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
              {elegido.depth === 0 ? 'traffic' : elegido.depth === 1 ? 'schema' : 'table'}
            </div>
            <div className="mb-2 font-mono text-[12px] text-foreground">{elegido.label}</div>
            <div className="flex flex-col gap-1">
              {destinos.map((destino) => (
                <Link key={destino.href} href={destino.href} className="link">
                  {destino.label}
                </Link>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setElegido(null)}
              className="mt-2 font-mono text-[10px] text-foreground-muted hover:text-foreground-secondary"
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
              : 'Nothing moved in the last few minutes. Switch to Accumulated for history.'}
          </div>
        )}
      </div>

      <p className="mt-2 text-[11px] text-foreground-muted">
        Particle density is <strong>log-scaled</strong> to the measured rate so hot instances stay
        readable. Particles hop Writes/Reads → schema → table. Green = writes, blue = reads.
      </p>
    </div>
  );
}
