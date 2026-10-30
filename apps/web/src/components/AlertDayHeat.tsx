'use client';

import type { AlertDayHeatmap } from '@/lib/alerts';

const SCALE = ['#eaf2fb', '#c3daf2', '#8ab8e4', '#4a8ccf', '#b01818'];

function colorFor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return 'transparent';
  const t = Math.sqrt(Math.min(value / max, 1));
  const i = Math.min(SCALE.length - 1, Math.floor(t * SCALE.length));
  return SCALE[i] ?? SCALE[0]!;
}

export function AlertDayHeat({ data }: { data: AlertDayHeatmap }) {
  if (data.checks.length === 0) {
    return (
      <div className="empty">
        No alert fires in this window — heatmap fills as deliveries accumulate.
      </div>
    );
  }

  const lookup = new Map(data.cells.map((c) => [`${c.checkId}|${c.day}`, c.count]));

  return (
    <div className="alert-heat">
      <table className="alert-heat__table">
        <thead>
          <tr>
            <th className="alert-heat__label">check</th>
            {data.days.map((day) => (
              <th key={day} className="alert-heat__day" title={day}>
                {day.slice(8)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.checks.map((checkId) => (
            <tr key={checkId}>
              <td className="alert-heat__label" title={checkId}>
                {checkId}
              </td>
              {data.days.map((day) => {
                const count = lookup.get(`${checkId}|${day}`) ?? 0;
                return (
                  <td key={day} className="alert-heat__cell">
                    <div
                      className="alert-heat__swatch"
                      title={`${checkId} · ${day} · ${count} fire(s)`}
                      style={{
                        background: colorFor(count, data.max),
                        border: count === 0 ? '1px solid var(--border)' : undefined,
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="alert-heat__footer">
        {data.totalFires} fire event(s) · top {data.checks.length} checks · day columns = last{' '}
        {data.days.length}d
      </p>
    </div>
  );
}
