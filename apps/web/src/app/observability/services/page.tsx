import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsInventoryTable } from '@/components/ObsInventoryTable';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import {
  listInventoryEntities,
  type InventoryEntity,
} from '@/lib/obs-infra';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Services · Observability · Búho' };

/** Fleet lenses — same entities, different focus (not two separate products). */
export type ServiceLens = 'all' | 'apm' | 'probes';

const LENSES: { id: ServiceLens; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'unified fleet' },
  { id: 'apm', label: 'APM', hint: 'has OTLP traces' },
  { id: 'probes', label: 'PROBES', hint: 'HTTP synthetics' },
];

function parseLens(raw: string | undefined): ServiceLens {
  const v = raw?.toLowerCase();
  if (v === 'apps' || v === 'apm' || v === 'traces') return 'apm';
  if (v === 'uptime' || v === 'probes' || v === 'synthetics' || v === 'monitor') {
    return 'probes';
  }
  // Legacy ?lens=complete → All (tab removed)
  return 'all';
}

function lensToSource(lens: ServiceLens): 'all' | 'apm' | 'synthetics' {
  if (lens === 'apm') return 'apm';
  if (lens === 'probes') return 'synthetics';
  return 'all';
}

export default async function ObservabilityServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; lens?: string }>;
}) {
  const sp = await searchParams;
  // kind= kept for legacy deep links
  const lens = parseLens(sp.lens ?? sp.kind);

  let entities: InventoryEntity[];
  try {
    entities = await listInventoryEntities();
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const withTracesRecent = entities.filter((e) => e.tracesRecent1h).length;
  const withApm = entities.filter((e) => e.hasTraces).length;
  const withUptime = entities.filter((e) => e.hasUptime).length;
  const both = entities.filter((e) => e.hasTraces && e.hasUptime).length;
  const needsApm = entities.filter((e) => e.hasUptime && !e.hasTraces).length;
  const degraded = entities.filter(
    (e) =>
      e.up === false ||
      (e.errorRate != null && e.errorRate >= 0.05) ||
      (e.availability != null && e.availability < 0.99) ||
      (e.p99Ms != null && e.p99Ms >= 1000) ||
      (e.p95Ms != null && e.p95Ms >= 1000),
  ).length;

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Services"
        title="Services"
        sub={
          <>
            Fleet health · APM + Probes · DBs in{' '}
            <Link href="/" className="underline">
              Databases
            </Link>
          </>
        }
        actions={
          <>
            {/* One primary CTA: APM is the gap that completes a service; probe is secondary. */}
            <Link className="btn btn--primary" href="/observability/apm/setup">
              Add APM
            </Link>
            <Link className="btn" href="/observability/synthetics">
              Add probe
            </Link>
          </>
        }
      />

      <div className="stat-grid obs-services-kpis">
        <StatCard label="Services" value={String(entities.length)} hint="unified fleet" />
        <StatCard label="With traces" value={String(withTracesRecent)} hint="OTLP · last 1h" />
        <StatCard
          label="With probe"
          value={String(withUptime)}
          hint={both > 0 ? `${both} with both` : 'HTTP probes'}
        />
        <StatCard
          label="Needs attention"
          value={String(degraded)}
          hint={needsApm > 0 ? `${needsApm} need APM` : 'errors / down / slow'}
          tone={degraded > 0 || needsApm > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="discover__tabs mb-3">
        {LENSES.map((l) => (
          <Link
            key={l.id}
            href={
              l.id === 'all'
                ? '/observability/services'
                : `/observability/services?lens=${l.id}`
            }
            className={`discover__tab ${lens === l.id ? 'is-active' : ''}`}
            title={l.hint}
          >
            {l.label}
            <span className="text-[10px] text-foreground-muted ml-1">
              {l.id === 'all' ? entities.length : l.id === 'apm' ? withApm : withUptime}
            </span>
          </Link>
        ))}
      </div>

      {entities.length === 0 ? (
        <ObsEmpty
          title="No services yet"
          actions={[
            { href: '/observability/apm/setup', label: 'Add APM', primary: true },
            { href: '/observability/synthetics', label: 'Add probe' },
          ]}
        >
          Ingest OTLP (APM) or save an HTTP probe — both become services here.
        </ObsEmpty>
      ) : (
        <ObsInventoryTable entities={entities} initialSource={lensToSource(lens)} />
      )}
    </div>
  );
}
