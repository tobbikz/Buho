'use client';

/**
 * Barras apiladas de sessions por tipo de espera.
 *
 * El eje vertical son **sessions at once**, no esperas sumadas: sumar crecería
 * solo al agrandar el cubo de tiempo y el gráfico mentiría sobre la carga. Con
 * sessions promedio, la altura se puede comparar contra el número de cores del
 * servidor, que es la lectura que importa.
 *
 * Es SVG y no canvas porque son unos cientos de rectángulos estáticos: aquí el
 * DOM no molesta y a cambio se puede pasar el ratón por encima.
 */

export interface StackBucket {
  bucket: string;
  byType: Record<string, number>;
  total: number;
}

// Los colores llevan significado: lo que es trabajo (CPU) en verde, lo que es
// espera evitable (bloqueos) en rojo, el disco en ámbar. Un DBA que ve rojo
// creciendo sabe que hay que mirar transactions, no comprar discos.
const COLOR: Record<string, string> = {
  CPU: '#3ecf8e',
  Lock: '#e5484d',
  LWLock: '#d6409f',
  IO: '#e0b341',
  Client: '#6e7887',
  IPC: '#5b9cf8',
  Timeout: '#8e6ee0',
  BufferPin: '#e08c41',
  Activity: '#3c4451',
  Extension: '#41a2e0',
};

const ORDEN = ['CPU', 'IO', 'Lock', 'LWLock', 'IPC', 'BufferPin', 'Timeout', 'Client', 'Extension', 'Activity'];

function tickLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WaitStack({
  buckets,
  height = 190,
  emptyMessage,
}: {
  buckets: StackBucket[];
  height?: number;
  emptyMessage: string;
}) {
  if (buckets.length === 0) {
    return <div className="empty">{emptyMessage}</div>;
  }

  const maximo = Math.max(...buckets.map((cubo) => cubo.total), 1);
  const tipos = ORDEN.filter((tipo) => buckets.some((cubo) => (cubo.byType[tipo] ?? 0) > 0));
  const otros = [
    ...new Set(buckets.flatMap((cubo) => Object.keys(cubo.byType))),
  ].filter((tipo) => !ORDEN.includes(tipo));
  const columnas = [...tipos, ...otros];

  const ancho = 1000;
  const anchoBarra = ancho / buckets.length;

  const leyenda = (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-foreground-muted">
      {columnas.map((tipo) => (
        <span key={tipo} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-[8px] w-[8px] rounded-[1px]"
            style={{ background: COLOR[tipo] ?? '#7a869a' }}
          />
          <span className="font-mono">{tipo}</span>
        </span>
      ))}
      <span className="ml-auto font-mono">peak {maximo.toFixed(1)} session(s) at once</span>
    </div>
  );

  return (
    <div>
      <div className="mb-2">{leyenda}</div>
      <svg viewBox={`0 0 ${ancho} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        {buckets.map((cubo, indice) => {
          let y = height;
          return (
            <g key={cubo.bucket}>
              {columnas.map((tipo) => {
                const valor = cubo.byType[tipo] ?? 0;
                if (valor <= 0) return null;
                const alto = (valor / maximo) * (height - 4);
                y -= alto;
                return (
                  <rect
                    key={tipo}
                    x={indice * anchoBarra}
                    y={y}
                    width={Math.max(anchoBarra - 1, 0.6)}
                    height={alto}
                    fill={COLOR[tipo] ?? '#7a869a'}
                    opacity={0.88}
                  >
                    <title>{`${new Date(cubo.bucket).toLocaleString('en')}\n${tipo}: ${valor.toFixed(2)} session(s)`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>

      <div className="mt-1 flex justify-between gap-2 font-mono text-[10px] text-foreground-muted">
        {[0, 0.25, 0.5, 0.75, 1]
          .map((share) => Math.min(buckets.length - 1, Math.round(share * (buckets.length - 1))))
          .filter((index, position, all) => all.indexOf(index) === position)
          .map((index) => (
            <span key={index}>{tickLabel(buckets[index]!.bucket)}</span>
          ))}
      </div>
    </div>
  );
}
