import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatClock, formatDuration, formatNumber } from '@/lib/format';
import { getInstance, getLockEpisodes, getSeries, type LockEpisode } from '@/lib/queries';
import { getInstanceEngine } from '@/lib/estate';

export const dynamic = 'force-dynamic';

function session(
  role: 'blocker' | 'waiter',
  pid: number | null,
  user: string | null,
  application: string | null,
  detail: string,
  queryText: string | null,
) {
  return (
    <div className={`lock-node lock-node--${role}`}>
      <div className="lock-node__head">
        <span className="lock-node__role" style={{ color: role === 'blocker' ? 'var(--error)' : 'var(--warning)' }}>
          {role === 'blocker' ? 'Blocks' : 'Waits'}
        </span>
        <span className="font-mono text-[11px] font-semibold">pid {pid ?? '?'}</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          {user ?? '—'}
          {application ? ` · ${application}` : ''}
        </span>
        <span className="text-[10.5px]">{detail}</span>
      </div>
      <div className="query-block">{queryText?.trim() || '(no query text)'}</div>
    </div>
  );
}

function LockTree({ episode }: { episode: LockEpisode }) {
  const chain =
    episode.blockerPids.length > 1
      ? `chain of ${episode.blockerPids.length} blockers: ${episode.blockerPids.join(', ')}`
      : null;

  return (
    <div className="lock-tree">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`tag ${episode.active ? 'tag--error' : 'tag--muted'}`}>
          {episode.active ? 'active' : 'resolved'}
        </span>
        <span className="font-mono text-[12px] font-semibold">{formatDuration(episode.waitSeconds)}</span>
        <span className="text-[11.5px] text-foreground-secondary">
          waiting for <span className="font-mono">{episode.lockMode ?? 'lock'}</span> on{' '}
          <span className="font-mono">{episode.lockObject ?? 'unknown object'}</span>
        </span>
        <span className="font-mono text-[10px] text-foreground-muted">
          since {formatClock(episode.firstSeenAt)} · {episode.samples} sample
          {episode.samples === 1 ? '' : 's'}
        </span>
      </div>

      {session(
        'blocker',
        episode.blockerPid,
        episode.blockerUser,
        episode.blockerApplication,
        `${episode.blockerState ?? 'unknown state'}${
          episode.blockerXactSeconds !== null
            ? ` · transaction open ${formatDuration(episode.blockerXactSeconds)}`
            : ''
        }`,
        episode.blockerQuery,
      )}

      <div className="lock-arrow">└─ blocks</div>

      {session(
        'waiter',
        episode.waiterPid,
        episode.waiterUser,
        episode.waiterApplication,
        `${episode.waiterDatabase ?? '—'}${episode.waitEvent ? ` · ${episode.waitEvent}` : ''}`,
        episode.waiterQuery,
      )}

      {chain && <div className="text-[11px] text-foreground-muted">{chain}</div>}
    </div>
  );
}

