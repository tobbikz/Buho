import { formatDuration } from '@/lib/format';

/**
 * The stored mode is the lock the waiter asked for and was not granted.
 * The blocker still holds something that conflicts with it.
 */
const MODE_WHY: Record<string, { takenBy: string; waitsOn: string }> = {
  AccessShareLock: {
    takenBy: 'a plain read (SELECT)',
    waitsOn: 'AccessExclusiveLock — ALTER, DROP, TRUNCATE, VACUUM FULL, REINDEX or LOCK TABLE',
  },
  RowShareLock: {
    takenBy: 'SELECT FOR UPDATE or FOR SHARE',
    waitsOn: 'ExclusiveLock or AccessExclusiveLock',
  },
  RowExclusiveLock: {
    takenBy: 'INSERT, UPDATE or DELETE',
    waitsOn: 'ShareLock or stronger: CREATE INDEX, REFRESH MATERIALIZED VIEW CONCURRENTLY, or DDL',
  },
  ShareUpdateExclusiveLock: {
    takenBy: 'VACUUM, ANALYZE or CREATE INDEX CONCURRENTLY',
    waitsOn: 'another VACUUM, ANALYZE or CREATE INDEX CONCURRENTLY, or any stronger lock',
  },
  ShareLock: {
    takenBy: 'CREATE INDEX (not concurrent)',
    waitsOn: 'RowExclusiveLock or stronger — writes, or REFRESH MATERIALIZED VIEW CONCURRENTLY which holds ExclusiveLock',
  },
  ShareRowExclusiveLock: {
    takenBy: 'CREATE TRIGGER or some forms of ALTER TABLE',
    waitsOn: 'RowExclusiveLock or stronger',
  },
  ExclusiveLock: {
    takenBy: 'REFRESH MATERIALIZED VIEW CONCURRENTLY',
    waitsOn: 'almost every other lock on that object, including writes',
  },
  AccessExclusiveLock: {
    takenBy: 'ALTER, DROP, TRUNCATE, VACUUM FULL or REINDEX',
    waitsOn: 'every other lock, including an ordinary SELECT',
  },
};

export interface LockReasonInput {
  waitSeconds: number;
  lockMode: string | null;
  lockType: string | null;
  lockObject: string | null;
  waiterPid: number;
  waiterQuery: string;
  blockerPid: number | null;
  blockerState: string | null;
  blockerApplication: string | null;
  blockerUser: string | null;
  blockerXactSeconds: number | null;
}

function looksLikeRead(sql: string): boolean {
  if (/\b(insert|update|delete|merge)\b/i.test(sql)) return false;
  const head = sql.trim().replace(/^\(+/, '').slice(0, 40).toLowerCase();
  return head.startsWith('select') || head.startsWith('with') || head.startsWith('table ');
}

/** Plain-language reason this waiter could not get the lock. */
export function explainLock(episode: LockReasonInput): string[] {
  const mode = episode.lockMode ?? 'a lock';
  const object = episode.lockObject ?? 'an unknown object';
  const waited = formatDuration(episode.waitSeconds);
  const lines: string[] = [];

  if (episode.lockType === 'advisory') {
    lines.push(
      `pid ${episode.waiterPid} waited ${waited} on an advisory lock (${object}). Application code took it with pg_advisory_lock. It is not a table lock, and it stays until that session unlocks it or ends the transaction.`,
    );
  } else {
    const why = MODE_WHY[mode];
    lines.push(
      `pid ${episode.waiterPid} waited ${waited} to take ${mode} on ${object}.` +
        (why
          ? ` That mode is what ${why.takenBy} asks for. It cannot be granted while another session holds ${why.waitsOn}.`
          : ' Another session still held a lock that conflicts with it.'),
    );
    if (why && mode !== 'AccessShareLock' && mode !== 'RowShareLock' && looksLikeRead(episode.waiterQuery)) {
      lines.push(
        `The statement we captured is a read, so this ${mode} request came from something that statement called, or from an earlier command in the same transaction.`,
      );
    }
  }

  if (episode.blockerPid === null) {
    lines.push('PostgreSQL did not name a blocker pid for this wait.');
    return lines;
  }

  const who = [
    `pid ${episode.blockerPid}`,
    episode.blockerApplication,
    episode.blockerUser,
  ]
    .filter(Boolean)
    .join(' · ');
  const state = episode.blockerState ?? 'unknown state';
  const idle = state.includes('idle in transaction');

  if (idle) {
    const open =
      episode.blockerXactSeconds !== null
        ? ` for ${formatDuration(episode.blockerXactSeconds)}`
        : '';
    lines.push(
      `${who} still had the transaction open${open} (${state}). The lock is held until that transaction commits or rolls back. The statement below is whatever was current then; it may not be the command that acquired the lock.`,
    );
  } else if (state === 'active') {
    lines.push(
      `${who} was still running and held the conflicting lock. The statement below is the one that was in progress.`,
    );
  } else {
    lines.push(`${who} was in state “${state}” while this wait was sampled.`);
  }

  return lines;
}
