import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import {
  instanceProveRestoreItems,
  ProveRestore,
} from '@/components/ProveRestore';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes } from '@/lib/format';
import {
  ENGINE_LABEL,
  backupAgeHours,
  backupKindLabel,
  backupState,
  backupStateHint,
  backupStateLabel,
  getInstanceEngine,
  getInstanceInventory,
  type BackupRow,
} from '@/lib/estate';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const STATE_TAG: Record<string, string> = {
  sin_recuperacion: 'tag--error',
  atrasado: 'tag--warn',
  no_verificable: 'tag--muted',
  ok: 'tag--ok',
};

const KIND_ORDER = ['full', 'differential', 'log'] as const;

function CheckCell({ row }: { row: BackupRow | undefined }) {
  if (!row) {
    return (
      <span className="tag tag--muted" title="Not applicable for this recovery model">
        —
      </span>
    );
  }
  const state = backupState(row);
  const label = backupStateLabel(row);
  if (state === 'no_verificable' && label.startsWith('N/A')) {
    return (
      <span className="tag tag--muted" title={label}>
        —
      </span>
    );
  }
  const ok = state === 'ok';
  const age = backupAgeHours(row);
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${
        ok ? 'text-[var(--success)]' : 'text-[var(--error)]'
      }`}
      title={backupStateHint(row) ?? label}
    >
      <span aria-hidden className="text-[14px] leading-none">
        {ok ? '✓' : '✗'}
      </span>
      <span className="text-foreground-muted">
        {row.finishedAt ? formatAgo(row.finishedAt) : 'never'}
        {age !== null ? ` · ${age.toFixed(1)}h` : ''}
      </span>
    </span>
  );
}

/**
 * Respaldos de una instancia (msdb / pg_stat / …).
 *
 * Estate responde "¿quién del parque está mal?"; esta pestaña responde
 * "¿cómo está *este* servidor?" sin obligar a abrir Inventory.
 * En SQL Server: una fila por DB con checks Full / Diff / Log (intent Superset).
 */
export default async function InstanceBackupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  let instance;
  let engine;
  let inventory;
  try {
    [instance, engine] = await Promise.all([getInstance(instanceId), getInstanceEngine(instanceId)]);
    if (!instance) notFound();
    inventory = await getInstanceInventory(instanceId);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const motor = engine ?? 'postgres';
  const rows = inventory.backups;
  const broken = rows.filter((row) => backupState(row) === 'sin_recuperacion');
  const overdue = rows.filter((row) => backupState(row) === 'atrasado');
  const ok = rows.filter((row) => backupState(row) === 'ok');
  const esMssql = motor === 'mssql';

  const byDb = new Map<string, Partial<Record<(typeof KIND_ORDER)[number], BackupRow>>>();
  for (const row of rows) {
    const kind = row.kind as (typeof KIND_ORDER)[number];
    if (!KIND_ORDER.includes(kind)) continue;
    const entry = byDb.get(row.database) ?? {};
    entry[kind] = row;
    byDb.set(row.database, entry);
  }
  const databases = [...byDb.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Backups' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Backups</h1>
            <p className="page-sub">
              Last known backup per database · {ENGINE_LABEL[motor] ?? motor}
              {esMssql ? ' · from msdb.dbo.backupset' : ''}
            </p>
          </div>
          <Link href="/estate" className="text-[12px] text-accent">
            Estate backups →
          </Link>
        </header>
        <InstanceTabs instanceId={instanceId} engine={motor} />

        <div className="stat-grid">
          <StatCard label="Databases tracked" value={String(new Set(rows.map((r) => r.database)).size)} />
          <StatCard
            label={esMssql ? 'Missing backups' : 'No recovery'}
            value={String(broken.length)}
            tone={broken.length > 0 ? 'error' : 'ok'}
            hint={
              esMssql
                ? 'full/diff/log never taken (SIMPLE diff/log excluded)'
                : 'never backed up or PITR broken'
            }
          />
          <StatCard
            label="Overdue"
            value={String(overdue.length)}
            tone={overdue.length > 0 ? 'warn' : 'ok'}
          />
          <StatCard label="OK" value={String(ok.length)} tone="ok" />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">{esMssql ? 'By database · Full / Diff / Log' : 'By database'}</span>
          </div>
          {rows.length === 0 ? (
            <div className="panel-body empty">
              {esMssql ? (
                <>
                  No backup inventory yet. Grant the monitor login access to{' '}
                  <span className="font-mono">msdb.dbo.backupset</span> and wait for the hourly
                  inventory cycle — or open{' '}
                  <Link
                    href={`/instances/${instanceId}/inventory`}
                    className="underline decoration-dotted"
                  >
                    Inventory
                  </Link>
                  .
                </>
              ) : motor === 'oracle' ? (
                <>
                  No backup inventory yet. Oracle RMAN / Data Pump catalog rows appear here when the
                  collector can read them; until then open{' '}
                  <Link
                    href={`/instances/${instanceId}/inventory`}
                    className="underline decoration-dotted"
                  >
                    Inventory
                  </Link>{' '}
                  for settings and disk findings.
                </>
              ) : motor === 'mariadb' ? (
                <>
                  No backup inventory yet. MariaDB does not expose a built-in backup catalog like
                  SQL Server msdb — configure your backup tool and check{' '}
                  <Link
                    href={`/instances/${instanceId}/inventory`}
                    className="underline decoration-dotted"
                  >
                    Inventory
                  </Link>
                  .
                </>
              ) : (
                <>
                  No backup inventory yet. PostgreSQL uses{' '}
                  <span className="font-mono">pg_stat_archiver</span> / base-backup signals when
                  available. Wait for the hourly inventory cycle — or open{' '}
                  <Link
                    href={`/instances/${instanceId}/inventory`}
                    className="underline decoration-dotted"
                  >
                    Inventory
                  </Link>
                  .
                </>
              )}
            </div>
          ) : esMssql ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Full</th>
                  <th>Diff</th>
                  <th>Log</th>
                  <th className="text-right">Full size</th>
                </tr>
              </thead>
              <tbody>
                {databases.map((db) => {
                  const kinds = byDb.get(db) ?? {};
                  return (
                    <tr key={db}>
                      <td className="font-mono text-[11px]">{db}</td>
                      <td>
                        <CheckCell row={kinds.full} />
                      </td>
                      <td>
                        <CheckCell row={kinds.differential} />
                      </td>
                      <td>
                        <CheckCell row={kinds.log} />
                      </td>
                      <td className="num">
                        {kinds.full?.sizeBytes ? formatBytes(kinds.full.sizeBytes) : '·'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Last</th>
                  <th>Age</th>
                  <th className="text-right">Size</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const state = backupState(row);
                  const age = backupAgeHours(row);
                  return (
                    <tr key={`${row.database}-${row.kind}-${index}`}>
                      <td className="font-mono text-[11px]">{row.database}</td>
                      <td>{backupKindLabel(row)}</td>
                      <td>
                        <span
                          className={`tag ${STATE_TAG[state] ?? 'tag--muted'}`}
                          title={backupStateHint(row) ?? undefined}
                        >
                          {backupStateLabel(row)}
                        </span>
                      </td>
                      <td>{row.finishedAt ? formatAgo(row.finishedAt) : '—'}</td>
                      <td className="font-mono text-[11px] text-foreground-muted">
                        {age === null ? '—' : `${age.toFixed(1)}h`}
                      </td>
                      <td className="num">{row.sizeBytes ? formatBytes(row.sizeBytes) : '·'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <ProveRestore items={instanceProveRestoreItems(instanceId)} />
      </div>
    </>
  );
}
