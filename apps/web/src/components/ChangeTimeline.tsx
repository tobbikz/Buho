import Link from 'next/link';
import { getChangeTimeline, type ChangeEvent } from '@/lib/change-timeline';
import { formatAgo } from '@/lib/format';

function toneClass(tone: ChangeEvent['tone']): string {
  return tone === 'error'
    ? 'tag--error'
    : tone === 'warn'
      ? 'tag--warn'
      : tone === 'ok'
        ? 'tag--ok'
        : 'tag--muted';
}

/**
 * Compact last-N change list for Blame (not a second dashboard).
 */
export async function ChangeTimeline({
  instanceId,
  hours = 24,
  limit = 6,
}: {
  instanceId: number;
  hours?: number;
  limit?: number;
}) {
  const events = await getChangeTimeline(instanceId, hours)
    .then((rows) => rows.slice(0, limit))
    .catch(() => [] as ChangeEvent[]);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">What changed</span>
        <span className="font-mono text-[10px] text-foreground-muted">last {hours}h</span>
      </div>
      <div className="panel-body">
        {events.length === 0 ? (
          <div className="text-[12px] text-foreground-muted">Nothing material in this window.</div>
        ) : (
          <ul className="m-0 list-none p-0 flex flex-col gap-2">
            {events.map((e, idx) => (
              <li
                key={`${e.kind}-${e.at.toISOString()}-${idx}`}
                className="flex items-start gap-2"
              >
                <span className={`tag ${toneClass(e.tone)} shrink-0`}>{e.kind}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-foreground-secondary leading-snug">
                    {e.href ? (
                      <Link href={e.href} className="underline decoration-dotted">
                        {e.title}
                      </Link>
                    ) : (
                      e.title
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-foreground-muted">
                    {formatAgo(e.at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
