'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Sparkline } from '@/components/Sparkline';
import { formatBytes, formatNumber, formatPct } from '@/lib/format';

export interface StatementRow {
  queryid: string;
  query: string;
  username: string | null;
  calls: number;
  execMs: number;
  meanMs: number;
  rows: number;
  tempWritten: number;
  walBytes: number;
  hitPct: number | null;
  /** Tiempo de ejecución por bucket, para el sparkline de tendencia. */
  trend: number[];
  callsTrend: number[];
}

/** ms a una unidad legible: los rangos van de microsegundos a minutos. */
function duration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function firstLine(query: string): string {
  const collapsed = query.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

export function StatementsTable({
  explainable = true,
  rows,
  totalExecMs,
  instanceId,
}: {
  /**
   * Si esta consulta se puede explicar. El EXPLAIN sólo está implementado para
   * PostgreSQL: el plan de MariaDB y el de SQL Server tienen otra forma, y
   * ofrecer el botón para después decir "no se pudo" es peor que no ofrecerlo.
   */
  explainable?: boolean;
  rows: StatementRow[];
  totalExecMs: number;
  instanceId: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return <div className="empty">Sin actividad registrada en la ventana seleccionada.</div>;
  }

  return (
    <div className="table-scroll" style={{ maxHeight: 'none' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: '34%' }}>Consulta</th>
            <th>Tendencia</th>
            <th className="text-right">% del tiempo</th>
            <th className="text-right">Tiempo total</th>
            <th className="text-right">Llamadas</th>
            <th className="text-right">Media</th>
            <th className="text-right">Filas</th>
            <th className="text-right">Cache hit</th>
            <th className="text-right">Temp</th>
            <th className="text-right">WAL</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const share = totalExecMs > 0 ? (row.execMs / totalExecMs) * 100 : 0;
            const isOpen = expanded === row.queryid;
            return (
              <Fragment key={row.queryid}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : row.queryid)}
                  style={{ cursor: 'pointer', background: isOpen ? 'var(--accent-subtle)' : undefined }}
                >
                  <td className="max-w-0">
                    <div className="truncate font-mono text-[11px]">{firstLine(row.query)}</div>
                    <div className="font-mono text-[10px] text-foreground-muted">
                      {row.queryid}
                      {row.username ? ` · ${row.username}` : ''}
                    </div>
                  </td>
                  <td>
                    <Sparkline
                      values={row.trend}
                      color={share >= 40 ? '#b01818' : '#005eb8'}
                      title={`tiempo de ejecución por intervalo · ${row.trend.length} puntos`}
                    />
                  </td>
                  <td className="num">
                    <div className="flex items-center justify-end gap-1">
                      <div className="bar" style={{ minWidth: 36, width: 36 }}>
                        <div
                          className={`bar__fill ${share >= 40 ? 'bar__fill--error' : share >= 20 ? 'bar__fill--warn' : ''}`}
                          style={{ width: `${Math.min(100, Math.max(2, share))}%` }}
                        />
                      </div>
                      {formatPct(share, 0)}
                    </div>
                  </td>
                  <td className="num">{duration(row.execMs)}</td>
                  <td className="num">{formatNumber(row.calls)}</td>
                  <td className="num">{duration(row.meanMs)}</td>
                  <td className="num">{formatNumber(row.rows)}</td>
                  <td className="num">{formatPct(row.hitPct, 1)}</td>
                  <td className="num">{row.tempWritten > 0 ? formatNumber(row.tempWritten) : '·'}</td>
                  <td className="num">{row.walBytes > 0 ? formatBytes(row.walBytes) : '·'}</td>
                  {/* El enlace va en su propia columna y no dentro de la fila
                      expandible: llegar al plan cuesta un clic y no depende de
                      que la expansión funcione. stopPropagation evita que el
                      clic además despliegue la fila que se está abandonando. */}
                  <td>
                    {explainable ? (
                      <Link
                        href={`/instances/${instanceId}/queries/${row.queryid}`}
                        className="whitespace-nowrap text-[11px] text-accent hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        plan →
                      </Link>
                    ) : null}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={11} style={{ background: 'var(--surface-raised)' }}>
                      <div className="flex flex-wrap gap-4 pb-2">
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-foreground-muted">
                            Tiempo de ejecución por intervalo
                          </div>
                          <Sparkline values={row.trend} width={220} height={46} color="#005eb8" />
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-foreground-muted">
                            Llamadas por intervalo
                          </div>
                          <Sparkline values={row.callsTrend} width={220} height={46} color="#0a6e42" />
                        </div>
                      </div>
                      <div className="query-block" style={{ maxHeight: '18rem' }}>
                        {row.query}
                      </div>
                      {explainable ? (
                        <div className="pt-2">
                          <Link
                            href={`/instances/${instanceId}/queries/${row.queryid}`}
                            className="btn btn--primary"
                          >
                            Explicar el plan
                          </Link>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
