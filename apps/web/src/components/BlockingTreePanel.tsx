import { buildBlockingTree, type BlockingTreeNode } from '@buho/core';
import { formatDuration } from '@/lib/format';
import { getLockEpisodes } from '@/lib/queries';

function TreeRow({ node, depth }: { node: BlockingTreeNode; depth: number }) {
  const pad = depth * 14;
  return (
    <>
      <li
        className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/40 py-1.5 last:border-0"
        style={{ paddingLeft: pad }}
      >
        <span className="font-mono text-[12px] font-semibold">pid {node.pid}</span>
        {node.cycle ? (
          <span className="tag tag--error text-[10px]">cycle</span>
        ) : null}
        {node.active ? (
          <span className="tag tag--error text-[10px]">LIVE</span>
        ) : null}
        {node.waitSeconds > 0 ? (
          <span className="font-mono text-[11px] text-foreground-secondary">
            wait {formatDuration(node.waitSeconds)}
          </span>
        ) : null}
        {node.lockObject ? (
          <span className="font-mono text-[11px] text-foreground-muted truncate max-w-full">
            {node.lockObject}
            {node.lockMode ? ` · ${node.lockMode}` : ''}
          </span>
        ) : null}
        {node.children.length > 0 ? (
          <span className="font-mono text-[10px] text-foreground-muted">
            → {node.children.length} waiter{node.children.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </li>
      {node.children.map((child) => (
        <TreeRow key={`${node.pid}-${child.pid}`} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

/** Multi-hop blocker → waiter forest for an instance (lock_episodes). */
export async function BlockingTreePanel({
  instanceId,
  hours = 1,
  limit = 120,
}: {
  instanceId: number;
  hours?: number;
  limit?: number;
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

  const { roots, cycles, orphanWaiters } = buildBlockingTree(inputs);

  if (episodes.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Blocking tree</span>
        </div>
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No lock episodes in the last {hours}h.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Blocking tree</span>
        <span className="tag tag--info">
          {active} active · {roots.length} root{roots.length === 1 ? '' : 's'} · {total} episodes
        </span>
      </div>
      {cycles.length > 0 ? (
        <p className="px-4 pt-3 text-[12px] text-[var(--error)]">
          Lock cycle detected:{' '}
          {cycles.map((c) => (
            <span key={c.join('-')} className="font-mono">
              {c.join(' → ')}{' '}
            </span>
          ))}
        </p>
      ) : null}
      {roots.length === 0 && orphanWaiters.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">No blocker edges in this window.</p>
      ) : (
        <ul className="list-none px-4 pb-4">
          {roots.map((root) => (
            <TreeRow key={root.pid} node={root} depth={0} />
          ))}
          {orphanWaiters.length > 0 ? (
            <li className="pt-2 text-[11px] text-foreground-muted">Waiters without a known root blocker</li>
          ) : null}
          {orphanWaiters.map((n) => (
            <TreeRow key={`orphan-${n.pid}`} node={n} depth={0} />
          ))}
        </ul>
      )}
      <p className="px-4 pb-3 font-mono text-[11px] text-foreground-secondary">
        Roots are blockers not waiting on another session in this snapshot. Chains use blocker_pids when present.
      </p>
    </section>
  );
}
