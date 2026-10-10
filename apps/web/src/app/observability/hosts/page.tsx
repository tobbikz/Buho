import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Hosts · Observability · Búho' };

/**
 * Kibana Infra “Hosts” is not a Buho Observability surface.
 * Host CPU/mem/disk live on Databases → Instance → Host (SSH/`/proc`).
 * Probe/APM fleet lives on Services.
 */
export default function ObservabilityHostsPage() {
  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Observability"
        title="Hosts (Kibana Infra)"
        sub="Not a separate Obs fleet — host metrics attach to database instances"
        actions={
          <Link className="btn btn--primary" href="/observability/services">
            Services
          </Link>
        }
      />

      <div className="notice">
        Coming from <strong>Kibana Infrastructure → Hosts</strong>? Búho splits that differently:{' '}
        <strong>Probes + APM</strong> are the Observability fleet; <strong>host OS metrics</strong>{' '}
        for a database live next to that instance under Databases (Host tab). There is no Elastic Agent
        inventory here.
      </div>

      <ObsEmpty
        title="No Kibana-style host inventory"
        actions={[
          { href: '/observability/services', label: 'Services (APM + Probes)', primary: true },
          { href: '/', label: 'Databases fleet → open instance → Host' },
          { href: '/observability/synthetics', label: 'Add probe' },
        ]}
      >
        Use <strong>Services</strong> for app/probe health, <strong>Probe metrics</strong> for HTTP/TLS
        series, and <strong>Databases → Host</strong> when you need CPU / memory / disk on the DB
        machine (requires <span className="font-mono">hostMetrics</span> on the collector target).
      </ObsEmpty>
    </div>
  );
}
