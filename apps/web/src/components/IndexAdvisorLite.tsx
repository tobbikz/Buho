import Link from 'next/link';
import { getIndexFindings, getIndexSuggestions } from '@/lib/advisor';

/** Compact index advisor for Blame — same data as Indexes tab, top few only. */
export async function IndexAdvisorLite({ instanceId }: { instanceId: number }) {
  const [suggestions, findings] = await Promise.all([
    getIndexSuggestions(instanceId, 80).catch(() => ({
      suggestions: [],
      plansConsidered: 0,
      plansWithActuals: 0,
      newestPlanAt: null as Date | null,
    })),
    getIndexFindings(instanceId).catch(() => []),
  ]);

  const top = suggestions.suggestions.slice(0, 5);
  if (top.length === 0 && findings.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Index advisor</span>
        </div>
        <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
          No suggestions yet. Auto-plans / EXPLAIN ANALYZE feed this panel. See{' '}
          <Link className="underline" href={`/instances/${instanceId}/indexes`}>
            Indexes
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Index advisor</span>
        <Link className="text-[12px] underline" href={`/instances/${instanceId}/indexes`}>
          Full view
        </Link>
      </div>
      <ul className="space-y-3 px-4 pb-4 text-[13px]">
        {top.map((s) => (
          <li key={`${s.kind}-${s.relation}-${s.columns.join(',')}`} className="border-b border-border/50 pb-2">
            <div className="font-medium">
              {s.relation}{' '}
              <span className="font-mono text-[11px] text-foreground-secondary">({s.columns.join(', ')})</span>
            </div>
            <p className="mt-0.5 text-[12px] text-foreground-secondary">{s.reason.slice(0, 220)}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-surface-muted p-1.5 font-mono text-[11px]">{s.ddl}</pre>
          </li>
        ))}
        {findings.slice(0, 3).map((f) => (
          <li key={`${f.checkId}-${f.object}`} className="text-[12px] text-foreground-secondary">
            <span className="font-mono">{f.checkId}</span> · {f.object}: {f.message.slice(0, 160)}
          </li>
        ))}
      </ul>
      <p className="px-4 pb-3 text-[11px] text-foreground-secondary">
        Plans considered: {suggestions.plansConsidered} · with ANALYZE actuals:{' '}
        {suggestions.plansWithActuals}
      </p>
    </section>
  );
}
