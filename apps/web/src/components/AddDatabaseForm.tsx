'use client';

import { useState } from 'react';
import type { TargetProbeResult } from '@/lib/test-target';

const ENGINE_OPTIONS = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mariadb', label: 'MariaDB / MySQL' },
  { value: 'mssql', label: 'SQL Server' },
  { value: 'mongodb', label: 'MongoDB' },
] as const;

const HOST_SOURCE_OPTIONS = [
  { value: 'none', label: 'Disabled' },
  { value: 'local', label: 'Local (/proc on this host)' },
  { value: 'ssh', label: 'SSH (remote host)' },
] as const;

function resultClass(ok: boolean | undefined): string {
  if (ok === undefined) return 'tag tag--muted';
  return ok ? 'tag tag--ok' : 'tag tag--error';
}

export function AddDatabaseForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  const [engine, setEngine] = useState('postgres');
  const [hostSource, setHostSource] = useState('local');
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<TargetProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  async function testConnections(form: HTMLFormElement) {
    setTesting(true);
    setProbe(null);
    setProbeError(null);
    try {
      const response = await fetch('/api/admin/test-target', {
        method: 'POST',
        body: new FormData(form),
      });
      const payload = (await response.json()) as TargetProbeResult & { error?: string };
      if (!response.ok) {
        setProbeError(payload.error ?? 'Connection test failed.');
        return;
      }
      setProbe(payload);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form action={action} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Alias
        <input name="alias" required className="input font-mono" placeholder="orders-prod" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Engine
        <select
          name="engine"
          className="input"
          value={engine}
          onChange={(event) => setEngine(event.target.value)}
        >
          {ENGINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Environment
        <input name="environment" className="input" defaultValue="prod" placeholder="prod" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Host
        <input name="host" required className="input font-mono" placeholder="10.0.0.10" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Port
        <input name="port" type="number" className="input font-mono" placeholder="5432" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Database
        <input name="database" className="input font-mono" placeholder="postgres / master / admin" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Username
        <input name="username" required className="input font-mono" placeholder="buho_monitor" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Password
        <input
          name="password"
          type="password"
          required
          className="input font-mono"
          autoComplete="new-password"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Tag key (optional)
        <input name="tagKey" className="input font-mono" placeholder="team" />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Tag value
        <input name="tagValue" className="input font-mono" placeholder="data" />
      </label>
      <label className="flex items-center gap-2 text-[12px] text-foreground-secondary md:col-span-2">
        <input type="checkbox" name="ssl" className="accent-[var(--accent)]" />
        Use TLS / SSL
      </label>

      {engine === 'postgres' ? (
        <div className="md:col-span-2 xl:col-span-3 rounded border border-[var(--border)] p-3">
          <p className="mb-2 text-[12px] font-semibold text-foreground">Host metrics (CPU / memory)</p>
          <p className="mb-3 text-[11px] text-foreground-secondary">
            PostgreSQL does not expose host CPU or RAM. Búho reads <span className="font-mono">/proc</span>{' '}
            locally or over SSH (agentless, read-only).
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Source
              <select
                name="hostMetricsSource"
                className="input"
                value={hostSource}
                onChange={(event) => setHostSource(event.target.value)}
              >
                {HOST_SOURCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Data directory
              <input
                name="dataDirectory"
                className="input font-mono"
                placeholder="/var/lib/postgresql/data"
                defaultValue="/var/lib/postgresql/data"
              />
            </label>
            {hostSource === 'ssh' ? (
              <>
                <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                  SSH user@host
                  <input name="sshTarget" className="input font-mono" placeholder="buho@10.0.0.10" />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted md:col-span-2">
                  SSH identity file (optional)
                  <input
                    name="sshIdentityFile"
                    className="input font-mono"
                    placeholder="/home/buho/.ssh/id_ed25519"
                  />
                </label>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {probe || probeError ? (
        <div className="md:col-span-2 xl:col-span-3 flex flex-col gap-2">
          {probeError ? <div className="notice notice--error">{probeError}</div> : null}
          {probe ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className={resultClass(probe.database.ok)}>
                DB: {probe.database.message}
                {probe.database.detail ? ` · ${probe.database.detail}` : ''}
              </span>
              <span className={resultClass(probe.host.ok)}>
                Host: {probe.host.message}
                {probe.host.detail ? ` · ${probe.host.detail}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2 md:col-span-2 xl:col-span-3">
        <button
          type="button"
          className="btn"
          disabled={testing}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) void testConnections(form);
          }}
        >
          {testing ? 'Testing…' : 'Test connections'}
        </button>
        <button type="submit" className="btn btn--primary">
          Add database
        </button>
      </div>
    </form>
  );
}
