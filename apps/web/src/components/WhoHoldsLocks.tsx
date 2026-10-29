import { summarizeLockHolders } from '@buho/core';
import { formatDuration } from '@/lib/format';
import { getLockEpisodes } from '@/lib/queries';

/** Top blockers by waiter count and max wait (lock object grain). */
export async function WhoHoldsLocks({
  instanceId,
  hours = 24,
  limit = 200,
  top = 12,
}: {
  instanceId: number;
  hours?: number;
  limit?: number;
  top?: number;
}) {
  const { episodes, active, total } = await getLockEpisodes(instanceId, hours, limit, 0).catch(() => ({
    episodes: [],
    active: 0,
    total: 0,
  }));

  const inputs = episodes.map((ep) => ({
    waiterPid: ep.waiterPid,
    blockerPid: ep.blockerPid,
    blockerPids: ep.blockerPids,
    waitSeconds: ep.waitSeconds,
    lockObject: ep.lockObject,
    lockMode: ep.lockMode,
    active: ep.active,
  }));

  const holders = summarizeLockHolders(inputs).slice(0, top);

  if (holders.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Who holds what</span>
        </div>
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No blocker → waiter pairs in the last {hours}h ({total} episodes scanned).
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Who holds what</span>
        <span className="tag tag--info">
          {active} active waiters · top {holders.length}
        </span>
      </div>
      <div className="overflow-x-auto px-4 pb-4">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="font-mono text-[11px] text-foreground-muted">
              <th className="pb-2 pr-3 font-normal">Blocker</th>
              <th className="pb-2 pr-3 font-normal">Lock object</th>
              <th className="pb-2 pr-3 font-normal text-right">Waiters</th>
              <th className="pb-2 pr-3 font-normal text-right">Active</th>
              <th className="pb-2 font-normal text-right">Max wait</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((h) => (
              <tr key={`${h.blockerPid}-${h.lockObject ?? ''}`} className="border-t border-border/40">
                <td className="py-1.5 pr-3 font-mono text-[12px]">pid {h.blockerPid}</td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-foreground-secondary max-w-[14rem] truncate">
                  {h.lockObject ?? '(unknown)'}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[12px] text-right">{h.waiterCount}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px] text-right">{h.activeWaiters}</td>
                <td className="py-1.5 font-mono text-[12px] text-right">{formatDuration(h.maxWaitSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 pb-3 font-mono text-[11px] text-foreground-secondary">
        Grouped by immediate blocker pid and lock object from lock_episodes ({hours}h window).
      </p>
    </section>
  );
}
