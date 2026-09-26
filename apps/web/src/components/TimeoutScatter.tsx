'use client';

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { TimeoutEvent, TimeoutLane } from '@/lib/logs';

const LANES: { id: TimeoutLane; y: number; label: string; color: string }[] = [
  { id: 'idle', y: 1, label: 'Idle', color: '#9a4a00' },
  { id: 'lock', y: 2, label: 'Lock', color: '#b01818' },
  { id: 'statement', y: 3, label: 'Statement', color: '#005eb8' },
];

function formatTime(bucket: number, spanMs: number): string {
  const date = new Date(bucket);
  const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (spanMs <= 24 * 3_600_000) return time;
  return `${date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${time}`;
}

export function TimeoutScatter({
  points,
  height = 240,
}: {
  points: TimeoutEvent[];
  height?: number;
}) {
  const span = points.length > 1 ? points[points.length - 1]!.at - points[0]!.at : 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Timeouts</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          each point is one cancel from the server log
        </span>
      </div>
      {points.length === 0 ? (
        <div className="empty" style={{ height }}>
          No statement, lock, or idle timeouts in this window. They come from the PostgreSQL log
          (statement_timeout, lock_timeout, idle_in_transaction_session_timeout).
        </div>
      ) : (
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          <ResponsiveContainer width="100%" height={height}>
            <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#e2e6ea" strokeDasharray="2 3" vertical={false} />
              <XAxis
                type="number"
                dataKey="x"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(value: number) => formatTime(value, span)}
                tick={{ fontSize: 10, fill: '#7a828c', fontFamily: 'var(--font-jetbrains)' }}
                stroke="#cdd3da"
                minTickGap={40}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={[0.5, 3.5]}
                ticks={[1, 2, 3]}
                tickFormatter={(value: number) => LANES.find((lane) => lane.y === value)?.label ?? ''}
                tick={{ fontSize: 10, fill: '#7a828c' }}
                stroke="#cdd3da"
                width={72}
              />
              <ZAxis range={[64, 64]} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ payload }) => {
                  const row = payload?.[0]?.payload as
                    | { x: number; message: string; database: string | null; lane: string }
                    | undefined;
                  if (!row) return null;
                  return (
                    <div
                      style={{
                        border: '1px solid #a8b0ba',
                        background: '#fff',
                        fontSize: 11,
                        fontFamily: 'var(--font-jetbrains)',
                        padding: '4px 8px',
                        maxWidth: 360,
                      }}
                    >
                      <div>
                        {formatTime(row.x, span)} · {row.lane}
                        {row.database ? ` · ${row.database}` : ''}
                      </div>
                      <div style={{ marginTop: 2, color: '#4a525c' }}>{row.message}</div>
                    </div>
                  );
                }}
              />
              {LANES.map((lane) => (
                <Scatter
                  key={lane.id}
                  name={lane.label}
                  data={points
                    .filter((point) => point.lane === lane.id)
                    .map((point) => ({
                      x: point.at,
                      y: lane.y,
                      message: point.message,
                      database: point.database,
                      lane: lane.label,
                    }))}
                  fill={lane.color}
                  isAnimationActive={false}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
