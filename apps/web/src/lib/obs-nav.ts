/** Shared Observability nav — lives in the top navbar (sidebar retired for Obs). */

export type ObsNavLeaf = {
  href: string;
  label: string;
  badge?: string;
  match: (pathname: string) => boolean;
};

export type ObsNavItem =
  | ({ type: 'link' } & ObsNavLeaf)
  | { type: 'group'; label: string; children: ObsNavLeaf[] }
  | { type: 'section'; label: string };

function isApmTraceDetail(pathname: string): boolean {
  if (!pathname.startsWith('/observability/apm/')) return false;
  if (pathname.startsWith('/observability/apm/traces')) return false;
  if (pathname.startsWith('/observability/apm/dependencies')) return false;
  if (pathname.startsWith('/observability/apm/setup')) return false;
  return true;
}

/** Primary flat links in the Observability navbar rail. */
export const OBS_NAV_PRIMARY: ObsNavLeaf[] = [
  {
    href: '/observability/services',
    label: 'Services',
    match: (p) =>
      p === '/observability' ||
      p.startsWith('/observability/services') ||
      p.startsWith('/observability/inventory'),
  },
  {
    href: '/observability/apm/traces',
    label: 'Traces',
    match: (p) =>
      p.startsWith('/observability/apm/traces') ||
      p.startsWith('/traces') ||
      isApmTraceDetail(p),
  },
  {
    href: '/observability/apm/setup',
    label: 'Add APM',
    match: (p) => p.startsWith('/observability/apm/setup'),
  },
  {
    href: '/observability/synthetics',
    label: 'Probes',
    match: (p) =>
      (p.startsWith('/observability/synthetics') &&
        !p.startsWith('/observability/synthetics/tls')) ||
      p.startsWith('/observability/monitors'),
  },
  {
    href: '/observability/synthetics/tls',
    label: 'TLS',
    match: (p) => p.startsWith('/observability/synthetics/tls'),
  },
  {
    href: '/observability/apm/dependencies',
    label: 'Dependencies',
    match: (p) =>
      p.startsWith('/observability/apm/dependencies') || p === '/observability/apm',
  },
  {
    href: '/observability/metrics',
    label: 'Probe metrics',
    match: (p) => p.startsWith('/observability/metrics'),
  },
  {
    href: '/observability/logs',
    label: 'DB logs',
    match: (p) => p === '/observability/logs' || p.startsWith('/observability/logs/'),
  },
  {
    href: '/observability/app-logs',
    label: 'App logs',
    match: (p) => p.startsWith('/observability/app-logs'),
  },
];

export const OBS_NAV_SECURITY: ObsNavLeaf[] = [
  {
    href: '/observability/security/dashboards',
    label: 'Dashboards',
    badge: 'lab',
    match: (p) => p.startsWith('/observability/security/dashboards'),
  },
  {
    href: '/observability/security/rules',
    label: 'Rules',
    badge: 'lab',
    match: (p) => p.startsWith('/observability/security/rules'),
  },
  {
    href: '/observability/security/alerts',
    label: 'Alerts',
    badge: 'lab',
    match: (p) => p.startsWith('/observability/security/alerts'),
  },
  {
    href: '/observability/security/findings',
    label: 'Findings',
    badge: 'lab',
    match: (p) => p.startsWith('/observability/security/findings'),
  },
  {
    href: '/observability/security/cases',
    label: 'Cases',
    badge: 'lab',
    match: (p) => p.startsWith('/observability/security/cases'),
  },
  {
    href: '/observability/security/explore',
    label: 'Explore',
    badge: 'lab',
    match: (p) => p.startsWith('/observability/security/explore'),
  },
];

export const OBS_NAV_OPS: ObsNavLeaf[] = [
  {
    href: '/observability/alerts',
    label: 'App alerts',
    match: (p) => p === '/observability/alerts',
  },
  {
    href: '/observability/slos',
    label: 'SLOs',
    match: (p) => p.startsWith('/observability/slos'),
  },
  {
    href: '/observability/cases',
    label: 'App cases',
    match: (p) => p === '/observability/cases',
  },
  {
    href: '/observability/rpo',
    label: 'Probe RPO',
    match: (p) => p.startsWith('/observability/rpo'),
  },
];

export const OBS_NAV_VIEWS: ObsNavLeaf[] = [
  {
    href: '/observability/hosts',
    label: 'Hosts',
    match: (p) => p.startsWith('/observability/hosts'),
  },
  {
    href: '/observability/map',
    label: 'Service map',
    match: (p) => p === '/observability/map' || p.startsWith('/observability/map/'),
  },
  {
    href: '/observability/maps',
    label: 'Geo map',
    match: (p) => p.startsWith('/observability/maps'),
  },
];

/** Full tree (mobile drawer + legacy). */
export const OBS_SIDEBAR_NAV: ObsNavItem[] = [
  ...OBS_NAV_PRIMARY.map((l) => ({ type: 'link' as const, ...l })),
  { type: 'group', label: 'Security', children: OBS_NAV_SECURITY },
  { type: 'section', label: 'Ops' },
  ...OBS_NAV_OPS.map((l) => ({ type: 'link' as const, ...l })),
  { type: 'section', label: 'Views' },
  ...OBS_NAV_VIEWS.map((l) => ({ type: 'link' as const, ...l })),
];

/** @deprecated use OBS_NAV_PRIMARY — kept so older imports keep typechecking during migrate */
export const OBS_TOP_RAIL: ObsNavLeaf[] = OBS_NAV_PRIMARY;
