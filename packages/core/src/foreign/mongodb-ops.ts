import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import type { SessionSample } from '../sessions';
import type { Sample } from '../types';
import { num, str } from './types';

/**
 * MongoDB operational depth: currentOp sessions, lock waiters, top namespaces.
 * Complements serverStatus/dbStats collectors — same SessionSample / BlockedSession
 * shapes as Maria/MSSQL so Sessions and Locks tabs work unchanged.
 */

function commandPreview(cmd: unknown): string | null {
  if (!cmd || typeof cmd !== 'object') return null;
  try {
    const text = JSON.stringify(cmd);
    return text.length > 900 ? `${text.slice(0, 897)}…` : text;
  } catch {
    return null;
  }
}

function classifyMongoOp(op: Record<string, unknown>): {
  waitType: string | null;
  waitEvent: string | null;
  state: string;
} {
  const waiting = op['waitingForLock'] === true;
  const opName = str(op['op'], 'unknown');
  if (waiting) {
    const lockType = op['lockStats'] && typeof op['lockStats'] === 'object'
      ? Object.keys(op['lockStats'] as object)[0] ?? 'lock'
      : 'lock';
    return { waitType: 'Lock', waitEvent: String(lockType), state: 'waitingForLock' };
  }
  if (opName === 'none' || op['active'] === false) {
    return { waitType: null, waitEvent: null, state: 'idle' };
  }
  // Active work without a named wait ≈ CPU / executing.
  return { waitType: null, waitEvent: null, state: opName };
}

/** Active / interesting ops from currentOp (admin). */
export async function sampleMongoSessions(client: EngineClient): Promise<SessionSample[]> {
  if (!client.command) return [];
  const doc = await client.command({
    currentOp: 1,
    active: true,
    // Include short ops so Sessions is not empty on a quiet lab; filter idle client.
    microsecs_running: { $gte: 0 },
  });
  const inprog = Array.isArray(doc['inprog']) ? (doc['inprog'] as Record<string, unknown>[]) : [];
  const samples: SessionSample[] = [];

  for (const op of inprog) {
    // Skip internal idle threads and our own monitor connection noise when possible.
    const desc = str(op['desc'], '');
    const opName = str(op['op'], '');
    if (opName === 'none' && !op['waitingForLock']) continue;
    if (desc.includes('WTCheckpointThread') || desc.includes('WTJournalFlusher')) continue;

    const { waitType, waitEvent, state } = classifyMongoOp(op);
    const secs = num(op['secs_running']);
    const micros = num(op['microsecs_running']);
    const queryMs = micros > 0 ? micros / 1000 : secs * 1000;
    const ns = str(op['ns'], '');
    const db = ns.includes('.') ? ns.split('.')[0]! : str(op['$db'], '(admin)');
    const clientAddr = str(op['client'], str(op['client_s'], '(internal)'));
    const app = str(op['appName'], clientAddr === '(internal)' ? '(internal)' : '(client)');

    const effective = Array.isArray(op['effectiveUsers'])
      ? (op['effectiveUsers'] as { user?: string }[])
      : [];
    const username = effective[0]?.user ? String(effective[0].user) : '(mongo)';

    samples.push({
      pid: num(op['opid']),
      state,
      waitEventType: waitType,
      waitEvent,
      backendType: desc || 'client',
      application: app.slice(0, 120),
      username,
      database: db || '(admin)',
      queryid: null,
      queryMs: queryMs > 0 ? queryMs : null,
      xactMs: null,
      blockedBy: null,
      query: commandPreview(op['command'] ?? op['query']),
    });
  }

  return samples;
}

/**
 * Ops waiting on locks → BlockedSession episodes.
 * Mongo does not always expose the holder PID; blocker fields may be null.
 */
