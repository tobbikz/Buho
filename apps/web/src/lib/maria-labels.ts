/**
 * Short DBA-facing labels for MariaDB wait / replication strings.
 * Full names stay in tooltips / raw samples; charts and tables use these.
 */

const PROCESSLIST_STATE: Record<string, string> = {
  'Slave has read all relay log; Waiting for more updates': 'Replica idle (SQL)',
  'Slave has read all relay log; waiting for more updates': 'Replica idle (SQL)',
  'Waiting for master to send event': 'Replica idle (IO)',
  'Master has sent all binlog to slave; waiting for more updates': 'Dump idle (caught up)',
  'Master has sent all binlog to Slave; waiting for more updates': 'Dump idle (caught up)',
  'Waiting for semi-sync ACK from slave': 'Semi-sync wait',
  'Waiting for room in worker thread event queue': 'Worker queue full',
  'Waiting for table metadata lock': 'Metadata lock',
  'Waiting for table level lock': 'Table lock',
  'Waiting for row lock': 'Row lock',
  'Filling schema table': 'Filling schema',
  'Sending data': 'Sending data',
  'Copying to tmp table': 'Tmp table',
  'Creating sort index': 'Sort index',
  'System lock': 'System lock',
  'executing': 'Executing',
  'Query': 'Query',
};

/** Idle replication / dump thread states — drown Wait time charts; exclude from sampling. */
export function isIdleReplicaWaitState(state: string): boolean {
  const s = state.toLowerCase();
  return (
    s.includes('waiting for more updates') ||
    s.includes('waiting for master to send event') ||
    s.includes('has sent all binlog') ||
    s.includes('waiting for semi-sync ack')
  );
}

export function shortProcesslistState(raw: string | null | undefined): string {
  if (!raw) return '·';
  const trimmed = raw.trim();
  if (PROCESSLIST_STATE[trimmed]) return PROCESSLIST_STATE[trimmed]!;
  const lower = trimmed.toLowerCase();
  for (const [key, label] of Object.entries(PROCESSLIST_STATE)) {
    if (key.toLowerCase() === lower) return label;
  }
  if (isIdleReplicaWaitState(trimmed)) {
    if (lower.includes('master to send')) return 'Replica idle (IO)';
    if (lower.includes('binlog')) return 'Dump idle (caught up)';
    return 'Replica idle';
  }
  if (trimmed.length <= 36) return trimmed;
  return `${trimmed.slice(0, 33)}…`;
}

/**
 * `wait/synch/cond/sql/MYSQL_BIN_LOG::COND_bin_log_updated` → `COND_bin_log_updated`
 * `wait/io/file/innodb/innodb_data_file` → `innodb_data_file`
 */
export function shortPsWaitEvent(raw: string | null | undefined): string {
  if (!raw) return '·';
  const trimmed = raw.trim();
  if (trimmed.includes('::')) {
    const leaf = trimmed.split('::').pop() ?? trimmed;
    return leaf.length <= 40 ? leaf : `${leaf.slice(0, 37)}…`;
  }
  const parts = trimmed.split('/');
  const leaf = parts[parts.length - 1] || trimmed;
  if (leaf.length <= 40) return leaf;
  return `${leaf.slice(0, 37)}…`;
}

export function shortPeerLabel(peer: string | null | undefined): string {
  if (!peer) return '·';
  // Hide ephemeral dump-thread client ports: 172.20.0.8:38980 → 172.20.0.8
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(peer)) return peer.split(':')[0]!;
  return peer;
}
