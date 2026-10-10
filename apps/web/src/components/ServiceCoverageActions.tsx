'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Optional HTTP probe CTA — never invents fake OTLP (SELECT 1 bootstrap). */
export function ServiceCoverageActions({
  serviceName,
  hasTraces,
  hasUptime,
}: {
  serviceName: string;
  hasTraces: boolean;
  hasUptime: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // APM-only is fine; only nudge when there is no uptime and we have a name to probe.
  if (hasUptime || !hasTraces) return null;

  async function createUptime() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/api/observability/ensure-coverage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: serviceName, action: 'uptime' }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        created?: boolean;
        baseUrl?: string;
        path?: string;
      };
      if (!res.ok) {
        setError(data.error ?? 'Could not create probe');
        return;
      }
      setNote(
        data.created
          ? `Probe created${data.baseUrl ? ` · ${data.baseUrl}${data.path ?? ''}` : ''}`
          : 'Probe already existed',
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Optional probe</span>
        <span className="muted text-xs">HTTP black-box · same service name · not APM</span>
      </div>
      <div className="panel-body space-y-2 text-[13px]">
        <p className="text-foreground-muted m-0">
          This service has APM traces. Add an HTTP probe only if you want external availability
          checks — not required for a normal API.
        </p>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void createUptime()}
        >
          {busy ? 'Creating…' : 'Add probe'}
        </button>
        {note ? <p className="text-[12px] m-0 text-[var(--color-success,#0a6e42)]">{note}</p> : null}
        {error ? (
          <p className="text-[12px] m-0 text-[var(--color-error,#b01818)]">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
