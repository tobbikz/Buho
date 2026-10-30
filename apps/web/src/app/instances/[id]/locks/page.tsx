import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { BlockingTreePanel } from '@/components/BlockingTreePanel';
import { InstanceTabs } from '@/components/InstanceTabs';
import { WhoHoldsLocks } from '@/components/WhoHoldsLocks';
import { PollWhilePending } from '@/components/PollWhilePending';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatClock, formatDuration, formatNumber } from '@/lib/format';
import { explainLock } from '@/lib/lock-reason';
import { getInstance, getLockEpisodes, getSeries, type LockEpisode } from '@/lib/queries';
import { getPlanRequest, requestPlan } from '@/lib/plans';
import { currentSession } from '@/lib/session';
import { statementKind } from '@buho/core';
import { getInstanceEngine } from '@/lib/estate';

const LOCK_PAGE_SIZE = 15;

async function explainLockQuery(formData: FormData): Promise<void> {
  'use server';
  const session = await currentSession();
  const instanceId = Number(formData.get('instanceId'));
  const episodeId = Number(formData.get('episodeId'));
  const page = String(formData.get('page') ?? '1');
  const sql = String(formData.get('sql') ?? '').trim();
  const back = `/instances/${instanceId}/locks?page=${page}&episode=${episodeId}`;
  if (!sql) redirect(`${back}&error=${encodeURIComponent('This episode has no query text to explain.')}`);
  const kind = statementKind(sql);
  if (kind === 'utilitaria') {
    redirect(`${back}&error=${encodeURIComponent('This statement has no query plan.')}`);
  }
  const requestId = await requestPlan(instanceId, sql, 'estimate', session.username, null);
  redirect(`${back}&plan=${requestId}`);
}

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

function LockTree({
  episode,
  instanceId,
  page,
  planText,
  planState,
  planError,
}: {
  episode: LockEpisode;
  instanceId: number;
  page: number;
  planText: string | null;
  planState: string | null;
  planError: string | null;
}) {
  const chain =
    episode.blockerPids.length > 1
      ? `chain of ${episode.blockerPids.length} blockers: ${episode.blockerPids.join(', ')}`
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

      <form action={explainLockQuery} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="instanceId" value={instanceId} />
        <input type="hidden" name="episodeId" value={episode.episodeId} />
        <input type="hidden" name="page" value={page} />
        <input type="hidden" name="sql" value={episode.waiterQuery} />
        <button type="submit" className="tag tag--info">
          Estimated plan
        </button>
        <span className="text-[11px] text-foreground-muted">
          EXPLAIN of the waiting query, without running it.
        </span>
      </form>
      {planError ? <p className="mt-2 text-[12px] text-[var(--error)]">{planError}</p> : null}
      {planState === 'pendiente' || planState === 'corriendo' ? (
        <p className="mt-2 text-[12px] text-foreground-secondary">Waiting for the collector to explain this query.</p>
      ) : null}
      {planText ? <pre className="query-block mt-2 whitespace-pre-wrap">{planText}</pre> : null}
    </div>
  );
}

export default async function LocksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; plan?: string; episode?: string; error?: string }>;
}) {
  const { id } = await params;
  const { page: pageParam, plan: planParam, episode: episodeParam, error: errorParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

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
  let episodeTotal = 0;
  let activeTotal = 0;
  let blocking: Awaited<ReturnType<typeof getSeries>>;
  let planText: string | null = null;
  let planState: string | null = null;
  const openEpisode = Number(episodeParam) || 0;
  try {
    const [locks, series, plan] = await Promise.all([
      getLockEpisodes(instanceId, 24, LOCK_PAGE_SIZE, (page - 1) * LOCK_PAGE_SIZE),
      getSeries(instanceId, ['blocked_sessions', 'max_blocked_seconds'], 360, 300),
      planParam ? getPlanRequest(Number(planParam)) : Promise.resolve(null),
    ]);
    episodes = locks.episodes;
    episodeTotal = locks.total;
    activeTotal = locks.active;
    blocking = series;
    if (plan && plan.instanceId === instanceId) {
      planText = plan.planText ?? plan.error;
      planState = plan.state;
    }
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
  const pageCount = Math.max(1, Math.ceil(episodeTotal / LOCK_PAGE_SIZE));
  const planFor = (episodeId: number) =>
    episodeId === openEpisode
      ? { planText, planState, planError: errorParam ?? null }
      : { planText: null, planState: null, planError: null };

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
              Episodes from the last 24 h. An episode is one session waiting on a lock, not a sample: while the
              block lasts, the same row is updated.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} blockedCount={activeTotal} />

        <div className="stat-grid">
          <StatCard
            label="Active now"
            value={formatNumber(activeTotal)}
            tone={activeTotal > 0 ? 'error' : 'ok'}
            hint={activeTotal === 0 ? 'nobody waiting on locks' : 'sessions waiting'}
          />
          <StatCard label="Episodes 24 h" value={formatNumber(episodeTotal)} tone={episodeTotal > 0 ? 'warn' : 'ok'} />
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
        <div className="chart-grid chart-grid--2">
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

        <div className="chart-grid chart-grid--2">
          <BlockingTreePanel instanceId={instanceId} hours={24} />
          <WhoHoldsLocks instanceId={instanceId} hours={24} />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Active locks</span>
            <span className="font-mono text-[10px] text-foreground-muted">blocker → waiter tree</span>
          </div>
          {active.length === 0 ? (
            <div className="empty">No session waiting on a lock right now.</div>
          ) : (
            active.map((episode) => (
              <LockTree
                key={episode.episodeId}
                episode={episode}
                instanceId={instanceId}
                page={page}
                {...planFor(episode.episodeId)}
              />
            ))
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Resolved episodes</span>
            <span className="font-mono text-[10px] text-foreground-muted">last 24 h</span>
          </div>
          {history.length === 0 ? (
            <div className="empty">No lock episodes in the last 24 h.</div>
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
                  <LockTree
                    episode={episode}
                    instanceId={instanceId}
                    page={page}
                    {...planFor(episode.episodeId)}
                  />
                </details>
              ))}
            </div>
          )}
          {pageCount > 1 ? (
            <div className="panel-body flex items-center justify-between gap-2 border-t border-border">
              <span className="font-mono text-[11px] text-foreground-muted">
                Page {page} of {pageCount}
              </span>
              <span className="flex gap-2">
                {page > 1 ? (
                  <Link href={`/instances/${instanceId}/locks?page=${page - 1}`} className="tag tag--muted">
                    Previous
                  </Link>
                ) : null}
                {page < pageCount ? (
                  <Link href={`/instances/${instanceId}/locks?page=${page + 1}`} className="tag tag--muted">
                    Next
                  </Link>
                ) : null}
              </span>
            </div>
          ) : null}
          {planState === 'pendiente' || planState === 'corriendo' ? <PollWhilePending intervalMs={2000} /> : null}
        </section>
      </div>
    </>
  );
}
