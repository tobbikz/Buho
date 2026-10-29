import Link from 'next/link';
import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';

/**
 * DPA-style panel: wait classes → SQL (queryid) → latest plan fingerprint.
 */
export async function WaitSqlPlanBlame({
  instanceId,
  windowMinutes = 60,
}: {
  instanceId: number;
  windowMinutes?: number;
}) {
  const store = new Store(storeUrl());
  try {
    const [classShare, blame] = await Promise.all([
      store.listWaitClassShare(instanceId, windowMinutes),
      store.listWaitSqlBlame(instanceId, windowMinutes),
    ]);
    const classRows = classShare.slice(0, 8);

    if (classRows.length === 0 && blame.length === 0) {
      return (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Waits → SQL → Plan</span>
          </div>
          <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
            No non-idle wait samples in this window. Collector writes{' '}
            <code className="font-mono text-[12px]">wait_class_samples</code> every session tick.
          </p>
        </section>
      );
    }

    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Waits → SQL → Plan</span>
          <span className="tag tag--info">DPA</span>
        </div>
        <div className="grid grid-cols-1 gap-4 px-4 pb-4 lg:grid-cols-3">
          <div>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-foreground-secondary">
              Wait classes
            </h3>
            <ul className="space-y-1 text-[13px]">
              {classRows.map((row) => (
                <li key={row.waitClass} className="flex justify-between gap-2 font-mono text-[12px]">
                  <span>{row.waitClass}</span>
                  <span className="text-foreground-secondary">
                    {row.pct.toFixed(0)}% · {row.samples}
                  </span>
                </li>
              ))}
              {classRows.length === 0 && (
                <li className="text-foreground-secondary">No class rollup yet</li>
              )}
            </ul>
          </div>
          <div className="lg:col-span-2">
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-foreground-secondary">
              SQL blame (with plan fingerprint)
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-foreground-secondary">
                    <th className="py-1 pr-2 font-medium">queryid</th>
                    <th className="py-1 pr-2 font-medium">wait</th>
                    <th className="py-1 pr-2 font-medium">%</th>
                    <th className="py-1 pr-2 font-medium">max ms</th>
                    <th className="py-1 pr-2 font-medium">plan fp</th>
                  </tr>
                </thead>
                <tbody>
                  {blame.map((row) => (
                    <tr key={`${row.queryid}-${row.waitType}`} className="border-b border-border/60 align-top">
                      <td className="py-1.5 pr-2 font-mono">
                        <Link
                          className="underline"
                          href={`/instances/${instanceId}/queries/${row.queryid}`}
                        >
                          {row.queryid}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-foreground-secondary">
                        {row.waitType ?? '—'}
                        {row.waitEvent ? (
                          <span className="block max-w-[12rem] truncate opacity-70">{row.waitEvent}</span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2 font-mono" title={`${row.samples} samples`}>
                        {row.pct.toFixed(0)}%
                      </td>
                      <td className="py-1.5 pr-2 font-mono">
                        {row.maxQueryMs != null ? Math.round(row.maxQueryMs) : '—'}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-[11px]">
                        {row.fingerprint ? (
                          <span title={row.planCapturedAt?.toISOString()}>
                            {row.fingerprint.slice(0, 12)}…
                            {row.totalCost != null ? ` · cost ${Math.round(row.totalCost)}` : ''}
                          </span>
                        ) : (
                          <span className="text-foreground-secondary">no plan yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {blame.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-2 text-foreground-secondary">
                        No queryids with waits in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {blame[0]?.query ? (
              <pre className="mt-3 max-h-28 overflow-auto rounded border border-border bg-surface-muted p-2 font-mono text-[11px]">
                {blame[0].query.slice(0, 800)}
              </pre>
            ) : null}
            <p className="mt-3 text-[11.5px] text-foreground-secondary">
              Auto-plans: collector captures EXPLAIN (estimate/generic) for top statements every ~5
              min and alerts on fingerprint change (<code className="font-mono">plan_regression</code>
              ).
            </p>
          </div>
        </div>
      </section>
    );
  } finally {
    await store.close();
  }
}
