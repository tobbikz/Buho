import { NotesPanel } from '@/components/NotesPanel';
import { ReplicationTable } from '@/components/ReplicationTable';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatBytes } from '@/lib/format';
import { getNotes, getReplication, type ReplicationRow } from '@/lib/estate';
import { getReplicationLagTrends } from '@/lib/replication';

export const dynamic = 'force-dynamic';

function isDangerous(row: ReplicationRow): boolean {
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
  const alone = rows.filter((row) => {
    if (row.role !== 'primary' && !(row.role === 'availability_group' && !row.peer)) return false;
    // Posture-only rows still mean "no live replica peer".
    return true;
  }).filter((row) => {
    // Don't double-count an instance that also has real replica peers.
    return !withReplicas.some((peer) => peer.instanceId === row.instanceId);
  });
  const danger = rows.filter(isDangerous);
  const retained = rows
    .filter((row) => row.role === 'slot')
    .reduce((sum, row) => sum + (row.lagBytes ?? 0), 0);

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

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="No high availability"
          value={String(alone.length)}
          hint="instances with neither replica nor group"
          tone={alone.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Connected replicas" value={String(withReplicas.length)} tone={withReplicas.length > 0 ? 'ok' : 'neutral'} />
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

      <NotesPanel notes={notes} title="What Búho reads from each engine" />

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Replication topology</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            trend = WAL pending (standby) or replay lag (primary view) · last 24 h · PostgreSQL · MariaDB · SQL Server
          </span>
        </div>
        <ReplicationTable rows={tableRows} trends={trends} />
      </section>
    </div>
  );
}
