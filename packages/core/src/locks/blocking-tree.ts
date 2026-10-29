import type { BlockedSession } from '../blocking';

/** Minimal row shape for tree building (live sample or lock_episodes). */
export interface BlockingTreeInput {
  waiterPid: number;
  blockerPid: number | null;
  blockerPids?: number[];
  waitSeconds?: number;
  lockObject?: string | null;
  lockMode?: string | null;
  active?: boolean;
}

export interface BlockingTreeNode {
  pid: number;
  /** Direct waiters blocked by this pid. */
  children: BlockingTreeNode[];
  waitSeconds: number;
  maxWaitSeconds: number;
  lockObject: string | null;
  lockMode: string | null;
  active: boolean;
  /** True when this node repeats on the path (lock cycle). */
  cycle?: boolean;
}

export interface BlockingTreeResult {
  roots: BlockingTreeNode[];
  /** Detected pid cycles (each array is one cycle path). */
  cycles: number[][];
  /** Waiters with no blocker edge in the graph. */
  orphanWaiters: BlockingTreeNode[];
}

export interface LockHolderSummary {
  blockerPid: number;
  lockObject: string | null;
  waiterCount: number;
  activeWaiters: number;
  maxWaitSeconds: number;
}

type PidMeta = {
  waitSeconds: number;
  lockObject: string | null;
  lockMode: string | null;
  active: boolean;
};

function metaFor(
  map: Map<number, PidMeta>,
  pid: number,
  patch: Partial<PidMeta>,
): void {
  const prev = map.get(pid);
  const next: PidMeta = {
    waitSeconds: Math.max(prev?.waitSeconds ?? 0, patch.waitSeconds ?? 0),
    lockObject: patch.lockObject ?? prev?.lockObject ?? null,
    lockMode: patch.lockMode ?? prev?.lockMode ?? null,
    active: Boolean(prev?.active || patch.active),
  };
  map.set(pid, next);
}

/** Normalize BlockedSession or lock-episode rows into tree inputs. */
export function toBlockingTreeInput(row: BlockedSession | BlockingTreeInput): BlockingTreeInput {
  if ('waiterQuery' in row) {
    const s = row as BlockedSession;
    return {
      waiterPid: s.waiterPid,
      blockerPid: s.blockerPid,
      blockerPids: s.blockerPids,
      waitSeconds: s.waitSeconds,
      lockObject: s.lockObject,
      lockMode: s.lockMode,
      active: true,
    };
  }
  return row;
}

function chainEdges(input: BlockingTreeInput): Array<[blocker: number, waiter: number]> {
  const edges: Array<[number, number]> = [];
  const chain = (input.blockerPids ?? []).filter((p) => Number.isFinite(p) && p > 0);
  const immediate = input.blockerPid ?? chain[0] ?? null;
  if (immediate != null && input.waiterPid > 0) {
    edges.push([immediate, input.waiterPid]);
  }
  for (let i = 0; i < chain.length - 1; i++) {
    const waiter = chain[i]!;
    const blocker = chain[i + 1]!;
    if (waiter > 0 && blocker > 0) edges.push([blocker, waiter]);
  }
  return edges;
}

function collectEdges(rows: BlockingTreeInput[]): {
  childrenOf: Map<number, Set<number>>;
  meta: Map<number, PidMeta>;
  waiters: Set<number>;
  blockers: Set<number>;
} {
  const childrenOf = new Map<number, Set<number>>();
  const meta = new Map<number, PidMeta>();
  const waiters = new Set<number>();
  const blockers = new Set<number>();

  const addEdge = (blocker: number, waiter: number) => {
    if (blocker <= 0 || waiter <= 0 || blocker === waiter) return;
    blockers.add(blocker);
    waiters.add(waiter);
    let set = childrenOf.get(blocker);
    if (!set) {
      set = new Set();
      childrenOf.set(blocker, set);
    }
    set.add(waiter);
  };

  for (const row of rows) {
    const ws = row.waitSeconds ?? 0;
    metaFor(meta, row.waiterPid, {
      waitSeconds: ws,
      lockObject: row.lockObject ?? null,
      lockMode: row.lockMode ?? null,
      active: row.active,
    });
    waiters.add(row.waiterPid);

    const edges = chainEdges(row);
    if (edges.length === 0) continue;
    for (const [blocker, waiter] of edges) {
      addEdge(blocker, waiter);
      if (blocker === row.blockerPid) {
        metaFor(meta, blocker, {
          waitSeconds: 0,
          lockObject: row.lockObject ?? null,
          lockMode: row.lockMode ?? null,
          active: row.active,
        });
      }
    }
  }

  return { childrenOf, meta, waiters, blockers };
}

