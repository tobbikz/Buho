import Link from 'next/link';
import { Store } from '@buho/store';
import { storeUrl } from '@/lib/db';

/** Recent plan fingerprint changes for the top wait-blamed queryid. */
export async function PlanFingerprintHistory({
  instanceId,
  windowMinutes = 60,
}: {
  instanceId: number;
  windowMinutes?: number;
}) {
  const store = new Store(storeUrl());
  try {
    const blame = await store.listWaitSqlBlame(instanceId, windowMinutes);
    const top = blame.find((b) => b.queryid);
    if (!top) {
      return (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Plan history</span>
          </div>
          <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
            No wait-blamed queryid yet — plan history appears once sessions attribute SQL.
          </p>
        </section>
      );
    }

    const qid = Number(top.queryid);
    const fps = Number.isFinite(qid)
      ? await store.listPlanFingerprints(instanceId, qid, 8)
      : [];

    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Plan history</span>
          <Link
            className="font-mono text-[12px] underline"
            href={`/instances/${instanceId}/queries/${top.queryid}`}
          >
            queryid {top.queryid}
          </Link>
        </div>
        {fps.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-foreground-secondary">
            No fingerprints yet. Auto-plans will fill this within ~5 minutes for hot statements.
          </p>
        ) : (
          <ul className="space-y-2 px-4 pb-4 font-mono text-[12px]">
            {fps.map((fp, i) => {
              const changed = i < fps.length - 1 && fps[i + 1]!.fingerprint !== fp.fingerprint;
              return (
                <li key={`${fp.fingerprint}-${fp.capturedAt.toISOString()}`} className="flex flex-wrap gap-2">
                  <span className="text-foreground-secondary">
                    {fp.capturedAt.toISOString().replace('T', ' ').slice(0, 19)}
                  </span>
                  <span title={fp.fingerprint}>{fp.fingerprint.slice(0, 14)}…</span>
                  {fp.totalCost != null ? <span>cost {Math.round(fp.totalCost)}</span> : null}
                  {changed ? <span className="tag tag--info">shape change</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  } finally {
    await store.close();
  }
}
