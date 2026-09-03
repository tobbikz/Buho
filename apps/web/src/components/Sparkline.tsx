/**
 * SVG a mano, sin librería de charts: en la tabla de consultas se dibujan 25 de
 * estos a la vez y montar 25 contenedores de Recharts para 90×22 px cuesta más
 * que el dato que muestran.
 *
 * La escala arranca siempre en cero. Un sparkline con eje flotante convierte
 * ruido del 2 % en una montaña, y la comparación entre filas deja de servir.
 *
 * La línea usa curvas cúbicas (Catmull-Rom → Bezier) para que la tendencia se
 * lea suave: con polyline cada bucket se ve como un pico dentado.
 */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)} L ${points[1]!.x.toFixed(1)} ${points[1]!.y.toFixed(1)}`;
  }

  let d = `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

export function Sparkline({
  values,
  width = 92,
  height = 22,
  color = '#005eb8',
  title,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  title?: string;
}) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) {
    return <span className="font-mono text-[10px] text-foreground-muted">·</span>;
  }

  const max = Math.max(...clean);
  const pad = 1.5;
  const usableHeight = height - pad * 2;
  const step = clean.length > 1 ? (width - pad * 2) / (clean.length - 1) : 0;

  const y = (value: number) => (max <= 0 ? height - pad : height - pad - (value / max) * usableHeight);

  const points = clean.map((value, index) => ({
    x: pad + index * step,
    y: y(value),
  }));
  const line = smoothPath(points);
  const last = points[points.length - 1]!;
  const area = `${line} L ${last.x.toFixed(1)} ${(height - pad).toFixed(1)} L ${pad.toFixed(1)} ${(height - pad).toFixed(1)} Z`;

  return (
    <svg width={width} height={height} role="img" aria-label={title ?? 'tendencia'} style={{ display: 'block' }}>
      {title ? <title>{title}</title> : null}
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y} r={1.6} fill={color} />
    </svg>
  );
}
