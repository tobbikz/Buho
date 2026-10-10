import { findingLane } from '@/lib/health-posture';

/** Where on-call should land from an open alert row. */
export function alertDeepLink(instanceId: number, checkId: string): { href: string; label: string } {
  const id = checkId.toLowerCase();
  if (id.includes('rpo') || id.includes('backup') || id.includes('binlog') || id.includes('archive') || id.includes('wal')) {
    return { href: `/instances/${instanceId}/backups`, label: 'Backups' };
  }
  if (id.includes('block') || id.includes('lock')) {
    return { href: `/instances/${instanceId}/locks`, label: 'Locks' };
  }
  if (id.includes('host_') || id.includes('cpu') || id.includes('memory') || id.includes('disk') || id.includes('iowait')) {
    return { href: `/instances/${instanceId}/host`, label: 'Host' };
  }
  if (id.includes('cache') || id.includes('connection') || id.includes('xid')) {
    return { href: `/instances/${instanceId}/analysis`, label: 'Analysis' };
  }
  if (findingLane(checkId) === 'posture') {
    return { href: `/instances/${instanceId}/blame`, label: 'Blame' };
  }
  return { href: `/instances/${instanceId}`, label: 'Overview' };
}
