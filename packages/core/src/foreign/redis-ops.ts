import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import type { SessionSample } from '../sessions';
import { digestToQueryid } from './statements';
import { num, str } from './types';

/**
 * Redis operational depth: CLIENT LIST → Sessions; blocked → Locks; SLOWLOG → slow events.
 */

function parseClientList(text: string): Record<string, string>[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const row: Record<string, string> = {};
      for (const part of line.split(' ')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        row[part.slice(0, eq)] = part.slice(eq + 1);
      }
      return row;
    });
}

function fingerprintCommand(cmd: string): string {
  const normalized = cmd
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

export async function sampleRedisSessions(client: EngineClient): Promise<SessionSample[]> {
  if (!client.command) return [];
  const doc = await client.command({ clientList: 1 });
  const text = str(doc['raw'], '');
  const clients = parseClientList(text);
  const samples: SessionSample[] = [];

  for (const c of clients) {
    const name = str(c['name'], '');
    const cmd = str(c['cmd'], '');
    const flags = str(c['flags'], '');
    const idle = num(c['idle']);
    const blocked = flags.includes('b');
    const state = blocked ? 'blocked' : idle > 5 ? 'idle' : cmd || 'active';

    samples.push({
      pid: num(c['id']),
      state,
      waitEventType: blocked ? 'Block' : null,
      waitEvent: blocked ? 'BLPOP/wait' : null,
      backendType: str(c['lib-name'], 'client') || 'client',
      application: (name || str(c['addr'], '(client)')).slice(0, 120),
      username: str(c['user'], 'default'),
      database: `db${str(c['db'], '0')}`,
      queryid: null,
      queryMs: idle > 0 ? idle * 1000 : null,
      xactMs: null,
      blockedBy: null,
      query: cmd ? `CMD ${cmd}` : null,
    });
  }

  return samples;
}

export async function sampleRedisBlocking(client: EngineClient): Promise<BlockedSession[]> {
  if (!client.command) return [];
  const doc = await client.command({ clientList: 1 });
  const text = str(doc['raw'], '');
  const clients = parseClientList(text).filter((c) => str(c['flags'], '').includes('b'));

  return clients.map((c) => ({
    waiterPid: num(c['id']),
    waiterQueryStart: null,
    waitSeconds: Math.max(0, num(c['idle'])),
    waiterUser: str(c['user'], 'default'),
    waiterApplication: str(c['name'], '') || str(c['addr'], '') || null,
    waiterDatabase: `db${str(c['db'], '0')}`,
    waiterQuery: `CMD ${str(c['cmd'], 'blocked')}`,
    waitEventType: 'Block',
    waitEvent: 'client-block',
    lockType: 'list/stream',
    lockMode: null,
    lockObject: null,
    blockerPids: [],
    blockerPid: null,
    blockerState: null,
    blockerQuery: null,
    blockerUser: null,
    blockerApplication: null,
    blockerXactSeconds: null,
  }));
}

/** SLOWLOG entries ≥ threshold → statement_slow_events shape. */
export async function sampleRedisSlowlog(
  client: EngineClient,
  minDurationUs = 1_000_000,
): Promise<
  {
    queryid: string;
    database: string | null;
    username: string | null;
    query: string;
    truncated: boolean;
    durationSec: number;
    rowsSent: number;
    rowsExamined: number;
    source: string;
  }[]
> {
  if (!client.command) return [];
  const doc = await client.command({ slowlogGet: 1, count: 64 });
  const entries = Array.isArray(doc['entries'])
    ? (doc['entries'] as Record<string, unknown>[])
    : [];
  const out = [];
  for (const entry of entries) {
    const durationUs = num(entry['duration_us']);
    if (durationUs < minDurationUs) continue;
    const command = str(entry['command'], '(empty)');
    const digest = fingerprintCommand(command);
    out.push({
      queryid: digestToQueryid(digest),
      database: 'redis',
      username: null,
      query: command,
      truncated: command.length >= 2000,
      durationSec: durationUs / 1_000_000,
      rowsSent: 0,
      rowsExamined: 0,
      source: 'slowlog',
    });
  }
  return out;
}

/** Commandstats rows shaped for ForeignStatementTracker. */
export async function sampleRedisCommandstats(
  client: EngineClient,
): Promise<Record<string, unknown>[]> {
  if (!client.command) return [];
  const doc = await client.command({ info: 'commandstats' });
  const rows: Record<string, unknown>[] = [];
  for (const [key, raw] of Object.entries(doc)) {
    if (!key.startsWith('cmdstat_') || typeof raw !== 'string') continue;
    const cmd = key.slice('cmdstat_'.length);
    const calls = Number(/calls=(\d+)/.exec(raw)?.[1] ?? 0);
    const usec = Number(/usec=(\d+)/.exec(raw)?.[1] ?? 0);
    if (calls <= 0) continue;
    rows.push({
      digest: fingerprintCommand(cmd),
      db: 'redis',
      query: `CMD ${cmd}`,
      truncated: false,
      calls,
      exec_ms: usec / 1000,
      rows_sent: 0,
      rows_examined: 0,
      tmp_disk_tables: 0,
      no_index_used: 0,
      full_joins: 0,
    });
  }
  rows.sort((a, b) => num(b['exec_ms']) - num(a['exec_ms']));
  return rows.slice(0, 100);
}
