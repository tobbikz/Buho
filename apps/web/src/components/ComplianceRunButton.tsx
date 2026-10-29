'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ComplianceRunButton({
  alias,
  pack,
}: {
  alias: string;
  pack: 'cis-postgres' | 'cis-mssql' | 'stig-postgres';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/compliance/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ alias, pack }),
      });
      const body = (await res.json()) as { error?: string; score?: number };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn text-[11px]" disabled={busy} onClick={() => void run()}>
        {busy ? 'Running…' : 'Re-run'}
      </button>
      {error ? <span className="text-[11px] text-danger">{error}</span> : null}
    </span>
  );
}
