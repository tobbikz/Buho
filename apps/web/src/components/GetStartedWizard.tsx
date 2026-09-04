'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AddDatabaseForm } from '@/components/AddDatabaseForm';
import { AlertChannelForm } from '@/components/AlertChannelForm';
import { ChannelTestButton } from '@/components/ChannelTestButton';

type ChannelRow = {
  channelId: number;
  name: string;
  kind: string;
  enabled: boolean;
};

type InstanceRow = {
  instanceId: number;
  alias: string;
  score: number | null;
  critical: number;
  warning: number;
};

export function GetStartedWizard({
  step,
  addDatabaseAction,
  saveChannelAction,
  channels,
  instances,
}: {
  step: 1 | 2 | 3;
  addDatabaseAction: (formData: FormData) => Promise<void>;
  saveChannelAction: (formData: FormData) => Promise<void>;
  channels: ChannelRow[];
  instances: InstanceRow[];
}) {
  const [live, setLive] = useState(instances);
  const ready = live.some((row) => row.score !== null);

  useEffect(() => {
    if (step !== 2) return;
    const id = window.setInterval(() => {
      void fetch('/api/admin/get-started-status')
        .then((r) => r.json())
        .then((body: { instances?: InstanceRow[] }) => {
          if (Array.isArray(body.instances)) setLive(body.instances);
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [step]);

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap gap-2 text-[12px]">
        {[
          { n: 1 as const, label: 'Add database' },
          { n: 2 as const, label: 'First green check' },
          { n: 3 as const, label: 'Test alert' },
        ].map((entry) => (
          <li key={entry.n}>
            <Link
              href={`/get-started?step=${entry.n}`}
              className={`tag ${step === entry.n ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.n}. {entry.label}
            </Link>
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Step 1 · Add a database</span>
            <span className="text-[11px] text-foreground-muted">
              Test the connection, then save. The collector picks it up within ~30s.
            </span>
          </div>
          <div className="p-4">
            <AddDatabaseForm action={addDatabaseAction} />
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Step 2 · Wait for the first check run</span>
            <span className="text-[11px] text-foreground-muted">Auto-refreshes every 5s</span>
          </div>
          <div className="p-4 flex flex-col gap-3">
            {live.length === 0 ? (
              <div className="empty">
                No instances yet.{' '}
                <Link href="/get-started?step=1" className="link">
                  Add a database
                </Link>{' '}
                first.
              </div>
            ) : (
              <div className="table-scroll" style={{ maxHeight: 'none' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Score</th>
                      <th>Critical</th>
                      <th>Warning</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {live.map((row) => (
                      <tr key={row.instanceId}>
                        <td>{row.alias}</td>
                        <td className="font-mono">
                          {row.score === null ? 'waiting…' : `${row.score}/100`}
                        </td>
                        <td>{row.critical}</td>
                        <td>{row.warning}</td>
                        <td>
                          <Link href={`/instances/${row.instanceId}`} className="link">
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ready ? (
              <div className="notice notice--ok">
                First check results are in. A low score from missing backups/HA is expected in a lab —
                that is configuration posture, not a crash. Continue to wire a test alert.
              </div>
            ) : (
              <div className="notice">
                Waiting for the collector. Keep this tab open, or confirm the collector container is
                running.
              </div>
            )}
            <div className="flex gap-2">
              <Link href="/get-started?step=1" className="btn">
                Back
              </Link>
              <Link
                href="/get-started?step=3"
                className={`btn btn--primary ${ready ? '' : 'opacity-60'}`}
              >
                Continue to test alert
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Step 3 · Add a channel and send a test</span>
            <span className="text-[11px] text-foreground-muted">
              Slack / Teams / Discord / webhook / …
            </span>
          </div>
          <div className="p-4 flex flex-col gap-4">
            {channels.length > 0 ? (
              <div className="table-scroll" style={{ maxHeight: 'none' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Kind</th>
                      <th>Enabled</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((channel) => (
                      <tr key={channel.channelId}>
                        <td>{channel.name}</td>
                        <td className="font-mono text-[10px]">{channel.kind}</td>
                        <td>{channel.enabled ? 'yes' : 'no'}</td>
                        <td>
                          <ChannelTestButton channelId={channel.channelId} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">No channels yet — add one below, then press Test.</div>
            )}
            <AlertChannelForm action={saveChannelAction} />
            <div className="flex gap-2">
              <Link href="/get-started?step=2" className="btn">
                Back
              </Link>
              <Link href="/" className="btn btn--primary">
                Done — open Fleet
              </Link>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
