/**
 * Path catalogs for synthetic monitoring / base-URL analysis.
 * Not a crawler of HTML links — a deliberate route list (like Heartbeat monitors).
 */

/** Fleet console routes worth probing on a running Búho UI. */
export const BUHO_CONSOLE_PATHS: string[] = [
  '/',
  '/checks',
  '/alerts',
  '/events',
  '/flow',
  '/report',
  '/estate',
  '/estate/versions',
  '/estate/disk',
  '/estate/configuration',
  '/estate/jobs',
  '/estate/licensing',
  '/estate/replication',
  '/cluster',
  '/cluster/ha',
  '/cluster/growth',
  '/security',
  '/security/accounts',
  '/security/coverage',
  '/endpoints',
  '/traces',
  '/admin/instances',
  '/admin/alerts',
  '/admin/discovery',
  '/admin/users',
  '/admin/retention',
  '/admin/audit',
  '/get-started',
  '/login',
  '/api/admin/get-started-status',
  '/api/flow-live',
];

/** Status codes that still mean “the route exists / app answered”. */
export const DEFAULT_ANALYZE_STATUSES = [200, 204, 301, 302, 303, 307, 308, 401, 403];

export function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}
