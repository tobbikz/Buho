import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import type { SessionSample } from '../sessions';
import { num, str } from './types';

/**
 * Redis operational depth: CLIENT LIST → Sessions; blocked clients → Locks.
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
    const age = num(c['age']);
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
      queryMs: idle > 0 ? idle * 1000 : age > 0 ? null : null,
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
