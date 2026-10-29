'use client';

import { useState } from 'react';

type Kind = 'cancel_query' | 'kill_session';

/**
 * Gated cancel/kill for a live pid. Posts to /api/actions (actions.enabled required).
 */
export function SessionActionButtons({
  alias,
  pid,
  role,
}: {
  alias: string;
  pid: number;
  role: 'waiter' | 'blocker';
}) {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(kind: Kind) {
    const reason = window.prompt(
      `Reason for ${kind === 'cancel_query' ? 'cancel' : 'kill'} on ${role} pid ${pid} (${alias})`,
      `Blame: ${role} pid ${pid}`,
    );
    if (!reason || reason.trim().length < 3) return;
    setBusy(kind);
    setMsg(null);
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, alias, pid, reason: reason.trim(), actor: 'blame-ui' }),
      });
      const body = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) {
        setMsg(body.error ?? body.message ?? `HTTP ${res.status}`);
      } else {
        setMsg(body.message ?? (body.ok ? 'ok' : 'failed'));
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn text-[11px]"
        disabled={busy != null}
        onClick={() => void run('cancel_query')}
      >
        {busy === 'cancel_query' ? '…' : `Cancel ${role}`}
      </button>
      <button
        type="button"
        className="btn text-[11px]"
        disabled={busy != null}
        onClick={() => void run('kill_session')}
      >
        {busy === 'kill_session' ? '…' : `Kill ${role}`}
      </button>
      {msg ? <span className="font-mono text-[11px] text-foreground-secondary">{msg}</span> : null}
    </div>
  );
}
