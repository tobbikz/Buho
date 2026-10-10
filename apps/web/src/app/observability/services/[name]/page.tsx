import Link from 'next/link';
import { EndpointSummary } from '@/components/EndpointSummary';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { ServiceCoverageActions } from '@/components/ServiceCoverageActions';
import { ServiceDepsFanout } from '@/components/ServiceDepEdge';
import { Sparkline } from '@/components/Sparkline';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TraceDiscover } from '@/components/TraceDiscover';
import { getObsService } from '@/lib/obs-infra';
import {
  decodeServiceName,
  OBS_SERVICE_TABS,
  parseServiceTab,
  servicePath,
  type ObsServiceTab,
} from '@/lib/obs-service';
import { getInstance } from '@/lib/queries';
import { listApmServiceDbLinks, listServiceDeps, listTraces } from '@/lib/traces';

export const dynamic = 'force-dynamic';

function ms(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v < 10) return `${v.toFixed(1)}ms`;
  return `${Math.round(v)}ms`;
}

function pct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(v >= 0.999 || v < 0.01 ? 1 : 0)}%`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const name = decodeServiceName((await params).name);
  return { title: `${name} · Services · Búho` };
}

export default async function ObservabilityServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ tab?: string; q?: string; w?: string; from?: string; to?: string }>;
}) {
  const name = decodeServiceName((await params).name);
  const sp = await searchParams;
  const tab = parseServiceTab(sp.tab);
  const pathFilter = sp.q?.trim() || '';

  let service;
  try {
    service = await getObsService(name);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }
  if (!service) {
    return (
      <div className="obs-page">
        <ObsPageHeader
          section="Services"
          title={name}
          sub={
            <Link href="/observability/services" className="underline">
              All services
            </Link>
          }
        />
        <ObsEmpty
          title="Service not found"
          actions={[
            { href: '/observability/services', label: 'All services', primary: true },
            { href: '/observability/apm/setup', label: 'Add APM' },
          ]}
        >
          No fleet row named <span className="font-mono">{name}</span> — check spelling or add APM / a probe.
        </ObsEmpty>
      </div>
    );
  }

  // Do not auto-bootstrap fake OTLP (SELECT 1) or auto-create probes on open —
  // that made every row look like APM+PROBE and polluted Traces.

  // If user asked for a tab the service lacks, fall back sensibly.
  let active: ObsServiceTab = tab;
  if (tab === 'uptime' && !service.hasUptime) active = service.hasTraces ? 'traces' : 'overview';
  if (tab === 'traces' && !service.hasTraces) active = service.hasUptime ? 'uptime' : 'overview';

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="Services"
        title={service.name}
        sub={
          <>
            <span className="text-foreground-muted">{service.subtitle}</span>
            {' · '}
            <Link href="/observability/services" className="underline">
              All services
            </Link>
          </>
        }
      />

      <div className="discover__tabs mb-3">
        {OBS_SERVICE_TABS.map((t) => {
          const disabled =
            (t.id === 'uptime' && !service.hasUptime) ||
            (t.id === 'traces' && !service.hasTraces);
          if (disabled) {
            return (
              <span
                key={t.id}
                className="discover__tab"
                style={{ opacity: 0.45, cursor: 'not-allowed' }}
                title={
                  t.id === 'uptime'
                    ? 'No HTTP probe for this service'
                    : 'No OTLP traces for this service'
                }
              >
                {t.label}
              </span>
            );
          }
          return (
            <Link
              key={t.id}
              href={servicePath(service.name, t.id)}
              className={`discover__tab ${active === t.id ? 'is-active' : ''}`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      {active === 'overview' ? <OverviewTab service={service} /> : null}
      {active === 'uptime' && service.monitorInstanceId != null ? (
        <EndpointSummary
          instanceId={service.monitorInstanceId}
          alias={service.name}
          windowMinutes={60}
          bucketSeconds={60}
          windowHint="1h"
        />
      ) : null}
      {active === 'traces' && service.hasTraces ? (
        <TracesTab name={service.name} initialQuery={pathFilter} />
      ) : null}
      {active === 'depends' ? (
        <DependsTab
          name={service.name}
          hasTraces={service.hasTraces}
          hasUptime={service.hasUptime}
        />
      ) : null}
    </div>
  );
}

function OverviewTab({
  service,
}: {
  service: NonNullable<Awaited<ReturnType<typeof getObsService>>>;
}) {
  const complete = service.hasTraces && service.hasUptime;
  return (
    <div className="space-y-3">
      <ServiceCoverageActions
        serviceName={service.name}
        hasTraces={service.hasTraces}
        hasUptime={service.hasUptime}
      />

      <div className="stat-grid">
        <StatCard
          label="Signals"
          value={
            complete
              ? 'APM + probe'
              : service.hasTraces
                ? 'APM'
                : service.hasUptime
                  ? 'Probe'
                  : '—'
          }
          hint={
            service.hasTraces
              ? 'OTLP traces'
              : 'no OTLP yet · instrument the app'
          }
          tone={service.hasTraces ? 'ok' : 'warn'}
        />
        <StatCard
          label="Typical"
          value={ms(service.p50Ms)}
          hint="p50 · lower is better"
        />
        <StatCard
          label="Worst"
          value={ms(service.p99Ms)}
          hint="p99 · higher = slower"
          tone={service.p99Ms != null && service.p99Ms >= 1000 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Best"
          value={ms(service.bestMs)}
          hint="min in window"
        />
      </div>

      <div className="stat-grid">
        <StatCard
          label={service.hasTraces ? 'Error rate' : 'Availability'}
          value={
            service.hasTraces
              ? pct(service.errorRate)
              : service.up == null
                ? pct(service.availability)
                : service.up
                  ? 'Up'
                  : 'Down'
          }
          tone={
            service.up === false || (service.errorRate != null && service.errorRate >= 0.05)
              ? 'error'
              : (service.errorRate != null && service.errorRate > 0) ||
                  (service.availability != null && service.availability < 0.99)
                ? 'warn'
                : 'ok'
          }
        />
        <StatCard
          label="Volume"
          value={String(service.throughput || '—')}
          hint={service.hasTraces ? 'traces · 1h' : 'probe samples · 1h'}
        />
        <StatCard label="Score" value={String(service.score ?? '—')} />
        <StatCard
          label="Tags"
          value={service.tags.length ? String(service.tags.length) : '—'}
          hint={service.tags.slice(0, 3).join(', ') || 'add from Services table'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Latency trend</span>
          <span className="muted text-xs">avg ms / 5m · last 1h</span>
        </div>
        <div className="panel-body">
          {service.latencySpark.length === 0 ? (
            <div className="empty">No latency samples in the last hour.</div>
          ) : (
            <Sparkline
              values={service.latencySpark}
              width={480}
              height={48}
              color={
                (service.p99Ms ?? 0) >= 1000
                  ? '#b01818'
                  : (service.p99Ms ?? 0) >= 500
                    ? '#a15c00'
                    : '#005eb8'
              }
              title={`${service.name} latency`}
            />
          )}
        </div>
      </section>

      <p className="text-xs text-foreground-muted">
        {service.hasUptime ? (
          <>
            <Link href={servicePath(service.name, 'uptime')} className="underline">
              Probes
            </Link>
            {' · probed paths & availability'}
          </>
        ) : (
          <>No HTTP probe — add one from Probes</>
        )}
        {' · '}
        {service.hasTraces ? (
          <>
            <Link href={servicePath(service.name, 'traces')} className="underline">
              Traces
            </Link>
            {' · OTLP waterfall'}
          </>
        ) : (
          <>
            No OTLP yet —{' '}
            <Link href="/observability/apm/setup" className="underline">
              Add APM
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

async function TracesTab({ name, initialQuery }: { name: string; initialQuery: string }) {
  const needle = name.toLowerCase();
  const pick = (
    rows: Awaited<ReturnType<typeof listTraces>>,
  ) => rows.filter((t) => (t.rootService ?? '(unknown)').toLowerCase() === needle);

  let windowKey: '1h' | '6h' | '24h' | 'all' = '1h';
  let filtered: Awaited<ReturnType<typeof listTraces>> = [];
  try {
    // Prefer live hour; widen so APM services quiet for a bit still open waterfalls.
    for (const [key, mins] of [
      ['1h', 60],
      ['6h', 360],
      ['24h', 1440],
      ['all', null],
    ] as const) {
      const rows = await listTraces(200, mins ?? undefined);
      const hit = pick(rows);
      if (hit.length > 0) {
        filtered = hit;
        windowKey = key;
        break;
      }
    }
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  if (filtered.length === 0) {
    return (
      <ObsEmpty
        title="No traces yet"
        actions={[
          { href: '/observability/apm/setup', label: 'Add APM', primary: true },
          {
            href: `/observability/apm/traces?service=${encodeURIComponent(name)}&w=all`,
            label: 'All traces',
          },
        ]}
      >
        No OTLP for <span className="font-mono">{name}</span> in store — hit the app or check Add APM.
      </ObsEmpty>
    );
  }
  // Probe paths must not strand the Traces tab (e.g. ?q=/traces with only GET /).
  const safeQuery =
    initialQuery &&
    !filtered.some((t) => {
      const hay = `${t.rootName ?? ''} ${t.traceId}`.toLowerCase();
      return hay.includes(initialQuery.trim().toLowerCase());
    })
      ? ''
      : initialQuery;
  return (
    <div className="flex flex-col gap-2">
      <p className="muted text-xs">
        Live lookback ({windowKey}). For a calendar / absolute range use{' '}
        <Link
          href={`/observability/apm/traces?service=${encodeURIComponent(name)}&w=${windowKey}`}
          className="underline"
        >
          Trace Discover
        </Link>
        .
      </p>
      <TraceDiscover
        initialQuery={safeQuery}
        listContext={{ service: name, w: windowKey }}
        traces={filtered.map((t) => ({
          traceId: t.traceId,
          rootService: t.rootService,
          rootName: t.rootName,
          startTs: t.startTs.toISOString(),
          durationMs: t.durationMs,
          spanCount: t.spanCount,
          errorCount: t.errorCount,
          hasSql: t.hasSql,
          httpStatus: t.httpStatus,
          httpMethod: t.httpMethod,
          dbName: t.dbName,
          sqlMs: t.sqlMs,
        }))}
      />
    </div>
  );
}

async function DependsTab({
  name,
  hasTraces,
  hasUptime,
}: {
  name: string;
  hasTraces: boolean;
  hasUptime: boolean;
}) {
  const [declared, spanLinks] = await Promise.all([
    listServiceDeps(),
    hasTraces ? listApmServiceDbLinks(null) : Promise.resolve(new Map()),
  ]);

  type Edge = {
    toInstanceId: number;
    toAlias: string;
    toEngine: string;
    toHost: string | null;
    toPort: number | null;
    fromEngine: string;
    source: 'dep' | 'span';
  };

  const byId = new Map<number, Edge>();

  for (const d of declared) {
    if (d.fromAlias !== name && d.fromService !== name) continue;
    byId.set(d.toInstanceId, {
      toInstanceId: d.toInstanceId,
      toAlias: d.toAlias,
      toEngine: d.toEngine,
      toHost: d.toHost,
      toPort: d.toPort,
      fromEngine: d.fromEngine ?? (d.fromService ? 'apm' : 'endpoint'),
      source: 'dep',
    });
  }

  for (const link of spanLinks.get(name) ?? []) {
    const existing = byId.get(link.instanceId);
    if (existing) {
      // Keep declared; note span confirmation via host refresh below.
      continue;
    }
    const inst = await getInstance(link.instanceId).catch(() => null);
    byId.set(link.instanceId, {
      toInstanceId: link.instanceId,
      toAlias: link.alias,
      toEngine: link.engine,
      toHost: inst?.host ?? null,
      toPort: inst?.port ?? null,
      fromEngine: 'apm',
      source: link.source,
    });
  }

  const edges = [...byId.values()].sort((a, b) => a.toAlias.localeCompare(b.toAlias));

  if (edges.length === 0) {
    return (
      <ObsEmpty title="No dependencies found">
        {!hasTraces ? (
          <>
            <strong>APM required</strong> to infer DB links from OTLP{' '}
            <span className="font-mono">db.name</span>. HTTP probes alone do not create Depends
            on — instrument <span className="font-mono">{name}</span> or declare{' '}
            <span className="font-mono">service_deps</span>.
          </>
        ) : (
          <>
            No <span className="font-mono">service_deps</span> and no OTLP spans with{' '}
            <span className="font-mono">db.name</span> matched to a Databases instance.
          </>
        )}{' '}
        <Link href="/observability/apm/dependencies" className="underline">
          Dependencies map
        </Link>
        {hasUptime ? null : (
          <>
            {' · '}
            <Link href="/observability/synthetics" className="underline">
              add uptime
            </Link>
          </>
        )}
      </ObsEmpty>
    );
  }

  const enriched = await Promise.all(
    edges.map(async (e) => {
      const inst = await getInstance(e.toInstanceId).catch(() => null);
      return {
        ...e,
        toHost: inst?.host ?? e.toHost,
        toPort: inst?.port ?? e.toPort,
      };
    }),
  );

  const fromEngine = enriched[0]?.fromEngine ?? (hasTraces ? 'apm' : 'endpoint');

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Depends on</span>
        <span className="muted text-xs">
          {enriched.length} DB · from{' '}
          {enriched.some((e) => e.source === 'span') ? 'OTLP db.name' : ''}
          {enriched.some((e) => e.source === 'span') && enriched.some((e) => e.source === 'dep')
            ? ' + '
            : ''}
          {enriched.some((e) => e.source === 'dep') ? 'service_deps' : ''}
        </span>
      </div>
      <div className="panel-body dep-edge-list">
        <ServiceDepsFanout
          fromAlias={name}
          fromEngine={fromEngine}
          targets={enriched.map((e) => ({
            toInstanceId: e.toInstanceId,
            toAlias: e.toAlias,
            toEngine: e.toEngine,
            toHost: e.toHost,
            toPort: e.toPort,
            source: e.source,
          }))}
        />
      </div>
    </section>
  );
}
