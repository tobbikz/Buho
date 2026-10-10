import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { NotesPanel } from '@/components/NotesPanel';
import { ReplicationSankey } from '@/components/ReplicationSankey';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatClock, formatDuration, formatNumber } from '@/lib/format';
import {
  ENGINE_LABEL,
  getInstanceEngine,
  getInstanceInventory,
  type ReplicationRow as EstateReplicationRow,
} from '@/lib/estate';
import { getInstance, getSeries, getSeriesByLabel } from '@/lib/queries';
import { getMariaReplicationSankey } from '@/lib/replication-sankey';
import { shortPeerLabel, shortProcesslistState } from '@/lib/maria-labels';
import {
  getReplicationTopology,
  type InstanceReplicationRow,
  type ReplicationTopology,
  type ReplicationTopologyPeer,
} from '@/lib/replication';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '6h', minutes: 360, bucket: 60 },
  { key: '24h', minutes: 1440, bucket: 300 },
  { key: '7d', minutes: 10080, bucket: 1800 },
];

const SERIES_COLORS = ['#1f5f8b', '#9a4a00', '#2f6b4f', '#7b1fa2', '#b01818', '#4a6fa5'];

const SYNC_MODE_HINT: Record<string, string> = {
  async: 'asynchronous streaming — primary commits without waiting for the standby',
  sync: 'synchronous — primary waits for this standby to flush',
  potential: 'potential sync standby (not currently chosen)',
  quorum: 'quorum synchronous commit',
  mixed: 'standbys use different sync modes',
};

function peerDisplayName(peer: ReplicationTopologyPeer): string {
  return peer.linked?.alias ?? peer.peer;
}

function chartLabel(key: string, topology: ReplicationTopology): string {
  const linked = topology.streamingPeers.find(
    (p) =>
      p.linked?.alias === key ||
      p.peer === key ||
      p.application === key ||
      p.clientAddr === key ||
      (p.linked && (key === 'walreceiver' || key === 'postgres')),
  );
  if (linked?.linked) return linked.linked.alias;
  if (topology.streamingPeers.length === 1 && topology.streamingPeers[0]?.linked) {
    return topology.streamingPeers[0].linked.alias;
  }
  return key;
}

function slotRow(row: InstanceReplicationRow) {
  const safeWal = row.detail['safe_wal_size'];
  const walStatus = typeof row.detail['wal_status'] === 'string' ? row.detail['wal_status'] : null;

  return (
    <tr key={`${row.role}:${row.peer}`}>
      <td className="font-mono text-[11.5px]">{row.peer}</td>
      <td>
        <span
          className={`tag ${
            row.state === 'active' || row.state === 'streaming' || row.state === 'activo'
              ? 'tag--ok'
              : row.state === 'inactive' || row.state === 'inactivo'
                ? 'tag--error'
                : 'tag--muted'
          }`}
        >
          {row.state === 'activo' ? 'active' : row.state === 'inactivo' ? 'inactive' : (row.state ?? 'no state')}
        </span>
      </td>
      <td className="num">{row.lagBytes === null ? '—' : formatBytes(row.lagBytes)}</td>
      <td className="num">{row.lagSeconds === null ? '—' : formatDuration(row.lagSeconds)}</td>
      <td className="font-mono text-[11px] text-foreground-muted">
        {walStatus ?? '—'}
        {typeof safeWal === 'number' && safeWal > 0 ? ` · ${formatBytes(safeWal)} headroom` : ''}
      </td>
      <td className="font-mono text-[10px] text-foreground-muted">{formatAgo(row.capturedAt)}</td>
    </tr>
  );
}

