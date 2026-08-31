import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { formatAgo, formatBytes, formatDuration } from '@/lib/format';
import { ENGINE_LABEL, type InstanceInventory } from '@/lib/estate';

const DAY_MS = 86_400_000;

/**
 * Pantalla de instancia para los motores que entran sólo por inventario.
 *
 * Antes esta ruta renderizaba la plantilla de PostgreSQL para cualquier motor:
 * un SQL Server mostraba "edad de XID", "WAL generado por segundo" y un aviso de
 * `pg_stat_statements`, todo vacío. Es peor que no tener la pantalla, porque
 * quien la ve concluye que la herramienta está rota y deja de creerle también a
 * los datos correctos.
 */
/**
 * El número de versión que guarda Búho (164265, 110412) sirve para ordenar y
 * comparar, no para leerlo. La tarjeta muestra el primer grupo numérico del
 * texto — "16.0.4265.3", "11.4.12" — y deja la cadena completa en el pie.
 */
function shortVersion(versionText: string | undefined): string {
  if (!versionText) return '—';
  const match = versionText.match(/\d+(\.\d+)+/);
  return match?.[0] ?? versionText.split(' ')[0] ?? '—';
}

export function InventoryInstance({
  instanceId,
  alias,
  engine,
  inventory,
}: {
  instanceId: number;
  alias: string;
  engine: string;
  inventory: InstanceInventory;
}) {
  const info = inventory.engine;
  const licensing = inventory.licensing;
  const eolDays = info?.eolDate
    ? Math.round((new Date(`${info.eolDate}T00:00:00Z`).getTime() - Date.now()) / DAY_MS)
    : null;

  const totalSize = inventory.disks
    .filter((row) => row.kind === 'database')
    .reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  const failedJobs = inventory.jobs.filter((job) => job.lastStatus === 'falló');

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <section className="panel">
        <div className="panel-body text-[12.5px]">
          <strong>{ENGINE_LABEL[engine] ?? engine} entra por el inventario del parque.</strong> Las series de
          métricas cada cinco segundos, los 22 checks y el análisis por consulta son de PostgreSQL: las vistas de
          estadísticas de los tres motores no se parecen, y forzarlas a un molde común terminaría mintiendo sobre lo
          que mide cada una. Lo que sí se unifica es el inventario, que es lo que aparece abajo y en{' '}
          <Link href="/estate" className="underline decoration-dotted">
            Parque
          </Link>
          .
        </div>
      </section>

      <div className="stat-grid">
        <StatCard label="Versión" value={shortVersion(info?.versionText)} hint={info?.versionText ?? 'sin inventariar'} />
        <StatCard label="Edición" value={info?.edition ?? '—'} hint={info?.updateLevel ?? info?.productLevel ?? undefined} />
        <StatCard
          label="Fin de soporte"
          value={info?.eolDate ?? '—'}
          hint={eolDays === null ? undefined : eolDays < 0 ? `vencido hace ${-eolDays} días` : `en ${eolDays} días`}
          tone={eolDays === null ? 'neutral' : eolDays < 0 ? 'error' : eolDays < 180 ? 'warn' : 'ok'}
        />
        <StatCard label="Núcleos" value={info?.cores ? String(info.cores) : '—'} hint={info?.memoryBytes ? formatBytes(info.memoryBytes) : undefined} />
        <StatCard label="Datos" value={formatBytes(totalSize)} hint={`${inventory.disks.filter((d) => d.kind === 'database').length} bases`} />
        <StatCard label="Arranque" value={info?.startedAt ? formatAgo(info.startedAt) : '—'} />
        <StatCard
          label="Jobs con error"
          value={String(failedJobs.length)}
          hint={`${inventory.jobs.length} tareas`}
          tone={failedJobs.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Licencia"
          value={licensing?.productionOk === false ? 'no apta' : licensing?.productionOk === null ? 'libre' : 'apta'}
          hint={licensing?.edition ?? undefined}
          tone={licensing?.productionOk === false ? 'error' : 'ok'}
        />
      </div>

      <NotesPanel notes={inventory.notes} />

      <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Respaldos</span>
            <Link href="/estate" className="text-[11px] underline decoration-dotted">
              ver todo el parque
            </Link>
          </div>
          {inventory.backups.length === 0 ? (
            <div className="empty">Sin datos de respaldo.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Base</th>
                  <th>Tipo</th>
                  <th>Último</th>
                  <th className="text-right">Tamaño</th>
                </tr>
              </thead>
              <tbody>
                {inventory.backups.map((row, index) => (
                  <tr key={`${row.database}-${row.kind}-${index}`}>
                    <td className="font-mono text-[11px]">{row.database}</td>
                    <td>{row.kind}</td>
                    <td>
                      {row.finishedAt ? (
                        formatAgo(row.finishedAt)
                      ) : (
                        <span className="tag tag--error">nunca</span>
                      )}
                    </td>
                    <td className="num">{row.sizeBytes ? formatBytes(row.sizeBytes) : '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Replicación</span>
          </div>
          {inventory.replication.length === 0 ? (
            <div className="empty">Sin datos de replicación.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rol</th>
                  <th>Par</th>
                  <th>Estado</th>
                  <th className="text-right">Lag</th>
                </tr>
              </thead>
              <tbody>
                {inventory.replication.map((row, index) => (
                  <tr key={`${row.role}-${row.peer}-${index}`}>
                    <td>{row.role}</td>
                    <td className="font-mono text-[11px]">{row.peer || '·'}</td>
                    <td>{row.state ?? '·'}</td>
                    <td className="num">{row.lagSeconds === null ? '·' : formatDuration(row.lagSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Tareas programadas</span>
          <Link href="/estate/jobs" className="text-[11px] underline decoration-dotted">
            ver todas
          </Link>
        </div>
        {inventory.jobs.length === 0 ? (
          <div className="empty">Sin tareas registradas en el motor.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Tarea</th>
                <th>Categoría</th>
                <th>Estado</th>
                <th>Última corrida</th>
                <th className="text-right">Duración</th>
              </tr>
            </thead>
            <tbody>
              {inventory.jobs.map((job, index) => (
                <tr key={`${job.scope}-${job.name}-${index}`}>
                  <td className="font-mono text-[11px]">{job.name}</td>
                  <td className="text-[11px] text-foreground-secondary">{job.scope || '·'}</td>
                  <td>
                    {job.enabled === false ? (
                      <span className="tag tag--warn">deshabilitado</span>
                    ) : job.lastStatus === 'falló' ? (
                      <span className="tag tag--error">falló</span>
                    ) : job.lastStatus ? (
                      <span className="tag tag--ok">{job.lastStatus}</span>
                    ) : (
                      <span className="tag tag--muted">sin historial</span>
                    )}
                  </td>
                  <td className="text-[11px]">{job.lastRunAt ? formatAgo(job.lastRunAt) : '·'}</td>
                  <td className="num">
                    {job.lastDurationMs === null ? '·' : formatDuration(job.lastDurationMs / 1000)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Configuración auditada</span>
          <Link href="/estate/configuration" className="text-[11px] underline decoration-dotted">
            comparar con el parque
          </Link>
        </div>
        {inventory.settings.length === 0 ? (
          <div className="empty">Sin parámetros inventariados.</div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: '24rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Parámetro</th>
                  <th>Valor</th>
                  <th>Por defecto</th>
                  <th>Reinicio</th>
                </tr>
              </thead>
              <tbody>
                {inventory.settings.map((row) => (
                  <tr key={row.name}>
                    <td className="font-mono text-[11px]">{row.name}</td>
                    <td className="font-mono text-[11px]">
                      {row.value === '' ? '(vacío)' : row.value}
                      {row.unit ? <span className="text-foreground-muted"> {row.unit}</span> : null}
                    </td>
                    <td>{row.isDefault ? <span className="tag tag--muted">sí</span> : '·'}</td>
                    <td>{row.requiresRestart ? <span className="tag tag--muted">sí</span> : '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="text-[11px] text-foreground-muted">
        Instancia #{instanceId} · {alias}
      </div>
    </div>
  );
}
