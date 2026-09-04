'use client';

import Link from 'next/link';
import { Sparkline } from '@/components/Sparkline';
import { formatBytes, formatDuration } from '@/lib/format';

function replicationRowKey(instanceId: number, role: string, peer: string): string {
  return `${instanceId}:${role}:${peer}`;
}

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
};

const ROLE_LABEL: Record<string, string> = {
  primary: 'Primary / HA posture',
  standby: 'Connected replica',
  upstream: 'Replicating from primary',
  replica: 'Async replica',
  slot: 'Replication slot',
  availability_group: 'Always On / AG',
};

export interface ReplicationTableRow {
  instanceId: number;
  alias: string;
  engine: string;
  role: string;
  peer: string;
  state: string | null;
  lagSeconds: number | null;
  lagBytes: number | null;
  detail: Record<string, unknown>;
  dangerous: boolean;
  streaming: boolean;
}

function lagColor(values: number[], dangerous: boolean): string {
  if (dangerous) return '#b01818';
  const recent = values.filter((value) => Number.isFinite(value));
  const peak = recent.length ? Math.max(...recent) : 0;
  if (peak > 1024 * 1024) return '#b01818';
  if (peak > 64 * 1024) return '#9a4a00';
  return '#005eb8';
}

function formatLag(row: ReplicationTableRow): string {
  const bytes = row.lagBytes ?? 0;
  if (bytes > 0 && row.lagSeconds !== null) {
    return formatDuration(row.lagSeconds);
  }
  if (bytes > 0) {
    return formatBytes(bytes);
  }
  const idle = row.detail['idle_since_last_commit'];
  if (typeof idle === 'number' && idle > 300) {
    return 'idle';
  }
  if (
    (row.role === 'upstream' || row.role === 'replica') &&
    row.state?.toLowerCase() === 'streaming'
  ) {
    return '0';
  }
  if (row.lagSeconds !== null && row.lagSeconds > 0) {
    return formatDuration(row.lagSeconds);
  }
  return '0';
}

export function ReplicationTable({
  rows,
  trends,
}: {
  rows: ReplicationTableRow[];
  trends: Record<string, number[]>;
}) {
  if (rows.length === 0) {
    return <div className="empty">No replication data yet.</div>;
  }

  return (
    <div className="table-scroll" style={{ maxHeight: 'none' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Instance</th>
            <th>Engine</th>
            <th>Role</th>
            <th>Peer</th>
            <th>State</th>
            <th>Trend</th>
            <th className="text-right">Lag</th>
            <th className="text-right">Bytes behind</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowKey = replicationRowKey(row.instanceId, row.role, row.peer);
            const trend = trends[rowKey] ?? [];
            return (
              <tr key={`${rowKey}-${index}`}>
                <td>
                  <Link href={`/instances/${row.instanceId}/replication`} className="underline decoration-dotted">
                    {row.alias}
                  </Link>
                </td>
                <td className="text-[11px] text-foreground-secondary">
                  {ENGINE_LABEL[row.engine] ?? row.engine}
                </td>
                <td>{ROLE_LABEL[row.role] ?? row.role}</td>
                <td className="font-mono text-[11px]">{row.peer || '·'}</td>
                <td>
                  <span
                    className={`tag ${
                      row.dangerous
                        ? 'tag--error'
                        : row.streaming
                          ? 'tag--ok'
                          : row.role === 'primary'
                            ? 'tag--muted'
                            : 'tag--warn'
                    }`}
                  >
                    {row.state ?? 'unknown'}
                  </span>
                </td>
                <td>
                  <Sparkline
                    values={trend}
                    color={lagColor(trend, row.dangerous)}
                    title={
                      row.role === 'upstream' || row.role === 'replica'
                        ? `WAL pending · last ${trend.length} buckets`
                        : `replay lag · last ${trend.length} buckets`
                    }
                  />
                </td>
                <td
                  className="num"
                  title={
                    row.detail['idle_since_last_commit']
                      ? 'Caught up — no commits on primary since last replay'
                      : undefined
                  }
                >
                  {formatLag(row)}
                </td>
                <td className="num">{row.lagBytes === null ? '·' : formatBytes(row.lagBytes)}</td>
                <td className="max-w-0 truncate font-mono text-[10px] text-foreground-muted">
                  {Object.entries(row.detail)
                    .filter(([, value]) => value !== null && value !== '')
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' ') || '·'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