function TopologyPanel({ topology }: { topology: ReplicationTopology }) {
  const { self, role, syncMode, streamingPeers } = topology;
  const primaryNode =
    role === 'primary'
      ? self
      : streamingPeers[0]?.linked ?? null;
  const standbyPeers =
    role === 'standby'
      ? [{ node: self, peer: streamingPeers[0] ?? null }]
      : streamingPeers.map((peer) => ({
          node: peer.linked,
          peer,
        }));

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Cluster</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          {syncMode
            ? `${syncMode} streaming`
            : role === 'standby'
              ? 'streaming from primary'
              : 'topology'}
        </span>
      </div>
      <div className="panel-body">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded border border-border bg-surface-muted/40 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="tag tag--info">Primary</span>
              {role === 'primary' && <span className="tag tag--muted">this instance</span>}
            </div>
            {primaryNode ? (
              <>
                <div className="text-[14px] font-semibold">
                  {role === 'primary' ? (
                    primaryNode.alias
                  ) : (
                    <Link
                      href={`/instances/${primaryNode.instanceId}/replication`}
                      className="underline decoration-dotted"
                    >
                      {primaryNode.alias}
                    </Link>
                  )}
                </div>
                {role !== 'primary' ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Link
                      href={`/instances/${primaryNode.instanceId}`}
                      className="tag tag--muted"
                      title="Open primary overview"
                    >
                      Overview
                    </Link>
                    <Link
                      href={`/instances/${primaryNode.instanceId}/replication`}
                      className="tag tag--muted"
                      title="Open primary replication"
                    >
                      Replication
                    </Link>
                  </div>
                ) : null}
                <div className="font-mono text-[11px] text-foreground-secondary">
                  {primaryNode.host}:{primaryNode.port}
                </div>
                {primaryNode.versionText && (
                  <div className="mt-1 text-[11px] text-foreground-muted">{primaryNode.versionText}</div>
                )}
                {role === 'standby' && streamingPeers[0]?.state === 'no WAL receiver' && (
                  <p className="mt-2 text-[11px] text-[var(--warning)]">
                    Configured primary (from fleet / primary_conninfo). Streaming is not connected
                    right now — no WAL receiver.
                  </p>
                )}
              </>
            ) : (
              <div className="text-[12px] text-foreground-secondary">
                Upstream {streamingPeers[0]?.peer ?? 'unknown'} — not in this Búho fleet.
              </div>
            )}
            {syncMode && (
              <p className="mt-2 text-[11px] text-foreground-secondary">
                Mode: <span className="font-mono font-semibold">{syncMode}</span>
                {SYNC_MODE_HINT[syncMode] ? ` — ${SYNC_MODE_HINT[syncMode]}` : ''}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {standbyPeers.length === 0 ? (
              <div className="rounded border border-border p-3 text-[12px] text-foreground-secondary">
                No connected standbys.
              </div>
            ) : (
              standbyPeers.map(({ node, peer }, index) => (
                <div
                  key={node?.instanceId ?? peer?.peer ?? index}
                  className="rounded border border-border bg-surface-muted/40 p-3"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="tag tag--ok">Standby</span>
                    {role === 'standby' && <span className="tag tag--muted">this instance</span>}
                    {peer?.syncState && (
                      <span className="tag tag--muted" title={SYNC_MODE_HINT[peer.syncState]}>
                        {peer.syncState}
                      </span>
                    )}
                    {peer?.state && (
                      <span className={`tag ${peer.state === 'streaming' ? 'tag--ok' : 'tag--warn'}`}>
                        {peer.state}
                      </span>
                    )}
                  </div>
                  <div className="text-[14px] font-semibold">
                    {node ? (
                      role === 'standby' ? (
                        node.alias
                      ) : (
                        <Link
                          href={`/instances/${node.instanceId}/replication`}
                          className="underline decoration-dotted"
                        >
                          {node.alias}
                        </Link>
                      )
                    ) : (
                      <span className="font-mono">{peer?.peer ?? 'unknown'}</span>
                    )}
                  </div>
                  {node && role !== 'standby' ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Link
                        href={`/instances/${node.instanceId}`}
                        className="tag tag--muted"
                        title="Open standby overview"
                      >
                        Overview
                      </Link>
                      <Link
                        href={`/instances/${node.instanceId}/replication`}
                        className="tag tag--muted"
                        title="Open standby replication"
                      >
                        Replication
                      </Link>
                    </div>
                  ) : null}
                  <div className="font-mono text-[11px] text-foreground-secondary">
                    {node
                      ? `${node.host}:${node.port}`
                      : peer?.clientAddr
                        ? peer.clientAddr
                        : peer?.peer}
                    {node && peer?.clientAddr && peer.clientAddr !== node.host
                      ? ` · stream ${peer.clientAddr}`
                      : ''}
                  </div>
                  {peer && (
                    <div className="mt-1 text-[11px] text-foreground-muted">
                      {peer.lagBytes !== null ? `${formatBytes(peer.lagBytes)} behind` : '—'}
                      {peer.lagSeconds !== null ? ` · ${formatDuration(peer.lagSeconds)}` : ''}
                      {peer.application ? ` · app ${peer.application}` : ''}
                    </div>
                  )}
                  {!node && peer && (
                    <div className="mt-1 text-[11px] text-foreground-muted">
                      Streaming peer is not a monitored Búho instance.
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function ReplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { id } = await params;
  const { w } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engineKind = await getInstanceEngine(instanceId);
  if (engineKind && engineKind !== 'postgres') {
    return <ForeignReplicationPage instanceId={instanceId} engine={engineKind} />;
  }

  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1]!;

  let instance;
  try {
    instance = await getInstance(instanceId);
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
  if (!instance) notFound();

  const crumbs = [
    { label: 'Fleet', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Replication' },
  ];

  let topology: ReplicationTopology | null;
  let lag: Awaited<ReturnType<typeof getSeriesByLabel>>;
  let standby: Awaited<ReturnType<typeof getSeries>>;
  try {
    [topology, lag, standby] = await Promise.all([
      getReplicationTopology(instanceId),
      getSeriesByLabel(
        instanceId,
        'replication_replay_lag_seconds',
        'standby',
        window.minutes,
        window.bucket,
        6,
      ),
      getSeries(
        instanceId,
        ['standby_replay_delay_seconds', 'standby_pending_bytes', 'replication_standbys'],
        window.minutes,
        window.bucket,
      ),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  if (!topology) notFound();

  // On primary, all streaming peers are standbys; on standby, streamingPeers[0] is upstream.
  const standbyPeers = topology.role === 'primary' ? topology.streamingPeers : [];
  const upstreamPeer = topology.role === 'standby' ? topology.streamingPeers[0] ?? null : null;
  const slots = topology.slots;
  const inactiveSlots = slots.filter(
    (row) => row.state === 'inactive' || row.state === 'inactivo',
  );
  const worstLag = standbyPeers.reduce((peak, row) => Math.max(peak, row.lagSeconds ?? 0), 0);
  const isStandby = topology.role === 'standby';
  const standalone = topology.role === 'standalone';

  const lastPoint = standby.at(-1);
  const ownDelay = (lastPoint?.['standby_replay_delay_seconds'] as number | null | undefined) ?? null;
  const ownPending = (lastPoint?.['standby_pending_bytes'] as number | null | undefined) ?? null;

  const modeLabel =
    topology.syncMode ??
    (isStandby ? 'streaming' : standbyPeers.length > 0 ? 'streaming' : null);

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Replication · {instance.alias}</h1>
            <p className="page-sub">
              Who is primary, which standbys are connected (including other Búho-monitored nodes),
              sync mode, and lag over time — not only a snapshot.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine="postgres" />

        {standalone ? (
          <div className="notice">
            <strong>This instance has no replication configured.</strong> No connected standbys, not
            in recovery, and no slots. If it should have a replica, that is already a finding: the{' '}
            <span className="font-mono">replication_lag</span> overview check cannot warn about a
            standby that never existed.
          </div>
        ) : (
          <>
            <div className="stat-grid">
              <StatCard
                label="Role"
                value={isStandby ? 'Standby' : 'Primary'}
                tone="neutral"
                hint={
                  isStandby
                    ? 'replaying WAL'
                    : `${standbyPeers.length} standby(s) connected`
                }
              />
              <StatCard
                label="Replica type"
                value={modeLabel ?? '—'}
                tone={modeLabel === 'async' || modeLabel === 'streaming' ? 'ok' : 'neutral'}
                hint={
                  modeLabel && SYNC_MODE_HINT[modeLabel]
                    ? SYNC_MODE_HINT[modeLabel]
                    : 'from pg_stat_replication.sync_state'
                }
              />
              {!isStandby && (
                <>
                  <StatCard
                    label="Standbys"
                    value={formatNumber(standbyPeers.length)}
                    tone={standbyPeers.length === 0 ? 'warn' : 'ok'}
                    hint={`${standbyPeers.filter((p) => p.linked).length} also monitored in Búho`}
                  />
                  <StatCard
                    label="Max lag"
                    value={worstLag > 0 ? formatDuration(worstLag) : '0 s'}
                    tone={worstLag >= 60 ? 'error' : worstLag >= 10 ? 'warn' : 'ok'}
                    hint="worst standby now"
                  />
                </>
              )}
              {isStandby && (
                <>
                  <StatCard
                    label="Own delay"
                    value={ownDelay === null ? '—' : formatDuration(ownDelay)}
                    tone={
                      ownDelay === null
                        ? 'neutral'
                        : ownDelay >= 60
                          ? 'error'
                          : ownDelay >= 10
                            ? 'warn'
                            : 'ok'
                    }
                    hint="since the last applied change"
                  />
                  <StatCard
                    label="WAL not applied"
                    value={ownPending === null ? '—' : formatBytes(ownPending)}
                    tone={ownPending && ownPending > 64 * 1024 * 1024 ? 'warn' : 'ok'}
                    hint={
                      ownPending === 0 ? 'caught up: primary is idle' : 'received and pending'
                    }
                  />
                </>
              )}
              {(slots.length > 0 || !isStandby) && (
                <StatCard
                  label="Slots"
                  value={formatNumber(slots.length)}
                  tone={inactiveSlots.length > 0 ? 'error' : 'neutral'}
                  hint={
                    inactiveSlots.length > 0
                      ? `${inactiveSlots.length} inactive: retaining WAL`
                      : 'all active'
                  }
                />
              )}
              {upstreamPeer && (
                <StatCard
                  label="Receives from"
                  value={upstreamPeer.linked?.alias ?? upstreamPeer.peer}
                  tone={upstreamPeer.state === 'streaming' ? 'ok' : 'warn'}
                  hint={upstreamPeer.state ?? 'no state'}
                />
              )}
            </div>

            <TopologyPanel topology={topology} />
          </>
        )}

        {inactiveSlots.length > 0 && (
          <div className="notice notice--warn">
            <strong>
              {inactiveSlots.length} inactive slot{inactiveSlots.length === 1 ? '' : 's'}.
            </strong>{' '}
            A slot with no consumer retains WAL forever: the most common way to fill the disk of a
            healthy primary. If the consumer is not coming back,{' '}
            <span className="font-mono">pg_drop_replication_slot()</span> frees the space.
          </div>
        )}

        {!standalone && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Window</span>
            {WINDOWS.map((candidate) => (
              <a
                key={candidate.key}
                href={`/instances/${instanceId}/replication?w=${candidate.key}`}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </a>
            ))}
          </div>
        )}

        {isStandby ? (
          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <TimeseriesPanel
              title="Apply delay"
              hint={`window ${window.key} · measured on this standby`}
              data={standby}
              unit="seconds"
              height={170}
              series={[
                { metric: 'standby_replay_delay_seconds', label: 'Delay', color: '#9a4a00' },
              ]}
            />
            <TimeseriesPanel
              title="WAL received not applied"
              hint={`window ${window.key}`}
              data={standby}
              unit="bytes"
              height={170}
              series={[
                { metric: 'standby_pending_bytes', label: 'Pending apply', color: '#1f5f8b' },
              ]}
            />
          </div>
        ) : (
          !standalone && (
            <TimeseriesPanel
              title="Apply lag by standby"
              hint={`window ${window.key}`}
              data={lag.points}
              unit="seconds"
              height={190}
              series={lag.keys.map((key, index) => ({
                metric: key,
                label: chartLabel(key, topology),
                color: SERIES_COLORS[index % SERIES_COLORS.length]!,
              }))}
            />
          )
        )}

        {standbyPeers.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Standbys · {standbyPeers.length}</span>
              <span className="font-mono text-[10px] text-foreground-muted">current state</span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Standby</th>
                    <th>Monitored as</th>
                    <th>State</th>
                    <th>Type</th>
                    <th className="text-right">Bytes behind</th>
                    <th className="text-right">Seconds behind</th>
                    <th className="text-right">Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {standbyPeers.map((row) => (
                    <tr key={`${row.peer}:${row.linked?.instanceId ?? ''}`}>
                      <td className="font-mono text-[11.5px]">
                        {peerDisplayName(row)}
                        {row.clientAddr && row.linked && (
                          <div className="text-[10px] text-foreground-muted">{row.clientAddr}</div>
                        )}
                      </td>
                      <td>
                        {row.linked ? (
                          <Link
                            href={`/instances/${row.linked.instanceId}/replication`}
                            className="underline decoration-dotted"
                          >
                            {row.linked.alias}
                          </Link>
                        ) : (
                          <span className="text-[11px] text-foreground-muted">not in fleet</span>
                        )}
                      </td>
                      <td>
                        <span className={`tag ${row.state === 'streaming' ? 'tag--ok' : 'tag--warn'}`}>
                          {row.state ?? 'no state'}
                        </span>
                      </td>
                      <td className="font-mono text-[11px]">
                        {row.syncState ?? '—'}
                        {row.application ? (
                          <span className="text-foreground-muted"> · {row.application}</span>
                        ) : null}
                      </td>
                      <td className="num">{row.lagBytes === null ? '—' : formatBytes(row.lagBytes)}</td>
                      <td className="num">
                        <span
                          className={
                            (row.lagSeconds ?? 0) >= 60
                              ? 'text-[var(--error)]'
                              : (row.lagSeconds ?? 0) >= 10
                                ? 'text-[var(--warning)]'
                                : ''
                          }
                        >
                          {row.lagSeconds === null ? '—' : formatDuration(row.lagSeconds)}
                        </span>
                      </td>
                      <td className="num font-mono text-[10px] text-foreground-muted">
                        {row.capturedAt ? formatClock(row.capturedAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {slots.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Slots · {slots.length}</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                an inactive slot retains WAL until the disk fills
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>State</th>
                    <th className="text-right">WAL retained</th>
                    <th className="text-right">Seconds behind</th>
                    <th>WAL status</th>
                    <th className="text-right">Seen</th>
                  </tr>
                </thead>
                <tbody>{slots.map(slotRow)}</tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

async function ForeignReplicationPage({
  instanceId,
  engine,
}: {
  instanceId: number;
  engine: string;
}) {
  let instance;
  let inventory;
  let sankey = { nodes: [] as { name: string }[], links: [] as { source: number; target: number; value: number }[] };
  try {
    [instance, inventory] = await Promise.all([
      getInstance(instanceId),
      getInstanceInventory(instanceId),
    ]);
    if (engine === 'mariadb') {
      sankey = await getMariaReplicationSankey();
    }
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: String(instanceId) }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const rows = inventory.replication as EstateReplicationRow[];
  const instanceNotes = inventory.notes.filter((note) => note.domain === 'replication');
  const hadr = rows.find((row) => row.detail?.['kind'] === 'hadr_posture');
  const haPosture = rows.find((row) => row.detail?.['kind'] === 'ha_posture');
  const peers = rows.filter(
    (row) =>
      row.role === 'standby' ||
      row.role === 'replica' ||
      (row.role === 'availability_group' && row.peer) ||
      String(row.detail?.['kind'] ?? '').startsWith('log_shipping') ||
      String(row.detail?.['kind'] ?? '') === 'mirroring' ||
      String(row.detail?.['kind'] ?? '').startsWith('transactional'),
  );

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Replication' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Replication & HA</h1>
            <p className="page-sub">
              {ENGINE_LABEL[engine] ?? engine} · inventory snapshot
              {inventory.engine?.capturedAt ? ` · read ${formatAgo(inventory.engine.capturedAt)}` : ''}
            </p>
          </div>
          <Link href="/estate/replication" className="btn">
            Fleet replication
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Live peers"
            value={String(peers.length)}
            hint={
              engine === 'mssql'
                ? 'AG members, log shipping, mirroring'
                : engine === 'mariadb'
                  ? 'replicas / ring peers'
                  : engine === 'oracle'
                    ? 'Data Guard / standby'
                    : 'replicas / standbys'
            }
            tone={peers.length > 0 ? 'ok' : 'warn'}
          />
          <StatCard
            label="HA posture"
            value={
              hadr
                ? String(hadr.detail?.['is_hadr_enabled'] ? 'Always On ON' : 'Always On OFF')
                : haPosture
                  ? String(haPosture.detail?.['log_bin'] ? 'binlog ON' : 'binlog OFF')
                  : engine === 'oracle'
                    ? '—'
                    : '—'
            }
            hint={
              engine === 'mssql'
                ? 'SERVERPROPERTY(IsHadrEnabled)'
                : engine === 'mariadb'
                  ? '@@log_bin'
                  : engine === 'oracle'
                    ? 'v$database / Data Guard'
                    : 'replication slots'
            }
          />
          <StatCard
            label="Worst lag"
            value={
              peers.some((row) => row.lagSeconds != null)
                ? formatDuration(Math.max(...peers.map((row) => row.lagSeconds ?? 0)))
                : '—'
            }
          />
        </div>

        {instanceNotes.length > 0 ? <NotesPanel notes={instanceNotes} title="What this means" /> : null}

        {engine === 'mariadb' ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Ring / tree · Sankey</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                masters → replicas · ring drawn bipartite · lag colors the ribbon
              </span>
            </div>
            <div className="panel-body">
              <ReplicationSankey data={sankey} height={300} />
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Topology from the engine</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty">
              {engine === 'oracle'
                ? 'No Data Guard / standby inventory yet. When a standby is configured, lag and apply status appear here after the collector pass.'
                : engine === 'mssql'
                  ? 'No replication inventory yet — wait for the hourly collector pass. The next pass writes an HA posture row (Always On on/off) so this panel does not stay blank forever.'
                  : engine === 'mariadb'
                    ? 'No replication inventory yet — wait for the hourly collector pass. The next pass writes an HA posture row (e.g. binlog OFF) so this panel does not stay blank forever.'
                    : 'No replication inventory yet — wait for the hourly collector pass (slots / standbys).'}
            </div>
          ) : (
            <div className="table-scroll">
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
                  {rows.map((row, index) => (
                    <tr key={`${row.role}-${row.peer}-${index}`}>
                      <td>{row.role}</td>
                      <td className="font-mono text-[11px]">{shortPeerLabel(row.peer) || '·'}</td>
                      <td>
                        <span className="tag tag--muted" title={row.state ?? undefined}>
                          {shortProcesslistState(row.state)}
                        </span>
                      </td>
                      <td className="num">
                        {row.lagSeconds == null ? '·' : formatDuration(row.lagSeconds)}
                      </td>
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
            </div>
          )}
        </section>
      </div>
    </>
  );
}
