import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';

/**
 * Side-by-side plan text for the two latest fingerprints of a queryid.
 * Surfaces plan_regression evidence on the Queries detail page.
 */
export async function PlanFingerprintDiff({
  instanceId,
  queryid,
}: {
  instanceId: number;
  queryid: string;
}) {
  const qid = Number(queryid);
  if (!Number.isFinite(qid)) return null;

  const store = new Store(storeUrl());
  try {
    const fps = await store.listPlanFingerprints(instanceId, qid, 4);
    if (fps.length === 0) {
      return (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Auto-plan fingerprints</span>
          </div>
          <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
            No auto-plan fingerprints yet. Collector captures top statements every ~5 minutes.
          </p>
        </section>
      );
    }

    const current = fps[0]!;
    const previous = fps.find((f) => f.fingerprint !== current.fingerprint) ?? null;
    const changed = Boolean(previous);

    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Auto-plan fingerprints</span>
          {changed ? (
            <span className="tag tag--warn">shape changed</span>
          ) : (
            <span className="tag tag--info">stable</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 px-4 pb-4 lg:grid-cols-2">
          <PlanCol
            label="Current"
            fingerprint={current.fingerprint}
            cost={current.totalCost}
            at={current.capturedAt}
            text={current.planText}
          />
          {previous ? (
            <PlanCol
              label="Previous shape"
              fingerprint={previous.fingerprint}
              cost={previous.totalCost}
              at={previous.capturedAt}
              text={previous.planText}
            />
          ) : (
            <div className="text-[13px] text-foreground-secondary">
              Only one shape captured so far
              {fps.length > 1 ? ` (${fps.length} captures, same fingerprint).` : '.'}
            </div>
          )}
        </div>
        {changed && current.totalCost != null && previous?.totalCost != null ? (
          <p className="px-4 pb-3 font-mono text-[12px] text-foreground-secondary">
            cost delta:{' '}
            {(((current.totalCost - previous.totalCost) / Math.max(previous.totalCost, 1)) * 100).toFixed(
              0,
            )}
            %
          </p>
        ) : null}
      </section>
    );
  } finally {
    await store.close();
  }
}

function PlanCol({
  label,
  fingerprint,
  cost,
  at,
  text,
}: {
  label: string;
  fingerprint: string;
  cost: number | null;
  at: Date;
  text: string | null;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[12px]">
        <span className="font-semibold">{label}</span>
        <span className="font-mono text-foreground-secondary" title={fingerprint}>
          {fingerprint.slice(0, 14)}…
        </span>
        {cost != null ? <span className="font-mono">cost {Math.round(cost)}</span> : null}
        <span className="text-foreground-secondary">
          {at.toISOString().replace('T', ' ').slice(0, 19)}
        </span>
      </div>
      <pre className="max-h-64 overflow-auto rounded border border-border bg-surface-muted p-2 font-mono text-[11px] leading-relaxed">
        {(text ?? '(no plan text)').slice(0, 12_000)}
      </pre>
    </div>
  );
}