export default async function LocksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();
  // Estas pantallas leen vistas de PostgreSQL. Si alguien llega acá con la URL
  // de un MariaDB o un SQL Server, se lo devuelve a su inventario en vez de
  // mostrarle paneles vacíos que parecen un fallo.
  const engineKind = await getInstanceEngine(instanceId);
  // Bloqueos, métricas, consultas y log existen en los tres motores desde la
  // paridad; sólo Vacuum, Host y Replicación siguen siendo de PostgreSQL.
  const engine = engineKind ?? 'postgres';


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

  let episodes: LockEpisode[];
  let blocking: Awaited<ReturnType<typeof getSeries>>;
  try {
    [episodes, blocking] = await Promise.all([
      getLockEpisodes(instanceId, 24, 60),
      getSeries(instanceId, ['blocked_sessions', 'max_blocked_seconds'], 360, 300),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar
          crumbs={[{ label: 'Fleet', href: '/' }, { label: instance.alias, href: `/instances/${instanceId}` }, { label: 'Locks' }]}
        />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const active = episodes.filter((episode) => episode.active);
  const history = episodes.filter((episode) => !episode.active);
  const worst = episodes.reduce((peak, episode) => Math.max(peak, episode.waitSeconds), 0);

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Locks' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">
              {engine === 'mongodb'
                ? `Lock waiters · ${instance.alias}`
                : engine === 'redis'
                  ? `Blocked clients · ${instance.alias}`
                  : engine === 'elasticsearch'
                    ? `Allocation pressure · ${instance.alias}`
                    : `Locks · ${instance.alias}`}
            </h1>
            <p className="page-sub">
              {engine === 'mongodb' ? (
                <>
                  Global lock queue and ops with <span className="font-mono">waitingForLock</span> from{' '}
                  <span className="font-mono">currentOp</span> / serverStatus. Episodes last 24 h.
                </>
              ) : engine === 'redis' ? (
                <>
                  Clients blocked on <span className="font-mono">BLPOP</span> / modules /{' '}
                  <span className="font-mono">BUSY</span> — from INFO clients. Episodes last 24 h.
                </>
              ) : engine === 'elasticsearch' ? (
                <>
                  Cluster allocation / pending-task pressure (not SQL row locks). Episodes last 24 h.
                </>
              ) : (
                <>
                  Episodes from the last 24 h. An episode is a session waiting on a lock — not a sample: the same
                  row updates while the wait is alive.
                </>
              )}
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={active.length} />

        <div className="stat-grid">
          <StatCard
            label="Active now"
            value={formatNumber(active.length)}
            tone={active.length > 0 ? 'error' : 'ok'}
            hint={active.length === 0 ? 'nobody waiting on locks' : 'sessions waiting'}
          />
          <StatCard label="Episodes 24 h" value={formatNumber(episodes.length)} tone={episodes.length > 0 ? 'warn' : 'ok'} />
          <StatCard
            label="Max wait"
            value={worst > 0 ? formatDuration(worst) : '—'}
            tone={worst >= 60 ? 'error' : worst > 0 ? 'warn' : 'ok'}
            hint="in the 24 h window"
          />
          <StatCard
            label="Last episode"
            value={episodes[0] ? formatAgo(episodes[0].lastSeenAt) : '—'}
            tone="neutral"
          />
        </div>

        {/* Dos paneles y no uno: sessions y segundos no comparten eje. */}
        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <TimeseriesPanel
            title="Blocked sessions"
            hint="window 6 h"
            data={blocking}
            unit="count"
            height={150}
            series={[{ metric: 'blocked_sessions', label: 'Blocked sessions', color: '#b01818' }]}
          />
          <TimeseriesPanel
            title="Max wait"
            hint="window 6 h"
            data={blocking}
            unit="seconds"
            height={150}
            series={[{ metric: 'max_blocked_seconds', label: 'Max wait', color: '#9a4a00' }]}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Active locks</span>
            <span className="font-mono text-[10px] text-foreground-muted">blocker → waiter tree</span>
          </div>
          {active.length === 0 ? (
            <div className="empty">No session waiting on a lock right now.</div>
          ) : (
            active.map((episode) => <LockTree key={episode.episodeId} episode={episode} />)
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Resolved episodes</span>
            <span className="font-mono text-[10px] text-foreground-muted">last 24 h</span>
          </div>
          {history.length === 0 ? (
            <div className="empty">No blocking episodes in the last 24 h.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Inicio</th>
                    <th className="text-right">Duration</th>
                    <th>Object</th>
                    <th>Mode</th>
                    <th>Esperaba</th>
                    <th>Bloqueaba</th>
                    <th>Blocked query</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((episode) => (
                    <tr key={episode.episodeId}>
                      <td className="font-mono text-[11px] text-foreground-muted">
                        {formatClock(episode.firstSeenAt)}
                      </td>
                      <td className="num">{formatDuration(episode.waitSeconds)}</td>
                      <td className="font-mono text-[11px]">{episode.lockObject ?? '—'}</td>
                      <td className="font-mono text-[11px] text-foreground-secondary">{episode.lockMode ?? '—'}</td>
                      <td className="font-mono text-[11px]">
                        pid {episode.waiterPid}
                        {episode.waiterApplication && (
                          <span className="text-foreground-muted"> · {episode.waiterApplication}</span>
                        )}
                      </td>
                      <td className="font-mono text-[11px]">
                        {episode.blockerPid ? `pid ${episode.blockerPid}` : '—'}
                        {episode.blockerApplication && (
                          <span className="text-foreground-muted"> · {episode.blockerApplication}</span>
                        )}
                      </td>
                      <td className="max-w-[24rem]">
                        <div className="truncate font-mono text-[11px]" title={episode.waiterQuery}>
                          {episode.waiterQuery}
                        </div>
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
