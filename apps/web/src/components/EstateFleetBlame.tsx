import Link from 'next/link';
import { getFleetBlameChips, type ShieldTone } from '@/lib/dba-shield';
import { ENGINE_LABEL } from '@/lib/estate';

function tag(tone: ShieldTone): string {
  return tone === 'error'
    ? 'tag--error'
    : tone === 'warn'
      ? 'tag--warn'
      : tone === 'ok'
        ? 'tag--ok'
        : 'tag--muted';
}

function shortRisk(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim();
  if (one.length <= 42) return one;
  return `${one.slice(0, 41)}…`;
}

/**
 * Fleet dual-lane Blame chips on Estate — pain now vs DBA risk at a glance.
 * Both can disagree on purpose: live traffic calm while recovery (RPO) is red.
 */
export async function EstateFleetBlame() {
  const chips = await getFleetBlameChips().catch(() => []);
  if (chips.length === 0) return null;

  const hot = chips.filter(
    (c) => c.painTone === 'error' || c.painTone === 'warn' || c.riskTone === 'error' || c.riskTone === 'warn',
  ).length;

  return (
    <section className="panel estate-accent-panel">
      <div className="panel-header">
        <span className="panel-title">Fleet Blame</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          live ≠ recovery · {hot} hot · {chips.length} SQL
        </span>
      </div>
      <div className="panel-body space-y-2">
        <p className="m-0 text-[11px] text-foreground-secondary max-w-[52rem]">
          Two independent signals: <strong>Live</strong> is on-call pain right now (locks, conn pressure).{' '}
          <strong>Recovery</strong> is RPO / archive posture — it can be red while live is calm (e.g. archive
          off). That is expected, not a contradiction.
        </p>
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <Link
              key={c.instanceId}
              href={c.href}
              className="inline-flex flex-col gap-1 rounded border border-border px-2.5 py-1.5 hover:border-[var(--accent)] min-w-[12rem]"
              title={`Live: ${c.painLabel} · Recovery: ${c.riskLabel}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium">{c.alias}</span>
                <span className="font-mono text-[9px] text-foreground-muted">
                  {ENGINE_LABEL[c.engine] ?? c.engine}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                <span className={`tag ${tag(c.painTone)}`} title="Live / on-call pain">
                  Live · {c.painLabel}
                </span>
                <span className={`tag ${tag(c.riskTone)}`} title={c.riskLabel}>
                  Recovery · {shortRisk(c.riskLabel)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
