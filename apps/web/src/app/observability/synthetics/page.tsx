import Link from 'next/link';
import { EndpointDiscover } from '@/components/EndpointDiscover';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { ProbeKindPanel } from '@/components/ProbeKindPanel';
import { StoreError } from '@/components/StoreError';
import {
  endpointAvailabilityHistogram,
  listAllEndpointPathLatencySparks,
  listEndpointMonitors,
  listEndpointPathDocuments,
} from '@/lib/endpoints';
import { listServiceDeps } from '@/lib/traces';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Probes · Búho' };

export default async function ObservabilitySyntheticsMonitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ db?: string }>;
}) {
  const { db: dbAlias } = await searchParams;
  let monitors;
  let documents;
  let histogram;
  let deps;
  let pathSparks: Record<string, number[]> = {};
  try {
    [monitors, documents, histogram, deps, pathSparks] = await Promise.all([
      listEndpointMonitors(),
      listEndpointPathDocuments(300),
      endpointAvailabilityHistogram(60, 60),
      listServiceDeps(),
      listAllEndpointPathLatencySparks(60, 24),
    ]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Probes"
        title={monitors.length > 0 ? 'Probes' : 'Add probe'}
        sub="HTTP · TCP · ICMP · Journey (HTTP steps) · not APM · host metrics stay on Databases"
        actions={
          <>
            <Link className="btn" href="/observability/synthetics/tls">
              TLS
            </Link>
            <Link className="btn" href="/observability/apm/setup">
              Add APM
            </Link>
            <Link className="btn" href="/observability/services?lens=probes">
              Services · PROBES
            </Link>
          </>
        }
      />
      <ProbeKindPanel />
      <EndpointDiscover
        defaultBaseUrl="http://127.0.0.1:3100"
        monitors={monitors.map((m) => ({
          ...m,
          lastSeenAt: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
        }))}
        documents={documents.map((d) => ({
          ...d,
          ts: d.ts ? d.ts.toISOString() : null,
        }))}
        histogram={histogram}
        deps={deps}
        pathSparks={pathSparks}
        initialDbAlias={dbAlias?.trim() || null}
      />
    </div>
  );
}
