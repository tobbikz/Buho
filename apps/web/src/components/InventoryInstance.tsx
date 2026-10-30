import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { formatAgo, formatBytes, formatDuration } from '@/lib/format';
import {
  ENGINE_LABEL,
  backupKindLabel,
  type InstanceInventory,
} from '@/lib/estate';

const DAY_MS = 86_400_000;

/**
 * Pantalla de instancia para los motores que entran sólo por inventario.
 *
 * Antes esta ruta renderizaba la plantilla de PostgreSQL para cualquier motor:
 * un SQL Server mostraba "edad de XID", "WAL generated per second" y un aviso de
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
  const failedJobs = inventory.jobs.filter(
    (job) => job.lastStatus === 'failed' || job.lastStatus === 'falló',
  );

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <section className="panel">
        <div className="panel-body text-[12.5px]">
          Configuration, disk layout, jobs, licensing and backup catalog for{' '}
          <strong>{alias}</strong>. Live metrics live in{' '}
          <Link href={`/instances/${instanceId}`} className="underline decoration-dotted">
            Overview
          </Link>
          ; the fleet-wide backup posture is in{' '}
          <Link href="/estate" className="underline decoration-dotted">
            Estate
          </Link>
          .
        </div>
      </section>

      <div className="stat-grid">
        <StatCard label="Version" value={shortVersion(info?.versionText)} hint={info?.versionText ?? 'not inventoried'} />
        <StatCard label="Edition" value={info?.edition ?? '—'} hint={info?.updateLevel ?? info?.productLevel ?? undefined} />
        <StatCard
          label="End of support"
          value={info?.eolDate ?? '—'}
          hint={eolDays === null ? undefined : eolDays < 0 ? `expired ${-eolDays} days ago` : `in ${eolDays} days`}
          tone={eolDays === null ? 'neutral' : eolDays < 0 ? 'error' : eolDays < 180 ? 'warn' : 'ok'}
        />
        <StatCard label="Cores" value={info?.cores ? String(info.cores) : '—'} hint={info?.memoryBytes ? formatBytes(info.memoryBytes) : undefined} />
        <StatCard
          label="Data size"
          value={formatBytes(totalSize)}
          hint={`${inventory.disks.filter((d) => d.kind === 'database').length} databases`}
        />
        <StatCard label="Uptime since" value={info?.startedAt ? formatAgo(info.startedAt) : '—'} />
        <StatCard
          label="Jobs with errors"
          value={String(failedJobs.length)}
          hint={`${inventory.jobs.length} jobs`}
          tone={failedJobs.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="License"
          value={
            licensing?.productionOk === false
              ? 'not eligible'
              : licensing?.productionOk === null
                ? 'unrestricted'
                : 'production OK'
          }
          hint={licensing?.edition ?? undefined}
          tone={licensing?.productionOk === false ? 'error' : 'ok'}
        />
      </div>

      <NotesPanel notes={inventory.notes} />

      <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Backups</span>
            <Link href={`/instances/${instanceId}/backups`} className="text-[11px] underline decoration-dotted">
              open Backups
            </Link>
          </div>
          {inventory.backups.length === 0 ? (
            <div className="empty">No backup data.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Kind</th>
                  <th>Last</th>
                  <th className="text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {inventory.backups.map((row, index) => (
                  <tr key={`${row.database}-${backupKindLabel(row)}-${index}`}>
                    <td className="font-mono text-[11px]">{row.database}</td>
                    <td>{backupKindLabel(row)}</td>
                    <td>
                      {row.finishedAt ? (
                        formatAgo(row.finishedAt)
                      ) : (
                        <span className="tag tag--error">never</span>
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
            <span className="panel-title">Replication & HA</span>
            <Link
              href={`/instances/${instanceId}/replication`}
              className="text-[11px] underline decoration-dotted"
            >
              open page
            </Link>
          </div>
          {inventory.replication.length === 0 ? (
            <div className="empty">No replication data.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Peer</th>
                  <th>State</th>
                  <th className="text-right">Lag</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {inventory.replication.map((row, index) => (
                  <tr key={`${row.role}-${row.peer}-${index}`}>
                    <td>{row.role}</td>
                    <td className="font-mono text-[11px]">{row.peer || '·'}</td>
                    <td>{row.state ?? '·'}</td>
                    <td className="num">{row.lagSeconds == null ? '·' : formatDuration(row.lagSeconds)}</td>
                    <td className="max-w-0 truncate font-mono text-[10px] text-foreground-muted">
                      {Object.entries(row.detail ?? {})
                        .filter(([, value]) => value !== null && value !== '')
                        .map(([key, value]) => `${key}=${value}`)
                        .join(' ') || '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Scheduled jobs</span>
          <Link href="/estate/jobs" className="text-[11px] underline decoration-dotted">
            view all
          </Link>
        </div>
        {inventory.jobs.length === 0 ? (
          <div className="empty">No jobs registered in the engine.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Category</th>
                <th>State</th>
                <th>Last run</th>
                <th className="text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {inventory.jobs.map((job, index) => (
                <tr key={`${job.scope}-${job.name}-${index}`}>
                  <td className="font-mono text-[11px]">{job.name}</td>
                  <td className="text-[11px] text-foreground-secondary">{job.scope || '·'}</td>
                  <td>
                    {job.enabled === false ? (
                      <span className="tag tag--warn">disabled</span>
                    ) : job.lastStatus === 'failed' || job.lastStatus === 'falló' ? (
                      <span className="tag tag--error">failed</span>
                    ) : job.lastStatus ? (
                      <span className="tag tag--ok">{job.lastStatus}</span>
                    ) : (
                      <span className="tag tag--muted">no history</span>
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
          <span className="panel-title">Audited configuration</span>
          <Link href="/estate/configuration" className="text-[11px] underline decoration-dotted">
            compare with the estate
          </Link>
        </div>
        {inventory.settings.length === 0 ? (
          <div className="empty">No inventoried parameters.</div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: '24rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Value</th>
                  <th>Default</th>
                  <th>Restart</th>
                </tr>
              </thead>
              <tbody>
                {inventory.settings.map((row) => (
                  <tr key={row.name}>
                    <td className="font-mono text-[11px]">{row.name}</td>
                    <td className="font-mono text-[11px]">
                      {row.value === '' ? '(empty)' : row.value}
                      {row.unit ? <span className="text-foreground-muted"> {row.unit}</span> : null}
                    </td>
                    <td>{row.isDefault ? <span className="tag tag--muted">yes</span> : '·'}</td>
                    <td>{row.requiresRestart ? <span className="tag tag--muted">yes</span> : '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="text-[11px] text-foreground-muted">
        Instance #{instanceId} · {alias}
      </div>
    </div>
  );
}
