import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo, formatDuration } from '@/lib/format';
import { ENGINE_LABEL, getJobs, getNotes, type JobRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  let rows: JobRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getJobs(), getNotes('jobs')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const failed = rows.filter(
    (row) => row.lastStatus === 'failed' || row.lastStatus === 'falló',
  );
  const disabled = rows.filter((row) => row.enabled === false);
  const neverRan = rows.filter((row) => row.lastRunAt === null);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Failed on last run"
          value={String(failed.length)}
          tone={failed.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Disabled"
          value={String(disabled.length)}
          hint="a disabled backup job will not warn that it did not run"
          tone={disabled.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="No history"
          value={String(neverRan.length)}
          hint="defined but never run"
          tone={neverRan.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Inventoried jobs" value={String(rows.length)} />
      </div>

      <NotesPanel notes={notes} title="Where each engine keeps its jobs" />

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Scheduled jobs</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            SQL Agent · MariaDB events · pg_cron
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            No instance reported jobs. On PostgreSQL and MariaDB that is normal: jobs often live in system cron,
            which the engine cannot see.
          </div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Engine</th>
                  <th>Job</th>
                  <th>Category</th>
                  <th>State</th>
                  <th>Last run</th>
                  <th className="text-right">Duration</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.instanceId}-${row.scope}-${row.name}-${index}`}>
                    <td>
                      <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                        {row.alias}
                      </Link>
                    </td>
                    <td className="text-[11px] text-foreground-secondary">
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </td>
                    <td className="font-mono text-[11px]">{row.name}</td>
                    <td className="text-[11px] text-foreground-secondary">{row.scope || '·'}</td>
                    <td>
                      {row.enabled === false ? (
                        <span className="tag tag--warn">disabled</span>
                      ) : row.lastStatus === 'failed' || row.lastStatus === 'falló' ? (
                        <span className="tag tag--error">failed</span>
                      ) : row.lastStatus ? (
                        <span className="tag tag--ok">{row.lastStatus}</span>
                      ) : (
                        <span className="tag tag--muted">no history</span>
                      )}
                    </td>
                    <td className="text-[11px]">{row.lastRunAt ? formatAgo(row.lastRunAt) : '·'}</td>
                    <td className="num">
                      {row.lastDurationMs === null ? '·' : formatDuration(row.lastDurationMs / 1000)}
                    </td>
                    <td className="text-[11px]">
                      {row.nextRunAt ? (
                        row.nextRunAt.toLocaleString('es-MX', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })
                      ) : (
                        <span className="text-foreground-muted">no schedule</span>
                      )}
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
