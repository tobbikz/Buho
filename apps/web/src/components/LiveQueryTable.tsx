'use client';

import { useState } from 'react';
import { formatDuration } from '@/lib/format';

export interface LiveQueryRow {
  pid: number;
  state: string;
  application: string | null;
  queryMs: number | null;
  query: string | null;
  explainable: boolean;
}

export function LiveQueryTable({
  rows,
  instanceId,
  planPid,
  planText,
  planState,
  planMessage,
  explain,
}: {
  rows: LiveQueryRow[];
  instanceId: number;
  planPid: string | null;
  planText: string | null;
  planState: string | null;
  planMessage: string | null;
  explain: (formData: FormData) => Promise<void>;
}) {
  const [openPid, setOpenPid] = useState<number | null>(planPid ? Number(planPid) : null);
  const pending = planState === 'pendiente' || planState === 'corriendo';

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>State</th>
            <th>Session</th>
            <th className="text-right">Query</th>
            <th>Text</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((session) => {
            const open = openPid === session.pid;
            const showingPlan = planPid === String(session.pid);
            return (
              <tr key={session.pid} className="align-top">
                <td className="font-mono text-[11px]">{session.state}</td>
                <td className="font-mono text-[11px]">
                  pid {session.pid}
                  {session.application ? ` · ${session.application}` : ''}
                </td>
                <td className="num">
                  {session.queryMs === null ? '—' : formatDuration(session.queryMs / 1000)}
                </td>
                <td className="max-w-[40rem]">
                  <button
                    type="button"
                    className="block w-full cursor-pointer truncate text-left font-mono text-[11px]"
                    title={session.query ?? ''}
                    onClick={() => setOpenPid(open ? null : session.pid)}
                  >
                    {session.query?.trim() || '—'}
                  </button>
                  {open ? (
                    <div className="mt-2 border border-border bg-surface-muted p-2">
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                        {session.query?.trim() || '(no query text)'}
                      </pre>
                      {session.explainable ? (
                        <form action={explain} className="mt-2">
                          <input type="hidden" name="instanceId" value={instanceId} />
                          <input type="hidden" name="pid" value={session.pid} />
                          <input type="hidden" name="sql" value={session.query ?? ''} />
                          <button type="submit" className="btn-secondary">
                            Explain
                          </button>
                        </form>
                      ) : (
                        <p className="mt-2 text-[12px] text-foreground-secondary">
                          PostgreSQL cannot EXPLAIN this statement. REFRESH, VACUUM, and other utility
                          commands have no plan.
                        </p>
                      )}
                      {showingPlan && pending ? (
                        <p className="mt-2 font-mono text-[11px] text-foreground-muted">Waiting for EXPLAIN…</p>
                      ) : null}
                      {showingPlan && planMessage ? (
                        <p className="mt-2 text-[12px]" style={{ color: 'var(--warning)' }}>
                          {planMessage}
                        </p>
                      ) : null}
                      {showingPlan && planText ? (
                        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap border border-border bg-[var(--surface)] p-2 font-mono text-[11px]">
                          {planText}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