export async function sampleMongoBlocking(client: EngineClient): Promise<BlockedSession[]> {
  if (!client.command) return [];
  const doc = await client.command({
    currentOp: 1,
    waitingForLock: true,
  });
  const inprog = Array.isArray(doc['inprog']) ? (doc['inprog'] as Record<string, unknown>[]) : [];

  return inprog.map((op) => {
    const secs = Math.max(0, num(op['secs_running']));
    const ns = str(op['ns'], 'unknown');
    const lockKeys =
      op['lockStats'] && typeof op['lockStats'] === 'object'
        ? Object.keys(op['lockStats'] as object)
        : [];
    return {
      waiterPid: num(op['opid']),
      waiterQueryStart: null,
      waitSeconds: secs,
      waiterUser: '(mongo)',
      waiterApplication: op['appName'] ? str(op['appName']) : null,
      waiterDatabase: ns.includes('.') ? ns.split('.')[0]! : ns,
      waiterQuery: commandPreview(op['command']) ?? '(no command)',
      waitEventType: 'Lock',
      waitEvent: lockKeys[0] ?? 'waitingForLock',
      lockType: lockKeys[0] ?? 'Global',
      lockMode: null,
      lockObject: ns,
      blockerPids: [],
      blockerPid: null,
      blockerState: null,
      blockerQuery: null,
      blockerUser: null,
      blockerApplication: null,
      blockerXactSeconds: null,
    };
  });
}

/** Count of active / waiting / slow ops for Overview gauges. */
export async function sampleMongoCurrentOpMetrics(client: EngineClient): Promise<Sample[]> {
  if (!client.command) return [];
  try {
    const doc = await client.command({ currentOp: 1, active: true });
    const inprog = Array.isArray(doc['inprog']) ? (doc['inprog'] as Record<string, unknown>[]) : [];
    let active = 0;
    let waiting = 0;
    let slow = 0;
    let longestSec = 0;
    for (const op of inprog) {
      if (str(op['op'], '') === 'none' && !op['waitingForLock']) continue;
      active += 1;
      if (op['waitingForLock'] === true) waiting += 1;
      const secs = num(op['secs_running']);
      if (secs >= 1) slow += 1;
      if (secs > longestSec) longestSec = secs;
    }
    return [
      { metric: 'mongo_ops_active', value: active },
      { metric: 'mongo_ops_waiting_lock', value: waiting },
      { metric: 'mongo_ops_slow', value: slow },
      { metric: 'mongo_ops_longest_seconds', value: longestSec },
      { metric: 'blocked_sessions', value: waiting },
    ];
  } catch {
    return [];
  }
}

/**
 * Hot namespaces from the `top` command (cumulative time → use as counter).
 * Labels: database + collection (ns split).
 */
export async function sampleMongoTop(client: EngineClient): Promise<Sample[]> {
  if (!client.command) return [];
  try {
    const doc = await client.command({ top: 1 });
    const totals = (doc['totals'] as Record<string, unknown> | undefined) ?? {};
    const samples: Sample[] = [];
    const scored: { ns: string; total: number; read: number; write: number }[] = [];

    for (const [ns, raw] of Object.entries(totals)) {
      if (ns === 'note' || typeof raw !== 'object' || !raw) continue;
      const row = raw as Record<string, unknown>;
      const total = num((row['total'] as Record<string, unknown> | undefined)?.['time']);
      const read = num((row['readLock'] as Record<string, unknown> | undefined)?.['time']);
      const write = num((row['writeLock'] as Record<string, unknown> | undefined)?.['time']);
      if (total <= 0 && read <= 0 && write <= 0) continue;
      scored.push({ ns, total: total || read + write, read, write });
    }

    scored.sort((a, b) => b.total - a.total);
    for (const row of scored.slice(0, 20)) {
      const [database, collection] = row.ns.includes('.')
        ? [row.ns.slice(0, row.ns.indexOf('.')), row.ns.slice(row.ns.indexOf('.') + 1)]
        : [row.ns, '(db)'];
      const labels = { schema: database, table: collection, database };
      samples.push({
        metric: 'mongo_ns_total_time',
        value: row.total,
        labels,
        counter: true,
      });
      samples.push({
        metric: 'mongo_ns_read_time',
        value: row.read,
        labels,
        counter: true,
      });
      samples.push({
        metric: 'mongo_ns_write_time',
        value: row.write,
        labels,
        counter: true,
      });
    }
    return samples;
  } catch {
    return [];
  }
}
