'use client';

import {
  Area,
  CartesianGrid,
  Legend,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartPoint } from '@/lib/queries';
import { formatBytes, formatNumber, formatPct } from '@/lib/format';

export type Unit = 'count' | 'bytes' | 'pct' | 'rate' | 'seconds';

export interface SeriesSpec {
  metric: string;
  label: string;
  color: string;
  /** Línea punteada: la serie "de antes" en comparación de dos momentos. */
  dashed?: boolean;
}

// Las funciones no cruzan la frontera servidor→cliente, así que el formato se
// elige por nombre de unidad en vez de pasar un formatter.
function formatValue(value: number | null, unit: Unit): string {
  if (value === null || Number.isNaN(value)) return '—';
  switch (unit) {
    case 'bytes':
      return formatBytes(value);
    case 'pct':
      return formatPct(value, 1);
    case 'rate':
      return `${formatNumber(value, value < 10 ? 2 : 0)}/s`;
    case 'seconds':
      return `${formatNumber(value, value < 10 ? 2 : 0)}s`;
    default: {
      // Los valores chicos (DB time, sesiones bloqueadas) se vuelven una
      // columna de "0.0" si se redondea a un decimal fijo.
      const magnitude = Math.abs(value);
      if (magnitude > 0 && magnitude < 1) return String(Number(value.toPrecision(2)));
      const digits = Number.isInteger(value) ? 0 : magnitude >= 10 ? 0 : 1;
      return formatNumber(value, digits);
    }
  }
}

/**
 * En ventanas de varios días la hora sola es ambigua: el eje repetía "22:00"
 * tres veces sin decir de qué día. A partir de 24 h de span se agrega la fecha.
 */
function timeFormatter(spanMs: number): (bucket: number) => string {
  const multiDay = spanMs > 24 * 3_600_000;
  return (bucket: number) => {
    const date = new Date(bucket);
    const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (!multiDay) return time;
    return `${date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${time}`;
  };
}

export function TimeseriesPanel({
  title,
  data,
  series,
  unit = 'count',
  height = 170,
  hint,
  band,
}: {
  title: string;
  data: ChartPoint[];
  series: SeriesSpec[];
  unit?: Unit;
  height?: number;
  hint?: string;
  /**
   * Banda de lo normal para esa hora. `key` apunta a un par `[p10, p90]` en cada
   * punto y `medianKey` a la mediana. Se dibuja detrás de las líneas: es
   * referencia, no un dato más.
   */
  band?: { key: string; medianKey?: string; label?: string };
}) {
  // La banda sola no cuenta como dato: un panel con banda y sin muestras sigue
  // estando vacío, y decirlo es más útil que dibujar una franja sin línea.
  const hasData = data.some((point) => series.some((spec) => point[spec.metric] !== null));
  const span =
    data.length > 1 ? (data[data.length - 1]?.bucket ?? 0) - (data[0]?.bucket ?? 0) : 0;
  const formatTime = timeFormatter(span);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {hint && <span className="font-mono text-[10px] text-foreground-muted">{hint}</span>}
      </div>
      {!hasData ? (
        <div className="empty" style={{ height }}>
          Sin muestras en la ventana seleccionada.
        </div>
      ) : (
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          <ResponsiveContainer width="100%" height={height}>
            <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e2e6ea" strokeDasharray="2 3" vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={formatTime}
                tick={{ fontSize: 10, fill: '#7a828c', fontFamily: 'var(--font-jetbrains)' }}
                stroke="#cdd3da"
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(value: number) => formatValue(value, unit)}
                tick={{ fontSize: 10, fill: '#7a828c', fontFamily: 'var(--font-jetbrains)' }}
                stroke="#cdd3da"
                width={58}
              />
              <Tooltip
                labelFormatter={(value) => formatTime(Number(value))}
                formatter={(value) => formatValue(Number(value), unit)}
                contentStyle={{
                  borderRadius: 0,
                  border: '1px solid #a8b0ba',
                  fontSize: 11,
                  fontFamily: 'var(--font-jetbrains)',
                  padding: '4px 8px',
                }}
                itemStyle={{ padding: 0 }}
              />
              {(series.length > 1 || band) && (
                <Legend
                  verticalAlign="bottom"
                  height={22}
                  iconType="plainline"
                  iconSize={10}
                  wrapperStyle={{ fontSize: 11, color: '#4a525c' }}
                />
              )}
              {band && (
                <Area
                  type="monotone"
                  name={band.label ?? 'Normal para esta hora'}
                  dataKey={band.key}
                  stroke="none"
                  fill="#1f5f8b"
                  fillOpacity={0.1}
                  connectNulls
                  isAnimationActive={false}
                  legendType="rect"
                />
              )}
              {band?.medianKey && (
                <Line
                  type="monotone"
                  name="Mediana histórica"
                  dataKey={band.medianKey}
                  stroke="#7a828c"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}
              {series.map((spec) => (
                <Line
                  key={spec.metric}
                  type="monotone"
                  name={spec.label}
                  dataKey={spec.metric}
                  stroke={spec.color}
                  strokeWidth={spec.dashed ? 1.25 : 1.5}
                  strokeDasharray={spec.dashed ? '4 3' : undefined}
                  strokeOpacity={spec.dashed ? 0.85 : 1}
                  dot={false}
                  activeDot={{ r: 2.5 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
