import Link from 'next/link';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { ServiceMap } from '@/components/ServiceMap';
import { getServiceMapGraph } from '@/lib/service-map';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Service map · Observability · Búho' };

export default async function ObservabilityServiceMapPage() {
  let graph;
  try {
    graph = await getServiceMapGraph();
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
        section="Map"
        title="Service map"
        sub="APM services → databases · declared + OTLP db.name (not geo)"
        actions={
          <>
            <Link className="btn" href="/observability/apm/dependencies">
              Dependencies
            </Link>
            <Link className="btn" href="/observability/apm/setup">
              Add APM
            </Link>
            <Link className="btn" href="/observability/maps">
              Geo maps
            </Link>
          </>
        }
      />
      <ServiceMap nodes={graph.nodes} edges={graph.edges} />
    </div>
  );
}
