/** Short DBA-facing explanations for wait families (hover / legend). */
export const WAIT_TYPE_HELP: Record<string, string> = {
  CPU: 'Not waiting: actively computing. If it dominates, the bottleneck is CPU or a missing index.',
  Lock: 'Waiting on a lock from another transaction. Fix by shortening transactions, not with hardware.',
  LWLock: 'Internal server contention, usually buffers or WAL under high concurrency.',
  IO: 'Waiting on disk. If it dominates, either cache memory is short or storage cannot keep up.',
  Client: 'Waiting on the application, not the server. Often a slow-fetching client.',
  IPC: 'Waiting on another server process, typically parallel queries or replication.',
  Timeout: 'Scheduled wait, such as a sleep or retry interval.',
  BufferPin: 'Waiting to access a buffer page another backend is using.',
  Extension: 'Waiting inside an extension.',
  Activity: 'Idle background processes. Normal and not a problem.',
  Other:
    'Wait that does not fit known families. In MariaDB State is free text; in SQL Server, an uncommon wait_type.',
};

export function waitHelp(type: string | null | undefined): string {
  if (!type) return WAIT_TYPE_HELP.CPU!;
  return WAIT_TYPE_HELP[type] ?? WAIT_TYPE_HELP.Other!;
}
