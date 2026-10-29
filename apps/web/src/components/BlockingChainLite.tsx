import Link from 'next/link';
import { SessionActionButtons } from '@/components/SessionActionButtons';
import { explainLock } from '@/lib/lock-reason';
import { getLockEpisodes } from '@/lib/queries';

/** Compact blocking chain for Blame — top active / recent lock episodes. */
export async function BlockingChainLite({
  instanceId,
  alias,
  hours = 1,
  actionsEnabled = false,
}: {
  instanceId: number;
  alias: string;
  hours?: number;
  /** When true, show cancel/kill for LIVE waiter/blocker pids. */
  actionsEnabled?: boolean;
}) {
  const { episodes, active, total } = await getLockEpisodes(instanceId, hours, 8, 0).catch(() => ({
    episodes: [],
    active: 0,
    total: 0,
  }));

  if (episodes.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Blocking chain</span>
        </div>
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No lock episodes in the last {hours}h. Collector writes{' '}
          <code className="font-mono text-[12px]">lock_episodes</code> when sessions block.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Blocking chain</span>
        <span className="tag tag--info">
          {active} active · {total} in window
        </span>
      </div>
      <ul className="space-y-3 px-4 pb-4 text-[13px]">
        {episodes.map((ep) => {
          const hints = explainLock({
            waitSeconds: ep.waitSeconds,
            lockMode: ep.lockMode,
            lockType: ep.lockType,
            lockObject: ep.lockObject,
            waiterPid: ep.waiterPid,
            waiterQuery: ep.waiterQuery,
            blockerPid: ep.blockerPid,
            blockerState: ep.blockerState,
            blockerApplication: ep.blockerApplication,
            blockerUser: ep.blockerUser,
            blockerXactSeconds: ep.blockerXactSeconds,
          });
          return (
            <li
              key={ep.episodeId}
              className="border-b border-border/50 pb-2 last:border-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-[12px]">
                  waiter {ep.waiterPid}
                  {ep.blockerPid != null ? ` ← blocker ${ep.blockerPid}` : ''}
                </span>
                <span className="font-mono text-[11px] text-foreground-secondary">
                  {ep.active ? 'LIVE' : 'resolved'} · {ep.waitSeconds.toFixed(1)}s
                  {ep.lockMode ? ` · ${ep.lockMode}` : ''}
                </span>
              </div>
              {ep.lockObject ? (
                <p className="mt-0.5 font-mono text-[11px] text-foreground-secondary">
                  {ep.lockObject}
                </p>
              ) : null}
              <pre className="mt-1 max-h-16 overflow-auto rounded bg-surface-muted p-1.5 font-mono text-[11px]">
                {ep.waiterQuery.slice(0, 280)}
              </pre>
              {ep.blockerQuery ? (
                <pre className="mt-1 max-h-14 overflow-auto rounded border border-border/40 bg-transparent p-1.5 font-mono text-[11px] text-foreground-secondary">
                  blocker: {ep.blockerQuery.slice(0, 220)}
                </pre>
              ) : null}
              {hints[0] ? (
                <p className="mt-1 text-[11.5px] text-foreground-secondary">{hints[0]}</p>
              ) : null}
              {ep.active && actionsEnabled ? (
                <div className="mt-1 space-y-1">
                  {ep.blockerPid != null ? (
                    <SessionActionButtons alias={alias} pid={ep.blockerPid} role="blocker" />
                  ) : null}
                  <SessionActionButtons alias={alias} pid={ep.waiterPid} role="waiter" />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="px-4 pb-3 text-[11px] text-foreground-secondary">
        Full history on{' '}
        <Link className="underline" href={`/instances/${instanceId}/locks`}>
          Locks
        </Link>
        .
        {!actionsEnabled
          ? ' Enable actions.enabled on the instance to cancel/kill from here.'
          : ' Cancel/kill requires actions.enabled + allowCancelQuery/allowKillSession.'}
      </p>
    </section>
  );
}
