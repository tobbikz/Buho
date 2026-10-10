import Link from 'next/link';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { GeoMap } from '@/components/GeoMap';
import { listGeoPins } from '@/lib/geo-map';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Maps · Observability · Búho' };

export default async function ObservabilityMapsPage() {
  let pins;
  try {
    pins = await listGeoPins({ includeApprox: true });
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
        section="Maps"
        title="Maps"
        sub={
          <>
            Estate geography · separate from{' '}
            <Link href="/observability/map" className="underline">
              Service map
            </Link>
          </>
        }
        actions={
          <>
            <Link className="btn" href="/observability/map">
              Service map
            </Link>
            <Link className="btn" href="/observability/services">
              Services
            </Link>
          </>
        }
      />
      <GeoMap pins={pins} />
    </div>
  );
}
