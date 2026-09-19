import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const CASSANDRA_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'cassandra_clients',
    title: 'Native client count',
    description: 'Connected clients from system_views.clients',
    sql: () => `SELECT count(*) AS total FROM system_views.clients`,
    evaluate: (rows) => {
      const total = num(rows[0]?.['total'] ?? rows[0]?.['count']);
      if (total < 200) return [];
      return [
        {
          severity: total >= 500 ? 'critical' : 'warning',
          object: 'clients',
          message: `${total} native clients connected.`,
          remediation: 'Audit drivers for connection leaks; raise native_transport_max_threads if needed.',
          value: total,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'cassandra_thread_pools',
    title: 'Blocked thread pools',
    description: 'Pools with blocked workers',
    sql: () => `
      SELECT name, blocked_tasks, pending_tasks
        FROM system_views.thread_pools
       WHERE blocked_tasks > 0 ALLOW FILTERING`,
    evaluate: (rows) =>
      rows.map((row) => ({
        severity: num(row['blocked_tasks']) >= 5 ? 'critical' : 'warning',
        object: String(row['name'] ?? 'pool'),
        message: `Pool ${row['name']} blocked=${num(row['blocked_tasks'])} pending=${num(row['pending_tasks'])}.`,
        remediation: 'Check compaction/GC pressure; inspect pending mutations.',
        value: num(row['blocked_tasks']),
      })),
  },
  {
    id: 'cassandra_peers',
    title: 'Cluster membership',
    description: 'Peer count from system.peers',
    sql: () => `SELECT count(*) AS peers FROM system.peers`,
    evaluate: () => [],
  },
  {
    id: 'cassandra_compaction',
    title: 'SSTable / compaction backlog',
    description: 'Active sstable_tasks',
    sql: () => `SELECT count(*) AS tasks FROM system_views.sstable_tasks`,
    evaluate: (rows) => {
      const tasks = num(rows[0]?.['tasks'] ?? rows[0]?.['count']);
      if (tasks < 5) return [];
      return [
        {
          severity: tasks >= 20 ? 'warning' : 'info',
          object: 'compaction',
          message: `${tasks} active SSTable tasks.`,
          remediation: 'Watch disk I/O; consider raising compaction throughput.',
          value: tasks,
        } satisfies Finding,
      ];
    },
  },
];
