'use client';

import { useState } from 'react';

export function ChannelTestButton({ channelId }: { channelId: number }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);

  async function runTest() {
    setBusy(true);
    setMessage(null);
    setOk(null);
    try {
      const response = await fetch('/api/admin/test-channel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) {
        setOk(false);
        setMessage(payload.error ?? 'Test failed');
        return;
      }
      setOk(true);
      setMessage('Test sent — check the channel.');
    } catch (error) {
      setOk(false);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn" disabled={busy} onClick={() => void runTest()}>
        {busy ? 'Sending…' : 'Test'}
      </button>
      {message ? (
        <span className={`text-[10px] ${ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
