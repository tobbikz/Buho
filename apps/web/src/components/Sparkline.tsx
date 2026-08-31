/**
 * SVG a mano, sin librería de charts: en la tabla de consultas se dibujan 25 de
 * estos a la vez y montar 25 contenedores de Recharts para 90×22 px cuesta más
 * que el dato que muestran.
 *
 * La escala arranca siempre en cero. Un sparkline con eje flotante convierte
 * ruido del 2 % en una montaña, y la comparación entre filas deja de servir.
 */
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

  const points = clean.map((value, index) => `${(pad + index * step).toFixed(1)},${y(value).toFixed(1)}`);
  const area = `${pad},${height - pad} ${points.join(' ')} ${(pad + (clean.length - 1) * step).toFixed(1)},${height - pad}`;

  return (
    <svg width={width} height={height} role="img" aria-label={title ?? 'tendencia'} style={{ display: 'block' }}>
      {title ? <title>{title}</title> : null}
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={1.25} />
      <circle cx={pad + (clean.length - 1) * step} cy={y(clean[clean.length - 1] ?? 0)} r={1.6} fill={color} />
    </svg>
  );
}
