import type { EngineClient } from '../engine';
import type { BlockedSession } from '../blocking';
import type { SessionSample } from '../sessions';
import { num, str } from './types';

/**
 * Elasticsearch "sessions": current tasks from tasks.list.
 */

export async function sampleElasticsearchSessions(client: EngineClient): Promise<SessionSample[]> {
  if (!client.command) return [];
  try {
    const doc = await client.command({ es: 'tasks.list' });
    const nodes = (doc['nodes'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    const samples: SessionSample[] = [];
    let pid = 0;
    for (const [nodeId, node] of Object.entries(nodes)) {
      const tasks = (node['tasks'] as Record<string, Record<string, unknown>> | undefined) ?? {};
      for (const [taskId, task] of Object.entries(tasks)) {
        pid += 1;
        const action = str(task['action'], 'task');
        const running = num(task['running_time_in_nanos']) / 1e6;
        samples.push({
          pid,
          state: task['cancellable'] ? 'running' : 'internal',
          waitEventType: null,
          waitEvent: null,
          backendType: 'task',
          application: str(node['name'] ?? nodeId, nodeId).slice(0, 120),
          username: '(es)',
          database: str(task['description'], action).slice(0, 80),
          queryid: null,
          queryMs: running > 0 ? running : null,
          xactMs: null,
          blockedBy: null,
          query: `${action} ${taskId}`.slice(0, 900),
        });
      }
    }
    return samples;
  } catch {
    return [];
  }
}

export async function sampleElasticsearchBlocking(
  client: EngineClient,
): Promise<BlockedSession[]> {
  if (!client.command) return [];
  try {
    const health = await client.command({ es: 'cluster.health' });
    const unassigned = num(health['unassigned_shards']);
    if (unassigned <= 0) return [];
    return [
      {
        waiterPid: 1,
        waiterQueryStart: null,
        waitSeconds: 0,
        waiterUser: '(cluster)',
        waiterApplication: 'shards',
        waiterDatabase: '(cluster)',
        waiterQuery: `${unassigned} unassigned shard(s); status=${str(health['status'], '?')}`,
        waitEventType: 'Shard',
        waitEvent: 'unassigned',
        lockType: 'allocation',
        lockMode: null,
        lockObject: null,
        blockerPids: [],
        blockerPid: null,
        blockerState: null,
        blockerQuery: null,
        blockerUser: null,
        blockerApplication: null,
        blockerXactSeconds: null,
      },
    ];
  } catch {
    return [];
  }
}
