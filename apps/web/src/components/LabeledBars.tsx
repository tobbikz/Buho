export interface BarRow {
  label: string;
  sub?: string;
  value: number;
  display: string;
  tone?: 'accent' | 'warn' | 'error';
}

/**
 * Lista con barra proporcional al max de la propia lista. Es la forma más
 * densa de mostrar un top-N (tablas grandes, wait events) sin gastar un chart.
 */
export function LabeledBars({
  title,
  rows,
  emptyMessage,
  footer,
}: {
  title: string;
  rows: BarRow[];
  emptyMessage: string;
  footer?: string;
}) {
  const max = rows.reduce((peak, row) => Math.max(peak, row.value), 0);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {footer && <span className="font-mono text-[10px] text-foreground-muted">{footer}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="empty">{emptyMessage}</div>
      ) : (
        <table className="data-table data-table--bars">
          <colgroup>
            <col style={{ width: '48%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.label}-${row.sub ?? ''}`}>
                <td>
                  <div className="truncate font-mono text-[11.5px]" title={row.label}>
                    {row.label}
                  </div>
                  {row.sub && <div className="truncate text-[10.5px] text-foreground-muted">{row.sub}</div>}
                </td>
                <td>
                  <div className="bar">
                    <div
                      className={`bar__fill ${row.tone && row.tone !== 'accent' ? `bar__fill--${row.tone}` : ''}`}
                      style={{ width: `${max > 0 ? Math.max(2, (row.value / max) * 100) : 0}%` }}
                    />
                  </div>
                </td>
                <td className="num">{row.display}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
