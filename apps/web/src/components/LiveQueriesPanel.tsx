'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { waitHelp } from '@/lib/wait-help';

type LiveSession = {
  pid: number;
  state: string;
  waitType: string | null;
  waitEvent: string | null;
  application: string;
  username: string;
  database: string;
  queryMs: number | null;
  xactMs: number | null;
  query: string | null;
};

type LivePayload = {
  at: string | null;
  sessions: LiveSession[];
  stale?: boolean;
};

const POLL_MS = 5_000;

function liveDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function LiveQueriesPanel({
  instanceId,
  engine,
  initial,
}: {
  instanceId: number;
  engine: string;
  initial: LivePayload;
}) {
  const [foto, setFoto] = useState<LivePayload>(initial);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/instances/${instanceId}/live-sessions`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as LivePayload;
      setFoto(data);
      setError(null);
      setTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [instanceId]);

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load, paused]);

  const sampleHint =
    engine === 'postgres'
      ? 'pg_stat_activity'
      : engine === 'mariadb'
        ? 'PROCESSLIST'
        : engine === 'mssql'
          ? 'dm_exec_requests / sessions'
          : engine === 'oracle'
            ? 'v$session'
            : 'engine sessions';

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">
          Live queries
          {foto.at ? ` · ${new Date(foto.at).toLocaleString('en')}` : ''}
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-foreground-muted">
            {foto.sessions.length} session(s) · poll {POLL_MS / 1000}s
            {paused ? ' · paused' : ''}
            {tick > 0 ? ` · #${tick}` : ''}
          </span>
          <button
            type="button"
            className="tag tag--muted"
            style={{ cursor: 'pointer' }}
            title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? '▶' : '⏸'}
          </button>
          <button
            type="button"
            className="tag tag--muted"
            style={{ cursor: 'pointer' }}
            title="Refresh now"
            onClick={() => void load()}
          >
            ↻
          </button>
        </div>
      </div>
      <div className="panel-body">
        {error ? (
          <div className="empty text-[12px] text-[color:var(--error)]">{error}</div>
        ) : null}
        {foto.sessions.length === 0 ? (
          <div className="empty text-[12px]">
            {foto.stale !== false
              ? 'No fresh session sample in the last 30s (Live never replays old rows). '
              : 'No active sessions in the latest sample. '}
            The collector reads <span className="font-mono">{sampleHint}</span> every ~10s
            {paused ? ' — resume polling or refresh' : ' — this view refreshes automatically'}. Also see{' '}
            <Link href={`/instances/${instanceId}/sessions`} className="underline">
              Sessions
            </Link>
            .
          </div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: '36rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>State</th>
                  <th>Waiting</th>
                  <th>Application</th>
                  <th>Role</th>
                  <th className="text-right">Query</th>
                  <th className="text-right">Txn</th>
                  <th>SQL</th>
                </tr>
              </thead>
              <tbody>
                {foto.sessions.map((sesion) => (
                  <tr key={sesion.pid}>
                    <td className="font-mono text-[11px]">{sesion.pid}</td>
                    <td className="text-[11px]">{sesion.state}</td>
                    <td className="text-[11px]">
                      <span
                        className={`tag ${sesion.waitType === 'Lock' ? 'tag--error' : 'tag--muted'}`}
                        title={waitHelp(sesion.waitType ?? 'CPU')}
                        style={{ cursor: 'help' }}
                      >
                        {sesion.waitType ?? 'CPU'}
                        {sesion.waitEvent ? ` · ${sesion.waitEvent}` : ''}
                      </span>
                    </td>
                    <td className="font-mono text-[11px]">{sesion.application}</td>
                    <td className="font-mono text-[11px]">{sesion.username}</td>
                    <td className="num">{liveDuration(sesion.queryMs)}</td>
                    <td className="num">{liveDuration(sesion.xactMs)}</td>
                    <td className="max-w-[28rem] truncate font-mono text-[10px] text-foreground-muted">
                      {sesion.query ?? '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-foreground-muted">
          Auto-refresh every {POLL_MS / 1000}s while this tab is open. Hover a wait tag for what it means.
          For wait profiles over time, use{' '}
          <Link href={`/instances/${instanceId}/sessions`} className="underline">
            Sessions
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
