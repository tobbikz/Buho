'use client';

import { Fragment, useMemo, useRef, useState } from 'react';
import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from 'recharts';
import type { FlowLink, FlowNode } from '@/lib/flow';
import { formatUnit, type Unit } from '@/lib/units';

const WRITE = '#0a6e42';
const READ = '#005eb8';
const SCHEMA = '#5c6b7a';
const TABLE = '#8a5a00';

const COLUMN_LABELS = ['Traffic', 'Schema', 'Table'];

interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

function linkColor(kind: FlowLink['kind']): string {
  if (kind === 'write') return WRITE;
  if (kind === 'read') return READ;
  return '#7a8a9a';
}

function nodeColor(depth: number, name: string): string {
  if (depth === 0) return name.includes('writes') ? WRITE : READ;
  if (depth === 1) return SCHEMA;
  return TABLE;
}

function SankeyLink(props: {
  sourceX?: number;
  targetX?: number;
  sourceY?: number;
  targetY?: number;
  sourceControlX?: number;
  targetControlX?: number;
  linkWidth?: number;
  index?: number;
  payload?: FlowLink & { source?: number; target?: number };
  links?: (FlowLink & { source?: number; target?: number })[];
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
    links,
    index = 0,
  } = props;

  const kind = payload?.kind ?? links?.[index]?.kind;
  const color = linkColor(kind);
  const opacity = kind === 'write' ? 0.28 : kind === 'read' ? 0.22 : 0.18;

  return (
    <path
      d={`
        M${sourceX},${sourceY}
        C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}
      `}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(linkWidth, 1)}
      strokeOpacity={opacity}
    />
  );
}

function NodeShape({
  x,
  y,
  width,
  height,
  index,
  payload,
  onHover,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  payload?: FlowNode & { value?: number; name?: string };
  onHover?: (index: number | null) => void;
}) {
  const depth = payload?.depth ?? 0;
  const name = payload?.name ?? '';
  const color = nodeColor(depth, name);
  const alto = height ?? 0;
  const ancho = width ?? 0;
  const izquierda = x ?? 0;
  const arriba = y ?? 0;
  const alDerecha = depth < 2;

  return (
    <Layer
      onMouseEnter={() => onHover?.(index ?? null)}
      onMouseLeave={() => onHover?.(null)}
      style={{ cursor: 'default' }}
    >
      <Rectangle
        x={izquierda}
        y={arriba}
        width={ancho}
        height={alto}
        fill={color}
        fillOpacity={0.9}
        radius={[2, 2, 2, 2]}
      />
      {alto >= 8 && (
        <text
          x={alDerecha ? izquierda + ancho + 8 : izquierda - 8}
          y={arriba + alto / 2}
          textAnchor={alDerecha ? 'start' : 'end'}
          dominantBaseline="middle"
          fontSize={11}
          fontWeight={depth === 0 ? 600 : 400}
          fill="var(--foreground-secondary, #4a525c)"
        >
          {payload?.label ?? ''}
        </text>
      )}
    </Layer>
  );
}

