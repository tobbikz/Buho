import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';

const CLASS_ORDER = [
  'Lock',
  'LWLock',
  'IO',
  'CPU',
  'Client',
  'IPC',
  'Timeout',
  'Extension',
  'BufferPin',
  'Other',
];

/**
 * Compact DPA wait-class timeline: one row of relative bar heights per class.
 */
export async function WaitClassTimeline({
  instanceId,
  windowMinutes = 60,
}: {
  instanceId: number;
  windowMinutes?: number;
}) {
  const store = new Store(storeUrl());
  try {
    const rows = await store.listWaitClassTimeline(instanceId, windowMinutes);
    if (rows.length === 0) {
      return (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Wait timeline</span>
          </div>
          <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
            No wait-class samples yet in this window.
          </p>
        </section>
      );
    }

    const buckets = [...new Set(rows.map((r) => r.bucket.getTime()))].sort((a, b) => a - b);
    const byClass = new Map<string, Map<number, number>>();
    let maxSessions = 1;
    for (const row of rows) {
      if (!byClass.has(row.waitClass)) byClass.set(row.waitClass, new Map());
      byClass.get(row.waitClass)!.set(row.bucket.getTime(), row.sessions);
      maxSessions = Math.max(maxSessions, row.sessions);
    }

    const classes = [
      ...CLASS_ORDER.filter((c) => byClass.has(c)),
      ...[...byClass.keys()].filter((c) => !CLASS_ORDER.includes(c)).sort(),
    ].slice(0, 6);

    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Wait timeline</span>
          <span className="tag tag--info">{buckets.length} buckets</span>
        </div>
        <div className="space-y-2 px-4 pb-4">
          {classes.map((cls) => {
            const series = byClass.get(cls)!;
            return (
              <div key={cls} className="flex items-center gap-2">
                <span className="w-20 shrink-0 font-mono text-[11px] text-foreground-secondary">
                  {cls}
                </span>
                <div
                  className="flex h-7 flex-1 items-end gap-px overflow-hidden"
                  title={`${cls} sessions over window`}
                >
                  {buckets.map((t) => {
                    const v = series.get(t) ?? 0;
                    const h = v <= 0 ? 0 : Math.max(2, Math.round((v / maxSessions) * 28));
                    return (
                      <div
                        key={t}
                        className="min-w-[2px] flex-1 rounded-sm bg-foreground/55"
                        style={{ height: h }}
                        title={`${new Date(t).toISOString()} · ${v}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="px-4 pb-3 text-[11px] text-foreground-secondary">
          Height = sessions in wait class per bucket (dense sampling fills gaps under pain).
        </p>
      </section>
    );
  } finally {
    await store.close();
  }
}
