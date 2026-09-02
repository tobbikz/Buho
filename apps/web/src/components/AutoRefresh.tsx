'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

function IconPause() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <rect x="2" y="1.5" width="2.5" height="9" fill="currentColor" />
      <rect x="7.5" y="1.5" width="2.5" height="9" fill="currentColor" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 1.5v9l7.5-4.5L3 1.5z" fill="currentColor" />
    </svg>
  );
}

function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      className={spinning ? 'refresh-spin' : undefined}
    >
      <path
        d="M10 6.5A4 4 0 1 1 9.2 3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
      />
      <path d="M10 2v2.2H7.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" />
    </svg>
  );
}

/**
 * Client-side polling refresh. Lives in the topbar only so fleet tabs do not
 * each carry their own pause/refresh controls.
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => startTransition(() => router.refresh()), intervalMs);
    return () => clearInterval(timer);
  }, [paused, intervalMs, router]);

  return (
    <div className="refresh-toolbar">
      <button
        type="button"
        className={`refresh-btn ${paused ? 'is-active' : ''}`}
        onClick={() => setPaused((value) => !value)}
        aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
      >
        {paused ? <IconPlay /> : <IconPause />}
      </button>
      <button
        type="button"
        className="refresh-btn"
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
        aria-label="Refresh now"
        title="Refresh now"
      >
        <IconRefresh spinning={pending} />
      </button>
    </div>
  );
}
