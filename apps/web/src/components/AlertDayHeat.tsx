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
      <div className="panel-body empty">
        No alert fires in this window — heatmap fills as deliveries accumulate.
      </div>
    );
  }

  const lookup = new Map(data.cells.map((c) => [`${c.checkId}|${c.day}`, c.count]));

  return (
    <div className="overflow-x-auto">
      <table className="border-separate" style={{ borderSpacing: '2px' }}>
        <thead>
          <tr>
            <th className="pr-2 text-left font-mono text-[10px] font-normal text-foreground-muted">
              check
            </th>
            {data.days.map((day) => (
              <th
                key={day}
                className="font-mono text-[9px] font-normal text-foreground-muted"
                style={{ width: 22 }}
                title={day}
              >
                {day.slice(8)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.checks.map((checkId) => (
            <tr key={checkId}>
              <td
                className="max-w-[14rem] truncate pr-2 text-right font-mono text-[10px] text-foreground-muted"
                title={checkId}
              >
                {checkId}
              </td>
              {data.days.map((day) => {
                const count = lookup.get(`${checkId}|${day}`) ?? 0;
                return (
                  <td key={day}>
                    <div
                      title={`${checkId} · ${day} · ${count} fire(s)`}
                      style={{
                        width: 18,
                        height: 14,
                        borderRadius: 2,
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
      <p className="mt-2 font-mono text-[10px] text-foreground-muted">
        {data.totalFires} fire event(s) · top {data.checks.length} checks · day columns = last{' '}
        {data.days.length}d
      </p>
    </div>
  );
}
