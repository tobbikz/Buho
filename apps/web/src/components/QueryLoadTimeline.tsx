import { Sparkline } from '@/components/Sparkline';
import { formatDuration, formatNumber } from '@/lib/format';
import { getQueryLoadTimeline } from '@/lib/query-load';

function DeltaTag({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) {
    return (
      <span className="text-[11px] text-foreground-muted">
        {label}: n/a vs prior window
      </span>
    );
  }
  const up = pct > 0;
  const flat = Math.abs(pct) < 1;
  const cls = flat ? 'text-foreground-secondary' : up ? 'text-[#b01818]' : 'text-[#0a6e42]';
  return (
    <span className={`font-mono text-[11px] ${cls}`}>
      {label}: {up && !flat ? '+' : ''}
      {pct.toFixed(0)}% vs prior 24h
    </span>
  );
}

function LoadBars({ values, max }: { values: number[]; max: number }) {
  if (values.length === 0) {
    return <span className="text-[11px] text-foreground-muted">No buckets in window</span>;
  }
  const peak = max > 0 ? max : Math.max(...values, 1);
  return (
    <div className="flex h-10 items-end gap-px" role="img" aria-label="load per hour">
      {values.map((v, i) => (
        <div
          key={i}
          className="min-w-[3px] flex-1 rounded-sm bg-accent/80"
          style={{
            height: `${Math.max(4, (v / peak) * 100)}%`,
            opacity: v <= 0 ? 0.15 : 0.55 + (v / peak) * 0.45,
          }}
          title={`${formatDuration(v / 1000)} exec`}
        />
      ))}
    </div>
  );
}

/**
 * Compact 24h load view for a single queryid (statement_stats deltas).
 */
export async function QueryLoadTimeline({
  instanceId,
  queryid,
}: {
  instanceId: number;
  queryid: string;
}) {
  const timeline = await getQueryLoadTimeline(instanceId, queryid);
  if (!timeline) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Load history</span>
        </div>
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No statement deltas yet for this queryid. The collector writes intervals to{' '}
          <span className="font-mono">statement_stats</span> after two samples.
        </p>
      </section>
    );
  }

  const execSeries = timeline.buckets.map((b) => b.execMs);
  const callSeries = timeline.buckets.map((b) => b.calls);
  const execMax = Math.max(...execSeries, 0);

  return (
    <section className="panel">
      <div className="panel-header flex flex-wrap items-center gap-3">
        <span className="panel-title">Load history</span>
        <span className="text-[11px] text-foreground-muted">last 24h · 1h buckets · statement_stats</span>
      </div>
      <div className="grid gap-4 px-4 pb-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[12px] font-semibold">Execution time</span>
            <span className="font-mono text-[12px]">
              {formatDuration(timeline.current.execMs / 1000)} total
            </span>
            <DeltaTag label="exec" pct={timeline.deltaPct.execMs} />
          </div>
          <LoadBars values={execSeries} max={execMax} />
          <div className="mt-2">
            <Sparkline
              values={execSeries}
              width={280}
              height={32}
              color="#005eb8"
              title="exec_ms per hour"
            />
          </div>
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[12px] font-semibold">Calls</span>
            <span className="font-mono text-[12px]">{formatNumber(timeline.current.calls)} total</span>
            <DeltaTag label="calls" pct={timeline.deltaPct.calls} />
          </div>
          <Sparkline
            values={callSeries}
            width={280}
            height={32}
            color="#0a6e42"
            title="calls per hour"
          />
          {timeline.current.meanMs != null ? (
            <p className="mt-2 font-mono text-[11px] text-foreground-secondary">
              mean {timeline.current.meanMs.toFixed(timeline.current.meanMs < 10 ? 2 : 0)} ms/call
              {timeline.prior.meanMs != null && timeline.prior.calls > 0 ? (
                <>
                  {' '}
                  (prior {timeline.prior.meanMs.toFixed(timeline.prior.meanMs < 10 ? 2 : 0)} ms)
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
