import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { tracesListHref } from '@/lib/apm-trace-href';
import { formatClock, formatNumber } from '@/lib/format';
import { getTraceSpans } from '@/lib/traces';
import { listInstances } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function ObservabilityTraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ traceId: string }>;
  searchParams: Promise<{
    service?: string;
    w?: string;
    q?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { traceId } = await params;
  const sp = await searchParams;
  const backHref = tracesListHref({
    service: sp.service,
    w: sp.w,
    q: sp.q,
    from: sp.from,
    to: sp.to,
  });

  if (!traceId) {
    return (
      <div className="obs-page">
        <ObsPageHeader section="APM" title="Trace" actions={<Link className="btn" href={backHref}>Traces</Link>} />
        <ObsEmpty
          title="Trace not found"
          actions={[{ href: backHref, label: 'Back to Traces', primary: true }]}
        >
          Missing trace id.
        </ObsEmpty>
      </div>
    );
  }

  let spans;
  let instances;
  try {
    [spans, instances] = await Promise.all([getTraceSpans(traceId), listInstances()]);
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  if (spans.length === 0) {
    return (
      <div className="obs-page">
        <ObsPageHeader
          section="APM"
          title={<span className="font-mono text-base">{traceId}</span>}
          sub="No spans in store"
          actions={
            <Link className="btn btn--primary" href={backHref}>
              Back to Traces
            </Link>
          }
        />
        <ObsEmpty
          title="Trace not found"
          actions={[
            { href: backHref, label: 'Back to Traces', primary: true },
            { href: '/observability/services', label: 'Services' },
          ]}
        >
          No OTLP spans for this id (expired, wrong id, or not ingested yet).
        </ObsEmpty>
      </div>
    );
  }

  const t0 = Math.min(...spans.map((s) => s.startTs.getTime()));
  const t1 = Math.max(...spans.map((s) => s.endTs.getTime()));
  const totalMs = Math.max(1, t1 - t0);
  const pg = instances.find((i) => i.engine === 'postgres');
  const hasSql = spans.some((s) => !!s.sqlText);

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="APM"
        title={<span className="font-mono text-base">{traceId}</span>}
        sub={
          <>
            Waterfall · {spans.length} spans · {formatClock(new Date(t0))} ·{' '}
            {formatNumber(totalMs)} ms
            {hasSql && pg ? (
              <>
                {' '}
                ·{' '}
                <Link href={`/instances/${pg.instanceId}/locks`} className="underline">
                  DB locks ({pg.alias})
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          <Link className="btn" href={backHref}>
            Traces
          </Link>
        }
      />

      <section className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <span className="panel-title">Waterfall</span>
          <div className="trace-legend" aria-label="Span color legend">
            <span className="trace-legend__item">
              <i
                className="trace-legend__swatch"
                style={{ background: 'var(--accent)', width: '14px', height: '8px' }}
              />
              App / HTTP
            </span>
            <span className="trace-legend__item">
              <i
                className="trace-legend__swatch"
                style={{ background: 'var(--warning)', width: '14px', height: '8px' }}
              />
              SQL / DB
            </span>
            <span className="trace-legend__item">
              <i
                className="trace-legend__swatch"
                style={{ background: 'var(--error)', width: '14px', height: '8px' }}
              />
              Error
            </span>
          </div>
        </div>
        <div className="panel-body space-y-2">
          {spans.map((span) => {
            const left = ((span.startTs.getTime() - t0) / totalMs) * 100;
            const width = Math.max(0.8, (span.durationMs / totalMs) * 100);
            const isErr = span.statusCode === 'ERROR';
            return (
              <div key={span.spanId} className="text-[11px]">
                <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-foreground-muted">{span.serviceName}</span>
                  <span className="font-medium">{span.name}</span>
                  <span className="num text-foreground-muted">
                    {formatNumber(span.durationMs)} ms
                  </span>
                  {span.httpMethod ? (
                    <span className="tag tag--muted">
                      {span.httpMethod} {span.httpStatus ?? ''}
                    </span>
                  ) : null}
                  {span.sqlText ? <span className="tag tag--info">SQL</span> : null}
                  {isErr ? <span className="tag tag--error">error</span> : null}
                </div>
                <div className="relative h-3 bg-[var(--surface-muted)]">
                  <div
                    className={`absolute top-0 h-3 ${isErr ? 'bg-[var(--error)]' : span.sqlText ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]'}`}
                    style={{ left: `${left}%`, width: `${width}%`, opacity: 0.85 }}
                    title={`${span.durationMs.toFixed(1)} ms`}
                  />
                </div>
                {span.sqlText && (
                  <pre className="mt-1 max-h-24 overflow-auto border border-[var(--border)] bg-[var(--surface-muted)] p-2 font-mono text-[10px]">
                    {span.sqlText}
                    {pg && (
                      <div className="mt-1">
                        <Link
                          href={`/instances/${pg.instanceId}/queries`}
                          className="underline text-foreground-muted"
                        >
                          → queries on {pg.alias}
                        </Link>
                      </div>
                    )}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
