import Link from 'next/link';
import { ServiceDepEdge } from '@/components/ServiceDepEdge';
import { Sparkline } from '@/components/Sparkline';
import { StatCard } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatNumber } from '@/lib/format';
import {
  latestEndpointMetrics,
  listEndpointPathDocuments,
  listEndpointPathLatencySparks,
} from '@/lib/endpoints';
import { getFindings, getInstance, getSeries } from '@/lib/queries';
import { servicePath } from '@/lib/obs-service';
import { listApmServiceNames, listServiceDeps } from '@/lib/traces';

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
};

function pathTone(ok: number | null, ms: number | null): string {
  if (ok === 0) return 'discover-hit--down';
  if (ok === 1 && ms != null && ms >= 1500) return 'discover-hit--slow';
  if (ok === 1) return 'discover-hit--up';
  return 'discover-hit--unknown';
}

export async function EndpointSummary({
  instanceId,
  alias,
  windowMinutes,
  bucketSeconds,
  windowHint,
}: {
  instanceId: number;
  alias: string;
  windowMinutes: number;
  bucketSeconds: number;
  windowHint: string;
}) {
  const [metrics, findings, httpSeries, deps, documents, apmNames, pathSparks] =
    await Promise.all([
      latestEndpointMetrics(instanceId),
      getFindings(instanceId),
      getSeries(instanceId, ['endpoint_http_ms', 'endpoint_up'], windowMinutes, bucketSeconds),
      listServiceDeps(),
      listEndpointPathDocuments(500, instanceId),
      listApmServiceNames(null),
      listEndpointPathLatencySparks(instanceId, windowMinutes),
    ]);
  const hasApm = apmNames.has(alias);
  const myDeps = deps.filter((d) => d.fromAlias === alias);
  const depTargets = await Promise.all(
    myDeps.map(async (d) => {
      const inst = await getInstance(d.toInstanceId).catch(() => null);
      return { dep: d, host: inst?.host ?? null, port: inst?.port ?? null };
    }),
  );

  return (
    <div className="space-y-3">
      {depTargets.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Depends on</span>
            <span className="muted text-xs">
              declared dependency ·{' '}
              {depTargets[0] ? (
                <Link href={`/instances/${depTargets[0].dep.toInstanceId}`} className="underline">
                  open DB for locks / queries
                </Link>
              ) : (
                'open DB for locks / queries'
              )}
            </span>
          </div>
          <div className="panel-body dep-edge-list">
            {depTargets.map(({ dep, host, port }) => (
              <ServiceDepEdge
                key={dep.toInstanceId}
                fromAlias={alias}
                fromEngine={dep.fromEngine ?? 'endpoint'}
                toAlias={dep.toAlias}
                toEngine={dep.toEngine}
                toInstanceId={dep.toInstanceId}
                toHost={host}
                toPort={port}
              />
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Availability"
          value={
            metrics.up === 0
              ? 'Down'
              : metrics.up === 1 && metrics.httpMs != null && metrics.httpMs >= 1500
                ? 'Slow'
                : metrics.up === 1
                  ? 'Up'
                  : '—'
          }
          tone={
            metrics.up === 0
              ? 'error'
              : metrics.up === 1 && metrics.httpMs != null && metrics.httpMs >= 1500
                ? 'warn'
                : metrics.up === 1
                  ? 'ok'
                  : 'neutral'
          }
        />
        <StatCard
          label="HTTP latency"
          value={metrics.httpMs == null ? '—' : `${formatNumber(metrics.httpMs)} ms`}
          tone={
            metrics.httpMs == null
              ? 'neutral'
              : metrics.httpMs > 2000
                ? 'error'
                : metrics.httpMs > 500
                  ? 'warn'
                  : 'ok'
          }
        />
        <StatCard
          label="HTTP status"
          value={String(metrics.httpStatus ?? '—')}
          tone={
            metrics.httpStatus == null
              ? 'neutral'
              : metrics.httpStatus >= 500
                ? 'error'
                : metrics.httpStatus >= 400
                  ? 'warn'
                  : 'ok'
          }
        />
        <StatCard
          label="Paths"
          value={String(documents.length || '—')}
          tone={documents.length > 0 ? 'ok' : 'neutral'}
        />
      </div>

      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
          <span className="panel-title">Probed paths</span>
          <span className="muted text-xs">
            {documents.length} paths · HTTP probes (not APM traces)
          </span>
          {hasApm ? (
            <Link
              href={servicePath(alias, 'traces')}
              className="btn"
              style={{ marginLeft: 'auto', fontSize: '11px', padding: '0.2rem 0.5rem' }}
              title="APM waterfalls for this service — no path filter"
            >
              Open traces
            </Link>
          ) : (
            <Link
              href="/observability/apm/setup"
              className="btn btn--primary"
              style={{ marginLeft: 'auto', fontSize: '11px', padding: '0.2rem 0.5rem' }}
              title="Probe is up — add OTLP / eBPF for waterfalls"
            >
              Add APM
            </Link>
          )}
        </div>
        {documents.length > 0 && (
          <div
            className="trace-legend"
            role="group"
            aria-label="Row color legend"
            style={{ padding: '0.35rem 0.75rem 0' }}
          >
            <span className="trace-legend__item">
              <i className="trace-legend__swatch trace-legend__swatch--ok" />
              Up
            </span>
            <span className="trace-legend__item">
              <i className="trace-legend__swatch" style={{ background: 'var(--warning)' }} />
              Slow
            </span>
            <span className="trace-legend__item">
              <i className="trace-legend__swatch trace-legend__swatch--err" />
              Down
            </span>
          </div>
        )}
        <div className="panel-body p-0 discover__docs-embed">
          {documents.length === 0 ? (
            <div className="empty">
              No per-path samples yet. Wait for the next collector probe (~30s), or re-save paths
              from Analyze.
            </div>
          ) : (
            documents.map((d) => {
              // Probe rows stay probe-only — never link to Traces (path ≠ OTLP route).
              // Complement is the header CTA: Open traces (if APM) or Add APM.
              const sparkRaw = pathSparks.get(d.path) ?? [];
              const spark =
                sparkRaw.length === 1
                  ? [sparkRaw[0]!, sparkRaw[0]!]
                  : sparkRaw.length === 0 && d.httpMs != null
                    ? [d.httpMs, d.httpMs]
                    : sparkRaw;
              return (
                <article
                  key={d.path}
                  className={`discover-hit ${pathTone(d.httpOk, d.httpMs)}`}
                  title={
                    d.httpOk === 0
                      ? 'Down — probe did not get an expected response'
                      : d.httpMs != null && d.httpMs >= 1500
                        ? 'Slow — responding but latency ≥ 1.5s'
                        : 'Up — HTTP probe OK'
                  }
                >
                  <div className="discover-hit__bar" aria-hidden />
                  <div className="discover-hit__body">
                    <div className="discover-hit__meta discover-hit__meta--path">
                      <span className="tag tag--muted">{d.httpStatus ?? '—'}</span>
                      <span className="discover-hit__path font-mono text-[12px] font-medium">
                        {d.path}
                      </span>
                      <span className="discover-hit__spark" title="Latency trend">
                        <Sparkline
                          values={spark}
                          width={72}
                          height={20}
                          color={
                            d.httpOk === 0
                              ? '#b01818'
                              : d.httpMs != null && d.httpMs >= 1500
                                ? '#a15c00'
                                : '#005eb8'
                          }
                        />
                      </span>
                      <span className="discover-hit__ms num text-foreground-muted">
                        {d.httpMs == null ? '—' : `${Math.round(d.httpMs)} ms`}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>

      <TimeseriesPanel
        title="HTTP latency"
        hint={windowHint}
        data={httpSeries}
        unit="ms"
        series={[{ metric: 'endpoint_http_ms', label: 'HTTP ms', color: COLOR.accent }]}
      />
      <TimeseriesPanel
        title="Availability"
        hint={windowHint}
        data={httpSeries}
        unit="count"
        series={[{ metric: 'endpoint_up', label: 'Up (0/1)', color: COLOR.success }]}
      />

      {findings.length > 0 && (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Checks</span>
            <span className="muted text-xs">{findings.length}</span>
          </div>
          <div className="panel-body space-y-1 text-sm">
            {findings.map((f) => (
              <div key={`${f.checkId}-${f.object ?? ''}`} className="flex flex-wrap gap-2">
                <span
                  className={`tag ${
                    f.severity === 'critical'
                      ? 'tag--error'
                      : f.severity === 'warning'
                        ? 'tag--warn'
                        : 'tag--info'
                  }`}
                >
                  {f.severity}
                </span>
                <span>{f.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-xs text-foreground-muted">
        Probes = external HTTP checks. Traces = in-app OTLP waterfalls. Same service, different
        signals.{' '}
        <Link href={servicePath(alias)} className="underline">
          Service overview
        </Link>
        {' · '}
        <Link href="/observability/services" className="underline">
          All services
        </Link>
      </p>
    </div>
  );
}
