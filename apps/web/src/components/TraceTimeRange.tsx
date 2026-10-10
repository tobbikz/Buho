'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { tracesListHref } from '@/lib/apm-trace-href';
import {
  APM_WINDOWS,
  formatApmRangeLabel,
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
} from '@/lib/apm-window';

export function TraceTimeRange({
  activeKey,
  fromIso,
  toIso,
  service,
  q,
}: {
  /** Preset key or `custom`. */
  activeKey: string;
  fromIso?: string | null;
  toIso?: string | null;
  service?: string | null;
  q?: string | null;
}) {
  const router = useRouter();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const isCustom = activeKey === 'custom' && !!(fromIso || toIso);
  const [open, setOpen] = useState(false);

  const defaultFrom = fromIso
    ? new Date(fromIso)
    : new Date(Date.now() - 60 * 60 * 1000);
  const defaultTo = toIso ? new Date(toIso) : new Date();

  const [fromLocal, setFromLocal] = useState(() => toDatetimeLocalValue(defaultFrom));
  const [toLocal, setToLocal] = useState(() => toDatetimeLocalValue(defaultTo));

  useEffect(() => {
    if (fromIso) setFromLocal(toDatetimeLocalValue(new Date(fromIso)));
    if (toIso) setToLocal(toDatetimeLocalValue(new Date(toIso)));
  }, [fromIso, toIso]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const ctxBase = { service: service ?? null, q: q || null };

  function applyAbsolute() {
    const from = fromDatetimeLocalValue(fromLocal);
    const to = fromDatetimeLocalValue(toLocal);
    if (!from && !to) return;
    setOpen(false);
    router.push(tracesListHref({ ...ctxBase, from, to }));
  }

  return (
    <div className="apm-time-range" ref={rootRef}>
      <div className="apm-time-range__presets flex items-center gap-1 flex-wrap justify-end">
        {APM_WINDOWS.map((w) => (
          <Link
            key={w.key}
            href={tracesListHref({ ...ctxBase, w: w.key })}
            className={`tag ${!isCustom && activeKey === w.key ? 'tag--info' : 'tag--muted'}`}
          >
            {w.key}
          </Link>
        ))}
        <button
          type="button"
          className={`tag apm-time-range__cal ${isCustom || open ? 'tag--info' : 'tag--muted'}`}
          aria-expanded={open}
          aria-controls={panelId}
          title="Custom date & time range"
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="2" y="3" width="12" height="11" rx="1" />
            <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
          </svg>
          {isCustom && fromIso && toIso ? (
            <span className="apm-time-range__cal-label">
              {formatApmRangeLabel(new Date(fromIso), new Date(toIso))}
            </span>
          ) : (
            <span>Custom</span>
          )}
        </button>
      </div>

      {open ? (
        <div id={panelId} className="apm-time-range__panel panel" role="dialog" aria-label="Custom time range">
          <div className="panel-body apm-time-range__fields">
            <label className="apm-time-range__field">
              <span className="muted text-xs">From</span>
              <input
                type="datetime-local"
                className="input"
                value={fromLocal}
                onChange={(e) => setFromLocal(e.target.value)}
              />
            </label>
            <label className="apm-time-range__field">
              <span className="muted text-xs">To</span>
              <input
                type="datetime-local"
                className="input"
                value={toLocal}
                onChange={(e) => setToLocal(e.target.value)}
              />
            </label>
            <div className="apm-time-range__actions">
              <button type="button" className="btn btn--primary" onClick={applyAbsolute}>
                Apply range
              </button>
              {isCustom ? (
                <Link
                  href={tracesListHref({ ...ctxBase, w: '1h' })}
                  className="btn"
                  onClick={() => setOpen(false)}
                >
                  Clear
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
