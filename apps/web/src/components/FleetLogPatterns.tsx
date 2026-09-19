import Link from 'next/link';
import { formatAgo } from '@/lib/format';
import { ENGINE_LABEL } from '@/lib/estate';
import {
  KIND_LABEL,
  type FleetLogLevelCount,
  type FleetLogPattern,
  type LogKind,
} from '@/lib/logs';

function levelTone(level: string): string {
  const l = level.toLowerCase();
  if (l === 'fatal' || l === 'panic' || l === 'critical' || l === 'error') return 'tag--error';
  if (l === 'warning' || l === 'warn') return 'tag--warn';
  return 'tag--muted';
}

export function FleetLogPatterns({
  patterns,
  levelCounts,
  hours,
}: {
  patterns: FleetLogPattern[];
  levelCounts: FleetLogLevelCount[];
  hours: number;
}) {
  const byInstance = new Map<
    number,
    { alias: string; engine: string; fatal: number; error: number; warning: number }
  >();
  for (const row of levelCounts) {
    let entry = byInstance.get(row.instanceId);
    if (!entry) {
      entry = { alias: row.alias, engine: row.engine, fatal: 0, error: 0, warning: 0 };
      byInstance.set(row.instanceId, entry);
    }
    const l = row.level;
    if (l === 'fatal' || l === 'panic' || l === 'critical') entry.fatal += row.times;
    else if (l === 'error') entry.error += row.times;
    else if (l === 'warning' || l === 'warn') entry.warning += row.times;
  }

  const heatRows = [...byInstance.entries()].sort(
    (a, b) => b[1].fatal + b[1].error - (a[1].fatal + a[1].error),
  );

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Fleet log levels · last {hours}h</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            fatal / error / warning from engine logs
          </span>
        </div>
        {heatRows.length === 0 ? (
          <div className="panel-body empty">No CRITICAL/ERROR/WARNING log events in this window.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Engine</th>
                  <th className="text-right">Fatal/Critical</th>
                  <th className="text-right">Error</th>
                  <th className="text-right">Warning</th>
                </tr>
              </thead>
              <tbody>
                {heatRows.map(([id, row]) => (
                  <tr key={id}>
                    <td>
                      <Link href={`/instances/${id}/logs`} className="underline decoration-dotted">
                        {row.alias}
                      </Link>
                    </td>
                    <td className="text-[11px] text-foreground-secondary">
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </td>
                    <td className="num">
                      <span className={row.fatal > 0 ? 'text-[var(--error)]' : ''}>{row.fatal}</span>
                    </td>
                    <td className="num">
                      <span className={row.error > 0 ? 'text-[var(--error)]' : ''}>{row.error}</span>
                    </td>
                    <td className="num">
                      <span className={row.warning > 0 ? 'text-[var(--warning)]' : ''}>
                        {row.warning}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Top log patterns · last {hours}h</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            grouped by fingerprint across the fleet
          </span>
        </div>
        {patterns.length === 0 ? (
          <div className="panel-body empty">No matching log patterns.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Level</th>
                  <th>Kind</th>
                  <th className="text-right">×</th>
                  <th>Last</th>
                  <th>Sample</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((row) => (
                  <tr key={`${row.instanceId}-${row.fingerprint}-${row.level}`}>
                    <td>
                      <Link
                        href={`/instances/${row.instanceId}/logs`}
                        className="underline decoration-dotted"
                      >
                        {row.alias}
                      </Link>
                    </td>
                    <td>
                      <span className={`tag ${levelTone(row.level)}`}>{row.level}</span>
                    </td>
                    <td className="text-[11px]">
                      {KIND_LABEL[row.kind as LogKind] ?? row.kind}
                    </td>
                    <td className="num font-mono">{row.times}</td>
                    <td className="text-[11px] text-foreground-secondary">
                      {formatAgo(row.lastAt)}
                    </td>
                    <td className="font-mono text-[11px] text-foreground-secondary max-w-[28rem] truncate">
                      {row.sample}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
