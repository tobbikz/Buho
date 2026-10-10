import Link from 'next/link';
import { ObsEmpty } from '@/components/ObsEmpty';
import { ObsPageHeader } from '@/components/ObsPageHeader';
import { StoreError } from '@/components/StoreError';
import { TraceDiscover } from '@/components/TraceDiscover';
import { TraceServiceFilter } from '@/components/TraceServiceFilter';
import { TraceTimeRange } from '@/components/TraceTimeRange';
import { APM_WINDOWS, resolveApmTimeRange } from '@/lib/apm-window';
import { countTracesSince, listApmServiceNames, listTraces } from '@/lib/traces';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Traces · APM · Búho' };

export default async function ObservabilityApmTracesPage({
  searchParams,
}: {
  searchParams: Promise<{
    service?: string;
    w?: string;
    q?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const range = resolveApmTimeRange(sp);
  const serviceFilter = sp.service?.trim() || null;
  const initialQuery = sp.q?.trim() || '';
  const fromIso = range.kind === 'absolute' ? range.from.toISOString() : null;
  const toIso = range.kind === 'absolute' ? range.to.toISOString() : null;

  let traces;
  let totalTraces = 0;
  let serviceOptions: string[] = [];
  let activeKey = range.key;
  try {
    totalTraces = await countTracesSince(null);
    const listOpts =
      range.kind === 'absolute'
        ? { from: range.from, to: range.to }
        : { windowMinutes: range.minutes ?? undefined };

    const [windowTraces, namesAll] = await Promise.all([
      listTraces(200, listOpts),
      listApmServiceNames(null),
    ]);
    traces = windowTraces;
    if (range.kind === 'preset' && !sp.w && traces.length === 0 && totalTraces > 0) {
      activeKey = APM_WINDOWS[APM_WINDOWS.length - 1]!.key;
      traces = await listTraces(200);
    }
    serviceOptions = [...namesAll].filter((s) => s && s !== '(unknown)').sort((a, b) => a.localeCompare(b));
    if (serviceFilter && !serviceOptions.includes(serviceFilter)) {
      serviceOptions = [...serviceOptions, serviceFilter].sort((a, b) => a.localeCompare(b));
    }
  } catch (error) {
    return (
      <div className="obs-page">
        <StoreError message={error instanceof Error ? error.message : String(error)} />
      </div>
    );
  }

  const filtered = serviceFilter
    ? traces.filter((t) => (t.rootService ?? '(unknown)') === serviceFilter)
    : traces;

  const listContext = {
    service: serviceFilter,
    w: range.kind === 'absolute' ? null : activeKey,
    from: fromIso,
    to: toIso,
    q: initialQuery || null,
  };

  return (
    <div className="obs-page">
      <ObsPageHeader
        section="APM"
        title="Traces"
        sub={
          <>
            HTTP endpoints from OTLP (SQL orphans omitted · see Databases for SQL)
            {' · '}
            <Link href="/observability/apm/setup" className="underline">
              Add APM
            </Link>
            {' · '}
            <Link href="/observability/services" className="underline">
              Services
            </Link>
          </>
        }
        actions={
          <>
            <Link className="btn btn--primary" href="/observability/apm/setup">
              Add APM
            </Link>
            <TraceTimeRange
              activeKey={activeKey}
              fromIso={fromIso}
              toIso={toIso}
              service={serviceFilter}
              q={initialQuery || null}
            />
          </>
        }
      />

      {totalTraces === 0 ? (
        <ObsEmpty
          title="No OTLP traces yet"
          actions={[
            { href: '/observability/apm/setup', label: 'Add APM', primary: true },
            { href: '/observability/services', label: 'Services' },
          ]}
        >
          Point your SDK or collector at the OTLP endpoint from Add APM (token required off
          loopback). Lab smoke: <span className="font-mono">npm run otel:emit</span>.
        </ObsEmpty>
      ) : (
        <>
          <TraceServiceFilter
            windowKey={range.kind === 'absolute' ? 'custom' : activeKey}
            fromIso={fromIso}
            toIso={toIso}
            initialQuery={initialQuery}
            serviceFilter={serviceFilter}
            serviceOptions={serviceOptions}
          />

          <TraceDiscover
            initialQuery={initialQuery}
            listContext={listContext}
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
        </>
      )}
    </div>
  );
}
