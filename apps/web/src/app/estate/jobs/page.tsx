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

  const failed = rows.filter((row) => row.lastStatus === 'falló');
  const disabled = rows.filter((row) => row.enabled === false);
  const neverRan = rows.filter((row) => row.lastRunAt === null);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Con error en la última corrida"
          value={String(failed.length)}
          tone={failed.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Deshabilitados"
          value={String(disabled.length)}
          hint="un job de respaldo apagado no avisa que no corrió"
          tone={disabled.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Sin historial"
          value={String(neverRan.length)}
          hint="definidos pero nunca ejecutados"
          tone={neverRan.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Tareas inventariadas" value={String(rows.length)} />
      </div>

      <NotesPanel notes={notes} title="Dónde viven las tareas de cada motor" />

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Tareas programadas</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            SQL Agent · eventos de MariaDB · pg_cron
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            Ninguna instancia reportó tareas. En PostgreSQL y MariaDB eso es lo normal: sus tareas suelen vivir en el
            cron del sistema, que el motor no puede ver.
          </div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Motor</th>
                  <th>Tarea</th>
                  <th>Categoría</th>
                  <th>Estado</th>
                  <th>Última corrida</th>
                  <th className="text-right">Duración</th>
                  <th>Próxima</th>
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
                        <span className="tag tag--warn">deshabilitado</span>
                      ) : row.lastStatus === 'falló' ? (
                        <span className="tag tag--error">falló</span>
                      ) : row.lastStatus ? (
                        <span className="tag tag--ok">{row.lastStatus}</span>
                      ) : (
                        <span className="tag tag--muted">sin historial</span>
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
                        <span className="text-foreground-muted">sin agenda</span>
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
