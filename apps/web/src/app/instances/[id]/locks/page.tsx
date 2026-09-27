import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatClock, formatDuration, formatNumber } from '@/lib/format';
import { explainLock } from '@/lib/lock-reason';
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
          {role === 'blocker' ? 'Bloquea' : 'Espera'}
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
      ? `cadena de ${episode.blockerPids.length} bloqueadores: ${episode.blockerPids.join(', ')}`
      : null;

  const why = explainLock(episode);

  return (
    <div className="lock-tree">
      <div className="lock-why">
        {why.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`tag ${episode.active ? 'tag--error' : 'tag--muted'}`}>
          {episode.active ? 'activo' : 'resuelto'}
        </span>
        <span className="font-mono text-[12px] font-semibold">{formatDuration(episode.waitSeconds)}</span>
        <span className="text-[11.5px] text-foreground-secondary">
          esperando <span className="font-mono">{episode.lockMode ?? 'lock'}</span> sobre{' '}
          <span className="font-mono">{episode.lockObject ?? 'unknown object'}</span>
        </span>
        <span className="font-mono text-[10px] text-foreground-muted">
          desde {formatClock(episode.firstSeenAt)} · {episode.samples} muestra
          {episode.samples === 1 ? '' : 's'}
        </span>
      </div>

      {session(
        'blocker',
        episode.blockerPid,
        episode.blockerUser,
        episode.blockerApplication,
        `${episode.blockerState ?? 'estado desconocido'}${
          episode.blockerXactSeconds !== null
            ? ` · transaction open ${formatDuration(episode.blockerXactSeconds)}`
            : ''
        }`,
        episode.blockerQuery,
      )}

      <div className="lock-arrow">└─ bloquea a</div>

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
            <h1 className="page-title">Locks · {instance.alias}</h1>
            <p className="page-sub">
              Episodios de las last 24 h. Un episodio es una sesión esperando un lock, no un sampling: mientras
              el bloqueo vive se actualiza la misma fila.
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
            <div className="empty">Sin bloqueos registrados en las last 24 h.</div>
          ) : (
            <div className="lock-list">
              <div className="lock-list__head">
                <span />
                <span>Start</span>
                <span className="text-right">Duration</span>
                <span>Mode</span>
                <span>Waiter</span>
                <span>Blocker</span>
                <span>Blocked query</span>
              </div>
              {history.map((episode) => (
                <details key={episode.episodeId} className="lock-ep">
                  <summary className="lock-ep__summary">
                    <span className="sub-row__chevron" aria-hidden />
                    <span className="font-mono text-[11px] text-foreground-muted">
                      {formatClock(episode.firstSeenAt)}
                    </span>
                    <span className="text-right font-mono text-[11px]">{formatDuration(episode.waitSeconds)}</span>
                    <span className="font-mono text-[11px]">{episode.lockMode ?? '—'}</span>
                    <span className="truncate font-mono text-[11px]">
                      pid {episode.waiterPid}
                      {episode.waiterApplication ? ` · ${episode.waiterApplication}` : ''}
                    </span>
                    <span className="truncate font-mono text-[11px]">
                      {episode.blockerPid ? `pid ${episode.blockerPid}` : '—'}
                      {episode.blockerApplication ? ` · ${episode.blockerApplication}` : ''}
                    </span>
                    <span className="truncate font-mono text-[11px] text-foreground-secondary">
                      {episode.waiterQuery}
                    </span>
                  </summary>
                  <LockTree episode={episode} />
                </details>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
