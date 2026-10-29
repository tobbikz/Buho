import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';

/** Metrics above hour-of-week baseline p90 (from buho.metric_baselines). */
export async function BaselineAnomalies({ instanceId }: { instanceId: number }) {
  const store = new Store(storeUrl());
  try {
    const rows = await store.listBaselineAnomalies(instanceId, 1.5);
    if (rows.length === 0) {
      return (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Baseline anomalies</span>
          </div>
          <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
            No metrics above 1.5× hour-of-week p90. Baselines build after maintenance rolls up enough
            1h history.
          </p>
        </section>
      );
    }
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Baseline anomalies</span>
          <span className="tag tag--warning">{rows.length}</span>
        </div>
        <ul className="space-y-2 px-4 pb-4 text-[13px]">
          {rows.map((r) => (
            <li key={r.metric} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-[12px]">{r.metric}</span>
              <span className="font-mono text-[12px] text-foreground-secondary">
                now {r.value.toFixed(2)} · p50 {r.p50?.toFixed(2) ?? '—'} · p90{' '}
                {r.p90?.toFixed(2) ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  } finally {
    await store.close();
  }
}
