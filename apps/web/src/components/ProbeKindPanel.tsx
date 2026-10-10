'use client';

import { useState } from 'react';

type Kind = 'tcp' | 'icmp' | 'browser';

/** Quick add for non-HTTP probe kinds (HTTP stays in EndpointDiscover Analyze). */
export function ProbeKindPanel() {
  const [kind, setKind] = useState<Kind>('tcp');
  const [alias, setAlias] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('5432');
  const [journey, setJourney] = useState('http://127.0.0.1:3100/\nhttp://127.0.0.1:3100/login');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const steps = journey
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((url) => ({ url, expectStatus: [200, 204, 301, 302, 303, 307, 308, 401, 403] }));
      const res = await fetch('/api/endpoints/save-monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: alias.trim(),
          kind,
          host: host.trim(),
          port: Number(port) || (kind === 'icmp' ? 0 : 80),
          journey: kind === 'browser' ? steps : undefined,
          baseUrl:
            kind === 'browser'
              ? steps[0]?.url
              : `tcp://${host.trim()}:${Number(port) || 80}`,
          paths: kind === 'browser' ? ['/'] : ['/'],
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; alias?: string };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg(`Saved «${data.alias ?? alias}» · kind=${kind}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mb-3">
      <div className="panel-header">
        <span className="panel-title">TCP · ICMP · Journey</span>
        <span className="text-[11px] text-foreground-muted">
          HTTP Analyze stays above · Journey = sequential HTTP steps (not Playwright)
        </span>
      </div>
      <div className="panel-body flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {(['tcp', 'icmp', 'browser'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`btn ${kind === k ? 'btn--primary' : ''}`}
              onClick={() => setKind(k)}
            >
              {k === 'browser' ? 'Journey' : k.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="discover__field">
          <span>Probe name</span>
          <input
            className="input"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="orders-tcp"
            spellCheck={false}
          />
        </label>
        {kind !== 'browser' ? (
          <div className="flex flex-wrap gap-2">
            <label className="discover__field">
              <span>Host</span>
              <input
                className="input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                spellCheck={false}
              />
            </label>
            {kind === 'tcp' ? (
              <label className="discover__field">
                <span>Port</span>
                <input
                  className="input"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  spellCheck={false}
                />
              </label>
            ) : null}
          </div>
        ) : (
          <label className="discover__field">
            <span>Journey URLs (one per line)</span>
            <textarea
              className="input discover__paths"
              rows={3}
              value={journey}
              onChange={(e) => setJourney(e.target.value)}
              spellCheck={false}
            />
          </label>
        )}
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !alias.trim()}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save check'}
        </button>
        {msg ? <div className="text-[12px] text-foreground-secondary">{msg}</div> : null}
      </div>
    </section>
  );
}
