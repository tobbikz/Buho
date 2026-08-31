'use client';

import { Fragment, useMemo, useState } from 'react';
import { Sankey, Tooltip, ResponsiveContainer, Layer, Rectangle } from 'recharts';
import type { FlowLink, FlowNode } from '@/lib/flow';
import { formatUnit, type Unit } from '@/lib/units';

/**
 * Diagrama de flujo del tráfico: rol → esquema → tabla.
 *
 * Se eligió un Sankey y no un grafo de fuerza porque la pregunta tiene una
 * dirección: el tráfico *sale* de un rol y *llega* a una tabla. Un grafo que se
 * acomoda solo queda bonito y obliga a rastrear con el dedo qué es grueso; aquí
 * el grosor de la cinta es la única variable y se lee de izquierda a derecha.
 *
 * El color distingue las tres columnas, no la magnitud: la magnitud ya está en
 * el grosor, y pintarla otra vez con color haría creer que son dos datos.
 */

const COLOR = {
  rol: '#005eb8',
  esquema: '#0a6e42',
  tabla: '#8a5a00',
} as const;

const COLUMN_COLOR = [COLOR.rol, COLOR.esquema, COLOR.tabla];

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
  payload?: FlowNode & { value?: number };
  onHover?: (index: number | null) => void;
}) {
  const depth = payload?.depth ?? 0;
  const color = COLUMN_COLOR[depth] ?? COLOR.rol;
  const alto = height ?? 0;
  const ancho = width ?? 0;
  const izquierda = x ?? 0;
  const arriba = y ?? 0;

  // La etiqueta va fuera del bloque, del lado que no tapa nada: a la derecha en
  // las dos primeras columnas y a la izquierda en la última.
  const alDerecha = depth < 2;

  return (
    <Layer
      onMouseEnter={() => onHover?.(index ?? null)}
      onMouseLeave={() => onHover?.(null)}
      style={{ cursor: 'default' }}
    >
      <Rectangle x={izquierda} y={arriba} width={ancho} height={alto} fill={color} fillOpacity={0.85} />
      {alto >= 9 && (
        <text
          x={alDerecha ? izquierda + ancho + 6 : izquierda - 6}
          y={arriba + alto / 2}
          textAnchor={alDerecha ? 'start' : 'end'}
          dominantBaseline="middle"
          fontSize={10.5}
          fill="var(--foreground-muted, #6b7280)"
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
}: {
  nodes: FlowNode[];
  links: FlowLink[];
  /**
   * Unidad del peso, no un formateador: las funciones no cruzan de un
   * componente de servidor a uno de cliente.
   */
  unit: Unit;
  height?: number;
  emptyMessage: string;
}) {
  const [resaltado, setResaltado] = useState<number | null>(null);

  // Recharts muta el objeto que recibe, así que se le pasa una copia: sin esto,
  // un re-render con los mismos datos produce posiciones acumuladas.
  const data = useMemo(
    () => ({
      nodes: nodes.map((nodo) => ({ ...nodo })),
      links: links.map((enlace) => ({ ...enlace })),
    }),
    [nodes, links],
  );

  if (nodes.length === 0 || links.length === 0) {
    return <div className="empty">{emptyMessage}</div>;
  }

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={data}
          nodePadding={14}
          nodeWidth={10}
          margin={{ top: 8, right: 130, bottom: 8, left: 8 }}
          link={{ stroke: '#005eb8', strokeOpacity: 0.18 }}
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
      {resaltado !== null && nodes[resaltado] && (
        <div className="mt-1 font-mono text-[10px] text-foreground-muted">
          {nodes[resaltado].name.replace(/^(rol|esquema|tabla):/, '')}
        </div>
      )}
    </div>
  );
}

/**
 * Barras de una tabla, desglosadas por operación.
 *
 * Complementa el Sankey en lo que el Sankey no puede: ahí una tabla es una
 * cinta y no se ve si el tráfico es de inserts o de deletes, que para decidir
 * qué hacer es la diferencia entre "crece" y "se recicla".
 */
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
