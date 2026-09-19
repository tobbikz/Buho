import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatBytes, formatAgo } from '@/lib/format';
import {
  backupAgeHours,
  backupState,
  backupStateHint,
  backupStateLabel,
  ENGINE_LABEL,
  getBackups,
  getNotes,
  type BackupRow,
  type BackupState,
} from '@/lib/estate';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  full: 'Completo',
  differential: 'Diferencial',
  log: 'Log',
  wal_archive: 'Archivado de WAL',
};

const STATE_TAG: Record<BackupState, string> = {
  sin_recuperacion: 'tag--error',
  atrasado: 'tag--warn',
  no_verificable: 'tag--muted',
  ok: 'tag--ok',
};

export default async function BackupsPage() {
  let rows: BackupRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getBackups(), getNotes('backups')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const archiveOff = rows.filter(
    (row) => row.kind === 'wal_archive' && row.detail['archive_mode'] === 'off',
  );
  const atRisk = rows.filter(
    (row) =>
      backupState(row) === 'sin_recuperacion' &&
      !(row.kind === 'wal_archive' && row.detail['archive_mode'] === 'off'),
  );
  const stale = rows.filter((row) => backupState(row) === 'atrasado');
  const unknown = rows.filter((row) => backupState(row) === 'no_verificable');
  const protectedDbs = new Set(
    rows.filter((row) => backupState(row) === 'ok').map((row) => `${row.instanceId}/${row.database}`),
  );
  const allDbs = new Set(rows.map((row) => `${row.instanceId}/${row.database}`));

  // Timeline buckets for "last successful backup age" (full/diff/log only).
  const timelineKinds = rows.filter((row) => row.kind !== 'wal_archive');
  const AGE_BUCKETS = [
    { key: '6h', label: '≤ 6 h', maxH: 6 },
    { key: '24h', label: '≤ 24 h', maxH: 24 },
    { key: '3d', label: '≤ 3 d', maxH: 72 },
    { key: '7d', label: '≤ 7 d', maxH: 168 },
    { key: 'old', label: '> 7 d', maxH: Infinity },
    { key: 'never', label: 'Never', maxH: -1 },
  ] as const;
  const ageBuckets = AGE_BUCKETS.map((bucket) => {
    const count = timelineKinds.filter((row) => {
      const age = backupAgeHours(row);
      if (bucket.key === 'never') return age === null;
      if (age === null) return false;
      if (bucket.key === '6h') return age <= 6;
      if (bucket.key === '24h') return age > 6 && age <= 24;
      if (bucket.key === '3d') return age > 24 && age <= 72;
      if (bucket.key === '7d') return age > 72 && age <= 168;
      return age > 168;
    }).length;
    return { ...bucket, count };
  });

  // Heat grid: instance × kind with state color.
  const heatInstances = [...new Map(timelineKinds.map((r) => [r.instanceId, r])).values()].sort(
    (a, b) => a.alias.localeCompare(b.alias),
  );
  const heatKinds = ['full', 'differential', 'log'] as const;

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Backup at risk"
          value={String(atRisk.length)}
          hint="no backup, broken PITR chain, or far overdue"
          tone={atRisk.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Archive off"
          value={String(archiveOff.length)}
          hint="archive_mode off — PITR unavailable; separate from replication"
          tone={archiveOff.length > 0 ? 'neutral' : 'ok'}
        />
        <StatCard
          label="Overdue backup"
          value={String(stale.length)}
          hint="older than its tolerance window"
          tone={stale.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Bases cubiertas"
          value={`${protectedDbs.size} de ${allDbs.size}`}
          hint="with at least one backup inside the window"
          tone={protectedDbs.size === allDbs.size && allDbs.size > 0 ? 'ok' : 'warn'}
        />
        <StatCard
          label="Not verifiable"
          value={String(unknown.length)}
          hint="the engine has no backup catalog"
          tone={unknown.length > 0 ? 'neutral' : 'ok'}
        />
      </div>

      <NotesPanel notes={notes} />

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Backup age timeline</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            full / differential / log · how old is the last run
          </span>
        </div>
        <div className="panel-body">
          <div className="flex flex-wrap gap-2">
            {ageBuckets.map((bucket) => (
              <div
                key={bucket.key}
                className="flex min-w-[5.5rem] flex-col gap-1 rounded border border-[var(--border)] px-3 py-2"
              >
                <span className="font-mono text-[10px] text-foreground-muted">{bucket.label}</span>
                <span
                  className={`text-[1.25rem] font-semibold tabular-nums ${
                    bucket.key === 'never' || bucket.key === 'old'
                      ? 'text-[var(--error)]'
                      : bucket.key === '7d' || bucket.key === '3d'
                        ? 'text-[var(--warning)]'
                        : 'text-[var(--success)]'
                  }`}
                >
                  {bucket.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {heatInstances.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Backup heat · instance × kind</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              OK · overdue · at risk · unknown
            </span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  {heatKinds.map((kind) => (
                    <th key={kind}>{KIND_LABEL[kind] ?? kind}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatInstances.map((inst) => (
                  <tr key={inst.instanceId}>
                    <td>
                      <Link
                        href={`/instances/${inst.instanceId}`}
                        className="underline decoration-dotted"
                      >
                        {inst.alias}
                      </Link>
                    </td>
                    {heatKinds.map((kind) => {
                      const match = timelineKinds.find(
                        (r) => r.instanceId === inst.instanceId && r.kind === kind,
                      );
                      if (!match) {
                        return (
                          <td key={kind}>
                            <span className="tag tag--muted">—</span>
                          </td>
                        );
                      }
                      const state = backupState(match);
                      return (
                        <td key={kind}>
                          <span
                            className={`tag ${
                              backupStateLabel(match) === 'Archive off'
                                ? 'tag--muted'
                                : STATE_TAG[state]
                            }`}
                            title={
                              match.finishedAt
                                ? `${backupStateLabel(match)} · ${formatAgo(match.finishedAt)}`
                                : backupStateLabel(match)
                            }
                          >
                            {backupStateLabel(match)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Backup state by database</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            completo ≤ 7 d · diferencial ≤ 24 h · log ≤ 4 h
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            No backup inventory yet. Labs without FULL/DIFF/LOG backups will show empty here and tank the
            health score via configuration checks — that is intentional. After the first collector pass,
            Estate lists each database with an honest state (No backup / Archive off / OK).
          </div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Engine</th>
                  <th>Database</th>
                  <th>Tipo</th>
                  <th>Status</th>
                  <th>Last</th>
                  <th className="text-right">Age</th>
                  <th className="text-right">Size</th>
                  <th>Origen</th>
                  <th>Modelo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const state = backupState(row);
                  const age = backupAgeHours(row);
                  const recovery = row.detail['recovery_model'] as string | undefined;
                  return (
                    <tr key={`${row.instanceId}-${row.database}-${row.kind}-${index}`}>
                      <td>
                        <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                          {row.alias}
                        </Link>
                      </td>
                      <td className="text-[11px] text-foreground-secondary">
                        {ENGINE_LABEL[row.engine] ?? row.engine}
                      </td>
                      <td className="font-mono text-[11px]">{row.database}</td>
                      <td>{KIND_LABEL[row.kind] ?? row.kind}</td>
                      <td>
                        <span
                          className={`tag ${backupStateLabel(row) === 'Archive off' ? 'tag--muted' : STATE_TAG[state]}`}
                          title={backupStateHint(row) ?? undefined}
                        >
                          {backupStateLabel(row)}
                        </span>
                      </td>
                      <td>
                        {row.finishedAt ? (
                          <span className="text-[11px] text-foreground-secondary">{formatAgo(row.finishedAt)}</span>
                        ) : (
                          '·'
                        )}
                      </td>
                      <td className="num">{age === null ? '·' : `${age.toFixed(1)} h`}</td>
                      <td className="num">{row.sizeBytes ? formatBytes(row.sizeBytes) : '·'}</td>
                      <td className="font-mono text-[10px] text-foreground-muted">{row.source}</td>
                      <td className="text-[11px]">{recovery ?? '·'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
