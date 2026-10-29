/**
 * DPA-style wait taxonomy + top-SQL correlation helpers.
 */

export type WaitClass =
  | 'CPU'
  | 'IO'
  | 'Lock'
  | 'LWLock'
  | 'Network'
  | 'Client'
  | 'Timeout'
  | 'Idle'
  | 'Other';

const PG_MAP: Record<string, WaitClass> = {
  CPU: 'CPU',
  IO: 'IO',
  Lock: 'Lock',
  LWLock: 'LWLock',
  IPC: 'Network',
  Network: 'Network',
  Client: 'Client',
  Timeout: 'Timeout',
  Activity: 'Idle',
  Extension: 'Other',
  BufferPin: 'IO',
};

const MSSQL_PREFIX: Array<[RegExp, WaitClass]> = [
  [/^LCK_/i, 'Lock'],
  [/^PAGEIOLATCH_/i, 'IO'],
  [/^WRITELOG/i, 'IO'],
  [/^ASYNC_NETWORK/i, 'Network'],
  [/^SOS_SCHEDULER/i, 'CPU'],
  [/^CXPACKET|^CXCONSUMER/i, 'CPU'],
  [/^WAITFOR/i, 'Timeout'],
  [/^SLEEP_|^BROKER_/i, 'Idle'],
];

export function waitClassOf(engine: string, waitType: string, waitEvent?: string | null): WaitClass {
  const t = (waitType || '').trim();
  if (!t || t === 'Idle') return 'Idle';
  if (engine === 'postgres') {
    return PG_MAP[t] ?? (waitEvent?.startsWith('DataFile') ? 'IO' : 'Other');
  }
  // MariaDB PROCESSLIST State → same families as classifyMariaState / PG chart.
  if (engine === 'mariadb') {
    if (PG_MAP[t]) return PG_MAP[t]!;
    const lower = `${t} ${waitEvent ?? ''}`.toLowerCase();
    if (lower.includes('lock')) return 'Lock';
    if (lower.includes('sending data') || lower.includes('reading from net') || lower.includes('writing to net')) {
      return 'Client';
    }
    if (lower.includes('waiting') || lower.includes('sleep')) return 'Timeout';
    if (
      lower.includes('copying to tmp') ||
      lower.includes('sorting') ||
      lower.includes('executing') ||
      lower.includes('updating')
    ) {
      return 'CPU';
    }
    return 'Other';
  }
  if (engine === 'mssql') {
    for (const [re, cls] of MSSQL_PREFIX) {
      if (re.test(t)) return cls;
    }
    return 'Other';
  }
  return 'Other';
}

export interface WaitShareRow {
  waitType: string;
  waitEvent?: string | null;
  sessions: number;
}

export interface SqlBlameRow {
  queryid: string | number;
  waitClass: WaitClass;
  sessions: number;
}

/**
 * Naive correlation: attribute wait-class session weight to queryids seen
 * in the same sample window (caller supplies both slices).
 */
export function correlateWaitsWithSql(
  waits: WaitShareRow[],
  sessions: Array<{ queryid?: string | number | null; waitType: string; waitEvent?: string | null }>,
  engine: string,
): SqlBlameRow[] {
  const byQuery = new Map<string, SqlBlameRow>();
  for (const s of sessions) {
    if (s.queryid == null) continue;
    const cls = waitClassOf(engine, s.waitType, s.waitEvent);
    if (cls === 'Idle') continue;
    const key = String(s.queryid);
    const cur = byQuery.get(key);
    if (!cur) {
      byQuery.set(key, { queryid: s.queryid, waitClass: cls, sessions: 1 });
    } else {
      cur.sessions += 1;
    }
  }
  // If no session detail, synthesize from wait shares alone (no queryid).
  if (byQuery.size === 0) {
    for (const w of waits) {
      const cls = waitClassOf(engine, w.waitType, w.waitEvent);
      if (cls === 'Idle') continue;
      const key = `wait:${cls}:${w.waitType}`;
      byQuery.set(key, { queryid: key, waitClass: cls, sessions: w.sessions });
    }
  }
  return [...byQuery.values()].sort((a, b) => b.sessions - a.sessions);
}