function detectCycles(childrenOf: Map<number, Set<number>>): number[][] {
  const cycles: number[][] = [];
  const visited = new Set<number>();
  const stack = new Set<number>();
  const path: number[] = [];

  const dfs = (pid: number): void => {
    visited.add(pid);
    stack.add(pid);
    path.push(pid);

    for (const child of childrenOf.get(pid) ?? []) {
      if (!visited.has(child)) {
        dfs(child);
      } else if (stack.has(child)) {
        const start = path.indexOf(child);
        if (start >= 0) cycles.push(path.slice(start).concat(child));
      }
    }

    path.pop();
    stack.delete(pid);
  };

  for (const pid of childrenOf.keys()) {
    if (!visited.has(pid)) dfs(pid);
  }
  return cycles;
}

function subtreeMaxWait(node: BlockingTreeNode): number {
  let max = node.waitSeconds;
  for (const child of node.children) {
    max = Math.max(max, subtreeMaxWait(child));
  }
  node.maxWaitSeconds = max;
  return max;
}

function buildNode(
  pid: number,
  childrenOf: Map<number, Set<number>>,
  meta: Map<number, PidMeta>,
  path: Set<number>,
): BlockingTreeNode {
  const m = meta.get(pid);
  const cycle = path.has(pid);
  path.add(pid);

  const childPids = [...(childrenOf.get(pid) ?? [])].sort((a, b) => a - b);
  const children: BlockingTreeNode[] = cycle
    ? []
    : childPids.map((c) => buildNode(c, childrenOf, meta, path));

  path.delete(pid);

  const node: BlockingTreeNode = {
    pid,
    children,
    waitSeconds: m?.waitSeconds ?? 0,
    maxWaitSeconds: 0,
    lockObject: m?.lockObject ?? null,
    lockMode: m?.lockMode ?? null,
    active: m?.active ?? false,
    cycle: cycle || undefined,
  };
  subtreeMaxWait(node);
  return node;
}

/**
 * Build blocker → waiter trees from live BlockedSession rows or lock_episodes.
 * Merges multi-hop chains via `blockerPids` and direct `blockerPid` edges.
 */
export function buildBlockingTree(
  episodes: BlockingTreeInput[] | BlockedSession[],
): BlockingTreeResult {
  const rows = episodes.map((e) => toBlockingTreeInput(e as BlockedSession | BlockingTreeInput));

  const { childrenOf, meta, waiters, blockers } = collectEdges(rows);
  const cycles = detectCycles(childrenOf);

  const rootPids = [...blockers].filter((b) => !waiters.has(b)).sort((a, b) => a - b);

  let roots: BlockingTreeNode[];
  if (rootPids.length > 0) {
    roots = rootPids.map((pid) => buildNode(pid, childrenOf, meta, new Set()));
  } else if (blockers.size > 0) {
    const start = Math.min(...blockers);
    roots = [buildNode(start, childrenOf, meta, new Set())];
  } else {
    roots = [];
  }

  const inTree = new Set<number>();
  const walk = (n: BlockingTreeNode) => {
    inTree.add(n.pid);
    n.children.forEach(walk);
  };
  roots.forEach(walk);

  const orphanWaiters: BlockingTreeNode[] = [];
  for (const w of waiters) {
    if (inTree.has(w)) continue;
    const m = meta.get(w);
    orphanWaiters.push({
      pid: w,
      children: [],
      waitSeconds: m?.waitSeconds ?? 0,
      maxWaitSeconds: m?.waitSeconds ?? 0,
      lockObject: m?.lockObject ?? null,
      lockMode: m?.lockMode ?? null,
      active: m?.active ?? false,
    });
  }
  orphanWaiters.sort((a, b) => b.waitSeconds - a.waitSeconds);

  roots.sort((a, b) => b.maxWaitSeconds - a.maxWaitSeconds);

  return { roots, cycles, orphanWaiters };
}

/** Aggregate who holds what: group by blocker pid + lock object. */
export function summarizeLockHolders(rows: BlockingTreeInput[] | BlockedSession[]): LockHolderSummary[] {
  const inputs = rows.map((e) => toBlockingTreeInput(e as BlockedSession | BlockingTreeInput));

  const byKey = new Map<string, LockHolderSummary>();

  for (const row of inputs) {
    const blocker = row.blockerPid ?? row.blockerPids?.[0] ?? null;
    if (blocker == null || blocker <= 0) continue;
    const lockObject = row.lockObject ?? null;
    const key = `${blocker}\0${lockObject ?? ''}`;
    const ws = row.waitSeconds ?? 0;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        blockerPid: blocker,
        lockObject,
        waiterCount: 1,
        activeWaiters: row.active ? 1 : 0,
        maxWaitSeconds: ws,
      });
    } else {
      prev.waiterCount += 1;
      if (row.active) prev.activeWaiters += 1;
      prev.maxWaitSeconds = Math.max(prev.maxWaitSeconds, ws);
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.waiterCount - a.waiterCount || b.maxWaitSeconds - a.maxWaitSeconds,
  );
}
