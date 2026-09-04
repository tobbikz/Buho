'use client';

import { useState } from 'react';

type ChannelKind =
  | 'webhook'
  | 'slack'
  | 'teams'
  | 'discord'
  | 'googlechat'
  | 'mattermost'
  | 'telegram'
  | 'rocketchat'
  | 'pagerduty'
  | 'smtp';

const URL_KINDS: ChannelKind[] = [
  'webhook',
  'slack',
  'teams',
  'discord',
  'googlechat',
  'mattermost',
  'rocketchat',
];

export function AlertChannelForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  const [kind, setKind] = useState<ChannelKind>('slack');
  const needsUrl = URL_KINDS.includes(kind);

  return (
    <form action={action} className="flex flex-col gap-3 border-t border-[var(--border)] p-4">
      <div className="text-[12px] font-medium">Add channel</div>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Kind
        <select
          className="input max-w-md"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as ChannelKind)}
        >
          <option value="slack">Slack (incoming webhook)</option>
          <option value="teams">Microsoft Teams (incoming webhook)</option>
          <option value="discord">Discord (incoming webhook)</option>
          <option value="googlechat">Google Chat (incoming webhook)</option>
          <option value="mattermost">Mattermost (incoming webhook)</option>
          <option value="telegram">Telegram (bot token + chat id)</option>
          <option value="rocketchat">Rocket.Chat (incoming webhook)</option>
          <option value="pagerduty">PagerDuty (Events API v2)</option>
          <option value="smtp">Email (SMTP)</option>
          <option value="webhook">Generic webhook (JSON)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
        Name
        <input className="input max-w-md" name="name" placeholder="Ops Slack" />
      </label>

      {needsUrl ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          Webhook URL
          <input
            className="input max-w-xl"
            name="url"
            required
            placeholder="https://hooks.slack.com/services/… / Discord / Teams / Chat / Mattermost / RC"
          />
        </label>
      ) : null}

      {kind === 'telegram' ? (
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            Bot token
            <input className="input" name="botToken" type="password" autoComplete="off" required />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            Chat id
            <input className="input" name="chatId" placeholder="@channel or -100…" required />
          </label>
        </div>
      ) : null}

      {kind === 'pagerduty' ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted max-w-xl">
          Routing key (Events API v2 integration key)
          <input
            className="input font-mono"
            name="routingKey"
            type="password"
            autoComplete="off"
            required
            placeholder="R0… from PagerDuty service integration"
          />
        </label>
      ) : null}

      {kind === 'smtp' ? (
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            SMTP host
            <input className="input font-mono" name="smtpHost" placeholder="smtp.example.com" required />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            Port
            <input className="input font-mono" name="smtpPort" type="number" defaultValue={587} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            From
            <input className="input" name="smtpFrom" placeholder="buho@example.com" required />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            To
            <input className="input" name="smtpTo" placeholder="ops@example.com" required />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            Username (optional)
            <input className="input" name="smtpUser" autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            Password (optional)
            <input className="input" name="smtpPass" type="password" autoComplete="off" />
          </label>
          <label className="flex items-center gap-2 text-[13px] font-normal normal-case tracking-normal text-foreground sm:col-span-2">
            <input type="checkbox" name="smtpSecure" />
            Use TLS (secure)
          </label>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="enabled" defaultChecked />
        Enabled
      </label>
      <button type="submit" className="btn btn--primary self-start">
        Add channel
      </button>
    </form>
  );
}
