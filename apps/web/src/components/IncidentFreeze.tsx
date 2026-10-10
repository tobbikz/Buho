'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

type Frozen = {
  at: string;
  windowKey: string;
  windowMinutes: number;
};

function storageKey(instanceId: number): string {
  return `buho.incident-freeze.${instanceId}`;
}

/**
 * Compact war-room toolbar — not a full panel.
 */
export function IncidentFreeze({
  instanceId,
  windowKey,
  windowMinutes,
}: {
  instanceId: number;
  windowKey: string;
  windowMinutes: number;
}) {
  const [frozen, setFrozen] = useState<Frozen | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey(instanceId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Frozen;
      if (parsed?.at && parsed.windowKey) setFrozen(parsed);
    } catch {
      /* ignore */
    }
  }, [instanceId]);

  const freeze = useCallback(() => {
    const next: Frozen = {
      at: new Date().toISOString(),
      windowKey,
      windowMinutes,
    };
    try {
      sessionStorage.setItem(storageKey(instanceId), JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setFrozen(next);
  }, [instanceId, windowKey, windowMinutes]);

  const clear = useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey(instanceId));
    } catch {
      /* ignore */
    }
    setFrozen(null);
  }, [instanceId]);

  const v = frozen?.windowKey ?? windowKey;
  const links = useMemo(
    () => [
      { label: 'Locks', href: `/instances/${instanceId}/locks` },
      { label: 'Host', href: `/instances/${instanceId}/host` },
      { label: 'Queries', href: `/instances/${instanceId}/queries` },
      { label: 'Backups', href: `/instances/${instanceId}/backups` },
    ],
    [instanceId],
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]">
      <button type="button" className="btn btn--sm" onClick={freeze}>
        {frozen ? 'Re-freeze' : 'Freeze window'}
      </button>
      {frozen ? (
        <button type="button" className="btn btn--sm btn-secondary" onClick={clear}>
          Clear
        </button>
      ) : null}
      <span className="font-mono text-[10px] text-foreground-muted">
        {v} · {windowMinutes}m
        {frozen ? ` · frozen ${new Date(frozen.at).toLocaleTimeString('en')}` : ''}
      </span>
      <span className="text-foreground-muted">·</span>
      <nav className="flex flex-wrap items-center gap-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-foreground-secondary underline-offset-2 hover:underline"
          >
            {l.label}
          </Link>
        ))}
        <Link
          href={`/instances/${instanceId}/blame?v=${v}`}
          className="text-foreground-secondary underline-offset-2 hover:underline"
        >
          Blame
        </Link>
      </nav>
    </div>
  );
}
