import Link from 'next/link';
import type { ReportInstance } from '@/lib/report';
import { formatBytes } from '@/lib/format';

function pct(value: number | null, digits = 0): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

function scoreTone(score: number | null): string {
  if (score === null) return '';
  if (score < 60) return 'report-score--error';
  if (score < 85) return 'report-score--warn';
  return 'report-score--ok';
}

export function ReportFleetOverview({ instances }: { instances: ReportInstance[] }) {
  if (instances.length === 0) return null;

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Fleet at a glance</span>
        <span className="text-[10.5px] text-foreground-muted">{instances.length} instances · week summary</span>
      </div>
      <div className="panel-body">
        <div className="table-scroll">
          <table className="data-table data-table--compact report-overview-table">
            <thead>
              <tr>
                <th>Instance</th>
                <th className="text-right">Health</th>
                <th className="text-right">Findings</th>
                <th className="text-right">Coverage</th>
                <th className="text-right">Growth</th>
                <th className="text-right">Locks</th>
                <th>Top wait</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((row) => {
                const growth =
                  row.sizeStartBytes !== null && row.sizeEndBytes !== null
                    ? row.sizeEndBytes - row.sizeStartBytes
                    : null;
                const scoreDelta =
                  row.scoreStart !== null && row.scoreEnd !== null ? row.scoreEnd - row.scoreStart : null;
                const topWait = row.waitProfile?.[0];

                return (
                  <tr key={row.instanceId}>
                    <td>
                      <Link href={`/instances/${row.instanceId}`} className="report-overview-link">
                        {row.alias}
                      </Link>
                      <div className="report-overview-sub">
                        {row.environment} · {row.engine}
                      </div>
                    </td>
                    <td className="num">
                      {row.scoreEnd !== null ? (
                        <span className={`report-score ${scoreTone(row.scoreEnd)}`}>{row.scoreEnd}</span>
                      ) : (
                        '—'
                      )}
                      {scoreDelta !== null && scoreDelta !== 0 ? (
                        <span className={`report-overview-delta ${scoreDelta >= 0 ? 'is-up' : 'is-down'}`}>
                          {scoreDelta >= 0 ? '+' : '−'}
                          {Math.abs(scoreDelta)}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">
                      <span className="report-findings-inline">
                        {row.critical > 0 ? <span className="tag tag--error">{row.critical} crit</span> : null}
                        {row.warning > 0 ? <span className="tag tag--warn">{row.warning} warn</span> : null}
                        {row.critical === 0 && row.warning === 0 ? (
                          <span className="text-foreground-muted">clean</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="num font-mono">{pct(row.coveragePct, 0)}</td>
                    <td className="num font-mono">
                      {growth === null ? (
                        '—'
                      ) : (
                        <span className={growth > 0 ? 'report-delta--bad' : growth < 0 ? 'report-delta--good' : ''}>
                          {growth >= 0 ? '+' : '−'}
                          {formatBytes(Math.abs(growth))}
                        </span>
                      )}
                    </td>
                    <td className="num font-mono">{row.lockEpisodes > 0 ? row.lockEpisodes : '—'}</td>
                    <td>
                      {topWait ? (
                        <span
                          className={`tag ${
                            topWait.waitType === 'Lock'
                              ? 'tag--error'
                              : topWait.waitType === 'IO'
                                ? 'tag--warn'
                                : 'tag--muted'
                          }`}
                        >
                          {topWait.waitType} {(topWait.share * 100).toFixed(0)}%
                        </span>
                      ) : (
                        <span className="text-foreground-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