export function FlowSankey({
  nodes,
  links,
  unit,
  height = 420,
  emptyMessage,
  zoomable = true,
  columnLabels,
}: {
  nodes: FlowNode[];
  links: FlowLink[];
  unit: Unit;
  height?: number;
  emptyMessage: string;
  zoomable?: boolean;
  /** Override the default Traffic / Schema / Table column headers. */
  columnLabels?: string[];
}) {
  const [resaltado, setResaltado] = useState<number | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const [panning, setPanning] = useState(false);
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);

  const maxDepth = useMemo(() => Math.max(0, ...nodes.map((n) => n.depth)), [nodes]);
  const headers = columnLabels ?? COLUMN_LABELS;

  const data = useMemo(
    () => ({
      nodes: nodes.map((nodo) => ({ ...nodo })),
      links: links.map((enlace) => ({ ...enlace })),
    }),
    [nodes, links],
  );

  const resetView = () => setViewport({ scale: 1, tx: 0, ty: 0 });

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!zoomable) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setViewport((v) => {
      const nextScale = Math.min(3, Math.max(0.5, v.scale * factor));
      const wx = (sx - v.tx) / v.scale;
      const wy = (sy - v.ty) / v.scale;
      return {
        scale: nextScale,
        tx: sx - wx * nextScale,
        ty: sy - wy * nextScale,
      };
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!zoomable || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
    dragRef.current = { ox: e.clientX - viewport.tx, oy: e.clientY - viewport.ty };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setViewport((v) => ({
      ...v,
      tx: e.clientX - dragRef.current!.ox,
      ty: e.clientY - dragRef.current!.oy,
    }));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setPanning(false);
    dragRef.current = null;
  };

  if (nodes.length === 0 || links.length === 0) {
    return <div className="empty">{emptyMessage}</div>;
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4 px-1">
        <div className="flex gap-4 text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
          {headers.slice(0, maxDepth + 1).map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-foreground-muted">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-[1px]" style={{ background: WRITE, opacity: 0.7 }} />
            Writes
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-[1px]" style={{ background: READ, opacity: 0.7 }} />
            Reads
          </span>
          {zoomable ? <span className="text-border">|</span> : null}
          {zoomable ? <span>Scroll · zoom · drag · pan</span> : null}
        </div>
      </div>

      <div
        className="relative overflow-hidden rounded-[3px] border border-border bg-[var(--surface-muted)] touch-none"
        style={{ width: '100%', height, cursor: panning ? 'grabbing' : zoomable ? 'grab' : 'default' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {zoomable ? (
          <button
            type="button"
            onClick={resetView}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute right-2 top-2 z-10 rounded-[3px] border border-border bg-[var(--surface)] px-2 py-1 font-mono text-[10px] text-foreground-secondary hover:text-foreground"
          >
            Reset view
          </button>
        ) : null}

        <div
          style={{
            width: '100%',
            height: '100%',
            transform: zoomable
              ? `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.scale})`
              : undefined,
            transformOrigin: '0 0',
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <Sankey
              data={data}
              nodePadding={18}
              nodeWidth={12}
              margin={{ top: 12, right: 140, bottom: 12, left: 12 }}
              link={<SankeyLink links={data.links} />}
              node={<NodeShape onHover={setResaltado} />}
            >
              <Tooltip
                contentStyle={{
                  background: 'var(--surface-raised, #fff)',
                  border: '1px solid var(--border, #d1d5db)',
                  borderRadius: 2,
                  fontSize: 11,
                }}
                formatter={(value) => formatUnit(Number(value ?? 0), unit)}
                labelFormatter={() => ''}
              />
            </Sankey>
          </ResponsiveContainer>
        </div>
      </div>

      {resaltado !== null && nodes[resaltado] && (
        <div className="mt-1 font-mono text-[10px] text-foreground-muted">
          {nodes[resaltado].name.replace(/^(traffic|schema|table):/, '')}
        </div>
      )}
    </div>
  );
}

export function OperationBars({
  rows,
  unit,
}: {
  rows: { relation: string; byOperation: Record<string, number | undefined>; total: number }[];
  unit: Unit;
}) {
  const COLORES: Record<string, string> = {
    insert: '#0a6e42',
    update: '#005eb8',
    delete: '#b40000',
    copy: '#8a5a00',
    truncate: '#6b21a8',
    select: '#4b5563',
  };
  const ORDEN = ['insert', 'copy', 'update', 'delete', 'truncate', 'select'];
  const maximo = Math.max(...rows.map((fila) => fila.total), 1);

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((fila) => (
        <div key={fila.relation}>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[11px]">{fila.relation}</span>
            <span className="font-mono text-[10.5px] text-foreground-muted">{formatUnit(fila.total, unit)}</span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-[1px] bg-[var(--surface-sunken,#f3f4f6)]">
            {ORDEN.map((operacion) => {
              const valor = fila.byOperation[operacion] ?? 0;
              if (valor <= 0) return null;
              return (
                <div
                  key={operacion}
                  title={`${operacion}: ${formatUnit(valor, unit)}`}
                  style={{
                    width: `${(valor / maximo) * 100}%`,
                    background: COLORES[operacion] ?? '#9ca3af',
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-foreground-muted">
        {ORDEN.map((operacion) => (
          <Fragment key={operacion}>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[1px]"
                style={{ background: COLORES[operacion] }}
              />
              {operacion}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
