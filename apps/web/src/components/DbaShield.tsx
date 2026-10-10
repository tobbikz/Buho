import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  buildBlamePicture,
  type BlameLaneVerdict,
  type ShieldTone,
} from '@/lib/dba-shield';
import { formatDuration, formatPct } from '@/lib/format';

function tag(tone: ShieldTone): string {
  return tone === 'error'
    ? 'tag--error'
    : tone === 'warn'
      ? 'tag--warn'
      : tone === 'ok'
        ? 'tag--ok'
        : 'tag--muted';
}

function border(tone: ShieldTone): string {
  return tone === 'error'
    ? 'var(--error)'
    : tone === 'warn'
      ? 'var(--warning)'
      : tone === 'ok'
        ? 'var(--success)'
        : 'var(--accent)';
}

function LaneColumn({
  title,
  hint,
  verdict,
  children,
}: {
  title: string;
  hint: string;
  verdict: BlameLaneVerdict;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-3 p-4"
      style={{ borderLeft: `3px solid ${border(verdict.tone)}` }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-foreground-muted">{title}</span>
        <span className="font-mono text-[10px] text-foreground-muted">{hint}</span>
      </div>
      <div className="text-[15px] font-semibold leading-snug">{verdict.headline}</div>
      <div>
        <span className={`tag ${tag(verdict.tone)}`} title="Who owns this lane">
          {verdict.pageLabel}
        </span>
      </div>
      <p className="text-[12px] leading-relaxed text-foreground-secondary m-0">{verdict.body}</p>
      <div className="mt-auto pt-2 border-t border-border flex flex-col gap-2">{children}</div>
    </div>
  );
}

/**
 * Dual-lane Blame: Pain now | DBA risk as one composition.
 * Evidence sits under each lane — no nested card grid, no repeated noisy block.
 */
export async function DbaShield({
  instanceId,
  connectionsUsedPct,
  windowMinutes = 60,
  alias,
  replicationLagSeconds,
}: {
  instanceId: number;
  connectionsUsedPct?: number | null;
  windowMinutes?: number;
  alias?: string | null;
  replicationLagSeconds?: number | null;
}) {
  const picture = await buildBlamePicture(instanceId, {
    connectionsUsedPct,
    windowMinutes,
    alias,
    replicationLagSeconds,
  });

  const noisyHref = picture.noisy?.queryid
    ? `/instances/${instanceId}/queries/${picture.noisy.queryid}`
    : `/instances/${instanceId}/queries`;

  return (
    <section id="dba-shield" className="panel overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Blame picture</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          pain now ≠ DBA risk
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 xl:divide-x divide-border">
        <LaneColumn title="Pain now" hint="live traffic" verdict={picture.pain}>
          {picture.lockStory ? (
            <EvidenceRow
              label="Locks"
              tone="error"
              body={`${picture.lockStory.summary} · wait ${formatDuration(picture.lockStory.worstWaitSeconds)}`}
              href={`/instances/${instanceId}/locks`}
            />
          ) : (
            <EvidenceRow label="Locks" tone="ok" body="No active lock episodes" />
          )}

          <EvidenceRow
            label="Host ↔ DB"
            tone={picture.hostDb.tone}
            body={
              picture.hostDb.iowaitPct == null && picture.hostDb.ioWaitShare == null
                ? picture.hostDb.verdict
                : `iowait ${picture.hostDb.iowaitPct == null ? 'n/a' : formatPct(picture.hostDb.iowaitPct, 0)} · DB I/O ${
                    picture.hostDb.ioWaitShare == null
                      ? 'n/a'
                      : formatPct(picture.hostDb.ioWaitShare * 100, 0)
                  }`
            }
            href={`/instances/${instanceId}/host`}
          />

          {picture.noisy && picture.noisy.sharePct != null && picture.noisy.sharePct >= 20 ? (
            <div className="flex flex-col gap-1">
              <EvidenceRow
                label="Noisy query"
                tone={picture.noisy.tone}
                body={`${formatPct(picture.noisy.sharePct, 0)} of DB time${
                  picture.noisy.ownerLabel ? ` · ${picture.noisy.ownerLabel}` : ''
                }`}
                href={noisyHref}
              />
              <div className="font-mono text-[10px] text-foreground-muted pl-0.5">
                {clip(picture.noisy.query, 120)}
              </div>
            </div>
          ) : (
            <EvidenceRow label="Noisy query" tone="ok" body="No dominant statement" />
          )}
        </LaneColumn>

        <LaneColumn title="DBA risk" hint="recovery / config" verdict={picture.risk}>
          <EvidenceRow
            label="Recovery"
            tone={picture.recovery.tone}
            body={picture.recovery.detail}
            href={`/instances/${instanceId}/backups`}
          />

          {picture.changes.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-foreground-muted">
                Config / jobs
              </span>
              <ul className="m-0 list-none p-0 flex flex-col gap-1">
                {picture.changes.slice(0, 3).map((c) => (
                  <li key={`${c.kind}-${c.label}`}>
                    <Link
                      href={c.href}
                      className="text-[12px] text-foreground-secondary underline decoration-dotted"
                    >
                      {c.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EvidenceRow
              label="Config / jobs"
              tone="ok"
              body="No pending settings or failed jobs"
            />
          )}

          {replicationLagSeconds != null && replicationLagSeconds >= 30 ? (
            <EvidenceRow
              label="HA / lag"
              tone={replicationLagSeconds >= 60 ? 'error' : 'warn'}
              body={`Replication lag ${Math.round(replicationLagSeconds)}s`}
              href={`/instances/${instanceId}/replication`}
            />
          ) : null}
        </LaneColumn>
      </div>

    </section>
  );
}

function EvidenceRow({
  label,
  body,
  tone,
  href,
}: {
  label: string;
  body: string;
  tone: ShieldTone;
  href?: string;
}) {
  const content = (
    <>
      <span className={`tag ${tag(tone)}`}>{label}</span>
      <span className="text-[12px] text-foreground-secondary leading-snug">{body}</span>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="flex flex-wrap items-baseline gap-2 hover:opacity-90"
        title={body}
      >
        {content}
      </Link>
    );
  }
  return <div className="flex flex-wrap items-baseline gap-2">{content}</div>;
}

function clip(sql: string | null | undefined, n = 140): string {
  if (!sql) return '—';
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}
