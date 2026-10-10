/** Service-first Observability identity (APM traces ∪ HTTP probes). */

export type ObsServiceTab = 'overview' | 'uptime' | 'traces' | 'depends';

export const OBS_SERVICE_TABS: { id: ObsServiceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'uptime', label: 'Probes' },
  { id: 'traces', label: 'Traces' },
  { id: 'depends', label: 'Depends on' },
];

export function servicePath(name: string, tab?: ObsServiceTab, extra?: Record<string, string>): string {
  const base = `/observability/services/${encodeURIComponent(name)}`;
  const q = new URLSearchParams();
  if (tab && tab !== 'overview') q.set('tab', tab);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) q.set(k, v);
    }
  }
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

export function parseServiceTab(raw: string | undefined): ObsServiceTab {
  if (raw === 'uptime' || raw === 'traces' || raw === 'depends' || raw === 'overview') {
    return raw;
  }
  return 'overview';
}

/** Decode `[name]` route param (Next may already decode once). */
export function decodeServiceName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
