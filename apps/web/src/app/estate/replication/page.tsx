import { NotesPanel } from '@/components/NotesPanel';
import { ReplicationTable } from '@/components/ReplicationTable';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatBytes } from '@/lib/format';
import { getNotes, getReplication, type ReplicationRow } from '@/lib/estate';
import { getReplicationLagTrends } from '@/lib/replication';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HA / Replication · Estate · Búho' };

function isDangerous(row: ReplicationRow): boolean {
  if (row.role === 'subscription' && row.state === 'down') return true;
  if (row.role === 'slot' && (row.state === 'inactivo' || row.state === 'inactive')) return true;
  if (row.role === 'replica' && row.state !== 'Yes') return true;
  if ((row.lagBytes ?? 0) > 0 && (row.lagSeconds ?? 0) > 300) return true;
  if ((row.lagBytes ?? 0) > 1024 * 1024) return true;
  return false;
}

function streamingOk(state: string | null): boolean {
  if (!state) return false;
  const normalized = state.toLowerCase();
  return normalized === 'streaming' || normalized === 'yes' || normalized === 'sync';
}

export default async function ReplicationPage() {
  let rows: ReplicationRow[];
  let notes;
  let trends: Record<string, number[]>;
  try {
    [rows, notes] = await Promise.all([getReplication(), getNotes('replication')]);
    trends = await getReplicationLagTrends(rows);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const withReplicas = rows.filter(
    (row) =>
      row.role === 'standby' ||
      row.role === 'upstream' ||
      row.role === 'replica' ||
      (row.role === 'availability_group' && row.peer !== ''),
  );
  const alone = rows
    .filter((row) => {
      if (row.role !== 'primary' && !(row.role === 'availability_group' && !row.peer)) return false;
      return true;
    })
    .filter((row) => !withReplicas.some((peer) => peer.instanceId === row.instanceId));
  const danger = rows.filter(isDangerous);
  const retained = rows
    .filter((row) => row.role === 'slot')
    .reduce((sum, row) => sum + (row.lagBytes ?? 0), 0);

  const lagHeat = withReplicas
    .filter((row) => row.lagSeconds !== null || (row.lagBytes ?? 0) > 0)
    .map((row) => ({
      ...row,
      score: Math.max(row.lagSeconds ?? 0, (row.lagBytes ?? 0) / (1024 * 1024)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);

  const tableRows = rows.map((row) => ({
    instanceId: row.instanceId,
    alias: row.alias,
    engine: row.engine,
    role: row.role,
    peer: row.peer,
    state: row.state,
    lagSeconds: row.lagSeconds,
    lagBytes: row.lagBytes,
    detail: row.detail,
    dangerous: isDangerous(row),
    streaming: streamingOk(row.state),
  }));

  const standaloneOnly = alone.length > 0 && withReplicas.length === 0;

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <header className="flex flex-col gap-1">
        <h1 className="text-[1.1rem] font-semibold m-0">Cluster · HA / replication</h1>
        <p className="text-[12px] text-foreground-secondary m-0 max-w-[62rem]">
          Live topology from the active fleet only (retired Admin targets are hidden). A single
          primary with no standbys is expected when you monitor one Postgres — not a missing
          inventory.
        </p>
      </header>

      <div className="stat-grid">
        <StatCard
          label="Standalone primaries"
          value={String(alone.length)}
          hint="no replica / AG peer attached"
          tone={alone.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Connected replicas"
          value={String(withReplicas.length)}
          tone={withReplicas.length > 0 ? 'ok' : 'neutral'}
        />
        <StatCard
          label="Need attention"
          value={String(danger.length)}
          hint="inactive slots, down replicas, or high lag"
          tone={danger.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="WAL retained by slots"
          value={formatBytes(retained)}
          hint="space the primary cannot reclaim"
          tone={retained > 10 * 1024 ** 3 ? 'error' : retained > 1024 ** 3 ? 'warn' : 'ok'}
        />
      </div>

      {standaloneOnly ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">No high-availability peers</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary space-y-2">
            <p className="m-0">
              Active fleet shows {alone.length === 1 ? (
                <>
                  <span className="font-mono">{alone[0]?.alias}</span> as a standalone primary
                </>
              ) : (
                <>{alone.length} standalone primaries</>
              )}
              — Búho found no streaming standbys, Always On peers, or MariaDB replicas. Add a standby
              (or un-retire HA lab targets) when you want lag heat and peer health here.
            </p>
          </div>
        </section>
      ) : null}

      <NotesPanel notes={notes} title="What Búho reads from each engine" />

      {lagHeat.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Lag heat · worst peers</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              seconds of lag or retained WAL · top {lagHeat.length}
            </span>
          </div>
          <div className="panel-body flex flex-wrap gap-2">
            {lagHeat.map((row) => {
              const secs = row.lagSeconds ?? 0;
              const tone =
                secs > 300 || (row.lagBytes ?? 0) > 1024 * 1024
                  ? 'tag--error'
                  : secs > 30
                    ? 'tag--warn'
                    : 'tag--ok';
              return (
                <span
                  key={`${row.instanceId}-${row.peer}-${row.role}`}
                  className={`tag ${tone}`}
                  title={`${row.alias} → ${row.peer || row.role}`}
                >
                  {row.alias}
                  {row.peer ? ` → ${row.peer}` : ''}
                  {secs > 0 ? ` · ${secs.toFixed(0)}s` : ''}
                  {(row.lagBytes ?? 0) > 0 ? ` · ${formatBytes(row.lagBytes)}` : ''}
                </span>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Replication topology</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            trend = WAL pending (standby) or replay lag · last 24 h · active instances only
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No replication rows for the active fleet.</div>
        ) : (
          <ReplicationTable rows={tableRows} trends={trends} />
        )}
      </section>
    </div>
  );
}
