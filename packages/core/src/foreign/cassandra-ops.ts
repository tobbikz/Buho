import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import type { SessionSample } from '../sessions';
import { num, str } from './types';

/**
 * Cassandra sessions from system_views.clients (4.0+).
 */

export async function sampleCassandraSessions(client: EngineClient): Promise<SessionSample[]> {
  try {
    const rows = await client.query(`
      SELECT address, port, username, connection_stage, protocol_version,
             request_count, driver_name, driver_version, ssl_enabled
        FROM system_views.clients
       LIMIT 200`);
    return rows.map((row, index) => ({
      pid: index + 1,
      state: str(row['connection_stage'], 'ready'),
      waitEventType: null,
      waitEvent: null,
      backendType: str(row['driver_name'], 'client') || 'client',
      application: `${str(row['driver_name'], 'client')} ${str(row['driver_version'], '')}`.trim().slice(0, 120),
      username: str(row['username'], 'anonymous'),
      database: '(cluster)',
      queryid: null,
      queryMs: null,
      xactMs: null,
      blockedBy: null,
      query: `${str(row['address'], '?')}:${num(row['port'])} req=${num(row['request_count'])}${
        row['ssl_enabled'] ? ' ssl' : ''
      }`,
    }));
  } catch {
    return [];
  }
}

export async function sampleCassandraBlocking(client: EngineClient): Promise<BlockedSession[]> {
  try {
    const rows = await client.query(`
      SELECT name, blocked_tasks, pending_tasks
        FROM system_views.thread_pools
       WHERE blocked_tasks > 0 ALLOW FILTERING`);
    const pendingHeavy = await client.query(`
      SELECT name, blocked_tasks, pending_tasks
        FROM system_views.thread_pools
       WHERE pending_tasks > 100 ALLOW FILTERING`).catch(() => [] as Record<string, unknown>[]);
    const merged = new Map<string, Record<string, unknown>>();
    for (const row of [...rows, ...pendingHeavy]) {
      merged.set(str(row['name'], 'pool'), row);
    }
    return [...merged.values()].map((row, index) => ({
      waiterPid: index + 1,
      waiterQueryStart: null,
      waitSeconds: 0,
      waiterUser: '(pool)',
      waiterApplication: str(row['name'], 'pool'),
      waiterDatabase: '(cluster)',
      waiterQuery: `pool blocked=${num(row['blocked_tasks'])} pending=${num(row['pending_tasks'])}`,
      waitEventType: 'ThreadPool',
      waitEvent: str(row['name'], 'pool'),
      lockType: 'pool',
      lockMode: null,
      lockObject: str(row['name'], 'pool'),
      blockerPids: [],
      blockerPid: null,
      blockerState: null,
      blockerQuery: null,
      blockerUser: null,
      blockerApplication: null,
      blockerXactSeconds: null,
    }));
  } catch {
    return [];
  }
}
