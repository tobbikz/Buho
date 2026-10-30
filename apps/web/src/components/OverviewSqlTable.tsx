export function OverviewSqlTable({
  title,
  columns,
  rows,
}: {
  title: string;
  columns: string[];
  rows: Record<string, string | number | null>[];
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          {rows.length} row{rows.length === 1 ? '' : 's'} · custom SQL
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="panel-body empty">No rows.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((col) => (
                    <td key={col} className="font-mono text-[11px]">
                      {row[col] === null || row[col] === undefined ? '—' : String(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
