'use client';

import { useState } from 'react';

/** Pre block with one-click copy — for Host / setup paste commands. */
export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          {label}
        </span>
        <button
          type="button"
          className="tag tag--muted"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto border border-border bg-surface-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  );
}
