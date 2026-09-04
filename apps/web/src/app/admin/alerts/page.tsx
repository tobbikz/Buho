import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import { requireAdmin } from '@/lib/session';
import { logConsoleEvent } from '@/lib/users';
import {
  ALERT_PACK_META,
  ALERT_SETTINGS_DEFAULTS,
  createSilence,
  deleteAlertChannel,
  deleteAlertDefinition,
  deleteAlertRule,
  getAlertPack,
  getAlertSettings,
  listActiveSilences,
  listAlertChannels,
  listAlertDefinitions,
  listAlertRules,
  listKnownCheckIds,
  saveAlertDefinition,
  saveAlertPack,
  saveAlertRule,
  saveAlertSettings,
  upsertAlertChannel,
  upsertWebhookChannel,
  type AlertPackConfig,
  type AlertRule,
  type AlertSettings,
  type AlertSeverity,
  type CustomAlertDefinition,
  type CustomThresholdType,
} from '@/lib/alerts';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function saveChannel(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const kindRaw = String(formData.get('kind') ?? 'webhook').trim();
  const kind = (
    ['webhook', 'slack', 'teams', 'telegram', 'rocketchat', 'smtp'].includes(kindRaw)
      ? kindRaw
      : 'webhook'
  ) as 'webhook' | 'slack' | 'teams' | 'telegram' | 'rocketchat' | 'smtp';
  const name =
    String(formData.get('name') ?? kind).trim() ||
    ({
      webhook: 'Webhook',
      slack: 'Slack',
      teams: 'Teams',
      telegram: 'Telegram',
      rocketchat: 'Rocket.Chat',
      smtp: 'Email SMTP',
    }[kind] ?? 'Channel');
  const enabled = formData.get('enabled') === 'on';

  if (kind === 'smtp') {
    const host = String(formData.get('smtpHost') ?? '').trim();
    const from = String(formData.get('smtpFrom') ?? '').trim();
    const to = String(formData.get('smtpTo') ?? '').trim();
    if (!host || !from || !to) {
      redirect(
        '/admin/alerts?error=' +
          encodeURIComponent('SMTP needs host, from, and to'),
      );
    }
    await upsertAlertChannel({
      name,
      kind: 'smtp',
      config: {
        host,
        port: Number(formData.get('smtpPort') ?? 587) || 587,
        secure: formData.get('smtpSecure') === 'on',
        user: String(formData.get('smtpUser') ?? '').trim() || undefined,
        pass: String(formData.get('smtpPass') ?? '').trim() || undefined,
        from,
        to,
      },
      enabled,
    });
  } else if (kind === 'telegram') {

    const botToken = String(formData.get('botToken') ?? '').trim();
    const chatId = String(formData.get('chatId') ?? '').trim();
    if (!botToken || !chatId) {
      redirect(
        '/admin/alerts?error=' +
          encodeURIComponent('Telegram needs bot token and chat id'),
      );
    }
    await upsertAlertChannel({
      name,
      kind: 'telegram',
      config: { botToken, chatId },
      enabled,
    });
  } else {
    const url = String(formData.get('url') ?? '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      redirect(
        '/admin/alerts?error=' +
          encodeURIComponent('Channel URL must start with http:// or https://'),
      );
    }
    if (kind === 'webhook') {
      await upsertWebhookChannel(name, url, enabled);
    } else {
      await upsertAlertChannel({ name, kind, config: { url }, enabled });
    }
  }

  await logConsoleEvent(session.username, 'alert channel saved', `${kind}:${name}`);
  revalidatePath('/admin/alerts');
  revalidatePath('/alerts');
  redirect('/admin/alerts?ok=1');
}

async function savePack(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const pack: AlertPackConfig = {};
  for (const item of ALERT_PACK_META) {
    pack[item.id] = {
      enabled: formData.get(`pack_${item.id}_enabled`) === 'on',
      warning: Number(formData.get(`pack_${item.id}_warning`) ?? item.defaults.warning),
      critical: Number(formData.get(`pack_${item.id}_critical`) ?? item.defaults.critical),
    };
  }
  await saveAlertPack(pack, session.username);
  await logConsoleEvent(session.username, 'alert pack updated', `${ALERT_PACK_META.length} items`);
  revalidatePath('/admin/alerts');
  revalidatePath('/alerts');
  redirect('/admin/alerts?ok=1');
}

async function removeChannel(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const channelId = Number(formData.get('channelId'));
  await deleteAlertChannel(channelId);
  await logConsoleEvent(session.username, 'alert channel deleted', String(channelId));
  revalidatePath('/admin/alerts');
  redirect('/admin/alerts?ok=1');
}

async function saveSettings(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const settings: AlertSettings = {
    enabled: formData.get('enabled') === 'on',
    minSeverity: String(formData.get('minSeverity') ?? 'warning') as AlertSeverity,
    hysteresis: {
      critical: Math.max(1, Number(formData.get('hystCritical') ?? 1) || 1),
      warning: Math.max(1, Number(formData.get('hystWarning') ?? 2) || 2),
      info: Math.max(1, Number(formData.get('hystInfo') ?? 3) || 3),
    },
  };
  await saveAlertSettings(settings, session.username);
  await logConsoleEvent(session.username, 'alert settings updated', JSON.stringify(settings));
  revalidatePath('/admin/alerts');
  redirect('/admin/alerts?ok=1');
}

async function saveRule(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const ruleIdRaw = String(formData.get('ruleId') ?? '').trim();
  const severities = (['critical', 'warning', 'info'] as const).filter(
    (severity) => formData.get(`sev_${severity}`) === 'on',
  );
  const channelIds = String(formData.get('channelIds') ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  const hysteresisRaw = String(formData.get('hysteresis') ?? '').trim();
  await saveAlertRule({
    ruleId: ruleIdRaw ? Number(ruleIdRaw) : undefined,
    name: String(formData.get('name') ?? 'Rule').trim() || 'Rule',
    enabled: formData.get('enabled') === 'on',
    matchCheckId: String(formData.get('matchCheckId') ?? '').trim() || null,
    matchInstanceId: String(formData.get('matchInstanceId') ?? '').trim()
      ? Number(formData.get('matchInstanceId'))
      : null,
    matchEngine: String(formData.get('matchEngine') ?? '').trim() || null,
    matchSeverities: (severities.length ? severities : ['critical', 'warning']) as AlertSeverity[],
    action: formData.get('action') === 'suppress' ? 'suppress' : 'alert',
    hysteresis: hysteresisRaw ? Number(hysteresisRaw) : null,
    severityOverride: (String(formData.get('severityOverride') ?? '').trim() ||
      null) as AlertSeverity | null,
    channelIds,
    notifyResolved: formData.get('notifyResolved') === 'on',
    priority: Math.max(1, Number(formData.get('priority') ?? 100) || 100),
    updatedBy: session.username,
  });
  await logConsoleEvent(session.username, 'alert rule saved', String(formData.get('name')));
  revalidatePath('/admin/alerts');
  revalidatePath('/alerts');
  redirect('/admin/alerts?ok=1');
}

async function removeRule(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const ruleId = Number(formData.get('ruleId'));
  await deleteAlertRule(ruleId);
  await logConsoleEvent(session.username, 'alert rule deleted', String(ruleId));
  revalidatePath('/admin/alerts');
  redirect('/admin/alerts?ok=1');
}

async function saveDefinition(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const name = String(formData.get('name') ?? '').trim();
  const sql = String(formData.get('sql') ?? '').trim();
  const messageTemplate = String(formData.get('messageTemplate') ?? '').trim();
  if (!name || !sql || !messageTemplate) {
    redirect(
      '/admin/alerts?error=' +
        encodeURIComponent('Custom alert needs name, SQL, and message template'),
    );
  }
  const matchInstanceRaw = String(formData.get('matchInstanceId') ?? '').trim();
  const matchEngine = String(formData.get('matchEngine') ?? '').trim() || null;
  const matchInstanceId = matchInstanceRaw ? Number(matchInstanceRaw) : null;
  if (!matchInstanceId && !matchEngine) {
    redirect(
      '/admin/alerts?error=' +
        encodeURIComponent('Scope the alert to an instance and/or engine'),
    );
  }
  let threshold: Record<string, unknown> = {};
  const thresholdRaw = String(formData.get('thresholdJson') ?? '').trim();
  if (thresholdRaw) {
    try {
      threshold = JSON.parse(thresholdRaw) as Record<string, unknown>;
    } catch {
      redirect('/admin/alerts?error=' + encodeURIComponent('threshold JSON is invalid'));
    }
  }
  const channelIds = String(formData.get('channelIds') ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  const displayColumns = String(formData.get('displayColumns') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const hysteresisRaw = String(formData.get('hysteresis') ?? '').trim();
  await saveAlertDefinition({
    name,
    title: String(formData.get('title') ?? name).trim() || name,
    enabled: formData.get('enabled') === 'on',
    matchInstanceId,
    matchEngine,
    severity: String(formData.get('severity') ?? 'warning') as AlertSeverity,
    sql,
    thresholdType: String(formData.get('thresholdType') ?? 'rows') as CustomThresholdType,
    threshold,
    messageTemplate,
    remediation: String(formData.get('remediation') ?? '').trim(),
    recoveryMessage: String(formData.get('recoveryMessage') ?? '').trim() || null,
    sendRecovery: formData.get('sendRecovery') === 'on',
    cooldownMinutes: Math.max(0, Number(formData.get('cooldownMinutes') ?? 0) || 0),
    displayColumns,
    hysteresis: hysteresisRaw ? Number(hysteresisRaw) : null,
    channelIds,
    updatedBy: session.username,
  });
  await logConsoleEvent(session.username, 'alert definition saved', name);
  revalidatePath('/admin/alerts');
  revalidatePath('/alerts');
  redirect('/admin/alerts?ok=1');
}

async function removeDefinition(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const definitionId = Number(formData.get('definitionId'));
  await deleteAlertDefinition(definitionId);
  await logConsoleEvent(session.username, 'alert definition deleted', String(definitionId));
  revalidatePath('/admin/alerts');
  redirect('/admin/alerts?ok=1');
}

async function addSilence(formData: FormData) {
  'use server';
  const session = await requireAdmin();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) {
    redirect('/admin/alerts?error=' + encodeURIComponent('Silence reason is required'));
  }
  const instanceRaw = String(formData.get('instanceId') ?? '').trim();
  const checkId = String(formData.get('checkId') ?? '').trim() || null;
  await createSilence({
    instanceId: instanceRaw ? Number(instanceRaw) : null,
    checkId,
    reason,
    hours: Number(formData.get('hours') ?? 2) || 2,
    createdBy: session.username,
  });
  await logConsoleEvent(session.username, 'alert silence created', reason);
  revalidatePath('/admin/alerts');
  revalidatePath('/alerts');
  redirect('/admin/alerts?ok=1');
}

export default async function AdminAlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { error, ok } = await searchParams;

  let settings: AlertSettings;
  let pack: AlertPackConfig;
  let channels: Awaited<ReturnType<typeof listAlertChannels>>;
  let rules: AlertRule[];
  let definitions: CustomAlertDefinition[];
  let silences: Awaited<ReturnType<typeof listActiveSilences>>;
  let instances: Array<{ instanceId: number; alias: string; engine: string }>;
  let checkIds: string[];
  try {
    [settings, pack, channels, rules, definitions, silences, instances, checkIds] = await Promise.all([
      getAlertSettings(),
      getAlertPack(),
      listAlertChannels(),
      listAlertRules(),
      listAlertDefinitions(),
      listActiveSilences(),
      query<{ instance_id: string; alias: string; engine: string }>(
        `select instance_id::text, alias, engine from buho.instances order by alias`,
      ).then((rows) =>
        rows.map((row) => ({
          instanceId: Number(row.instance_id),
          alias: row.alias,
          engine: row.engine,
        })),
      ),
      listKnownCheckIds(),
    ]);
  } catch (storeError) {
    return <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />;
  }

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <header className="page-header">
        <div>
          <h1 className="page-title">Alerts</h1>
          <p className="page-sub">
            Default system pack (CPU, memory, disk, connections…) with editable thresholds,
            then custom SQL alerts, then routing rules. Channels: webhook, Slack, Teams, Telegram,
            Rocket.Chat.
          </p>
        </div>
      </header>

      {ok ? <p className="text-[12px] text-[var(--success)]">Saved.</p> : null}
      {error ? <p className="text-[12px] text-[var(--error)]">{error}</p> : null}

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Global defaults</span>
        </div>
        <form action={saveSettings} className="flex flex-col gap-3 p-4">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
            Enable alerting
          </label>
          <label className="text-[12px] text-foreground-muted">
            Minimum severity (when no rule matches)
            <select name="minSeverity" className="mt-1 block w-full max-w-xs" defaultValue={settings.minSeverity}>
              <option value="critical">critical</option>
              <option value="warning">warning</option>
              <option value="info">info</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-4">
            {(['critical', 'warning', 'info'] as const).map((key) => (
              <label key={key} className="text-[12px] text-foreground-muted">
                Hysteresis · {key}
                <input
                  className="mt-1 block w-24"
                  type="number"
                  min={1}
                  max={20}
                  name={`hyst${key[0]!.toUpperCase()}${key.slice(1)}`}
                  defaultValue={settings.hysteresis[key] ?? ALERT_SETTINGS_DEFAULTS.hysteresis[key]}
                />
              </label>
            ))}
          </div>
          <button type="submit" className="btn btn--primary self-start">
            Save defaults
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Default system pack</span>
          <span className="text-[11px] text-foreground-muted">
            {ALERT_PACK_META.length} alerts · only thresholds are editable · check id = {'pack.<id>'}
          </span>
        </div>
        <p className="px-4 pt-3 text-[11px] text-foreground-muted max-w-3xl">
          Redgate-style baseline. Host items need host metrics enabled on the instance. Missing
          metrics are skipped (no false alarms). Everything else goes under Custom SQL alerts.
        </p>
        <form action={savePack} className="p-4">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>On</th>
                  <th>Alert</th>
                  <th>Warning</th>
                  <th>Critical</th>
                </tr>
              </thead>
              <tbody>
                {ALERT_PACK_META.map((item) => {
                  const row = pack[item.id] ?? item.defaults;
                  return (
                    <tr key={item.id}>
                      <td>
                        <input
                          type="checkbox"
                          name={`pack_${item.id}_enabled`}
                          defaultChecked={row.enabled}
                        />
                      </td>
                      <td className="text-[12px]">
                        <div>{item.title}</div>
                        <div className="font-mono text-[10px] text-foreground-muted">
                          pack.{item.id}
                          {item.requiresHost ? ' · needs host metrics' : ''}
                        </div>
                      </td>
                      <td>
                        <input
                          className="w-24"
                          type="number"
                          step="any"
                          name={`pack_${item.id}_warning`}
                          defaultValue={row.warning}
                        />
                        <span className="ml-1 text-[10px] text-foreground-muted">{item.unit}</span>
                      </td>
                      <td>
                        <input
                          className="w-24"
                          type="number"
                          step="any"
                          name={`pack_${item.id}_critical`}
                          defaultValue={row.critical}
                        />
                        <span className="ml-1 text-[10px] text-foreground-muted">{item.unit}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="submit" className="btn btn--primary mt-3">
            Save pack thresholds
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Notification channels</span>
          <span className="text-[11px] text-foreground-muted">{channels.length} configured</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Target</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.channelId}>
                  <td className="text-[12px]">{channel.name}</td>
                  <td className="font-mono text-[10px]">{channel.kind}</td>
                  <td className="font-mono text-[10px] text-foreground-muted max-w-[24rem] truncate">
                    {channel.kind === 'telegram'
                      ? channel.chatId || '—'
                      : channel.url || '—'}
                  </td>
                  <td>{channel.enabled ? 'yes' : 'no'}</td>
                  <td>
                    <form action={removeChannel}>
                      <input type="hidden" name="channelId" value={channel.channelId} />
                      <button type="submit" className="btn">
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form action={saveChannel} className="flex flex-col gap-3 border-t border-[var(--border)] p-4">
          <div className="text-[12px] font-medium">Add channel</div>
          <label className="text-[12px] text-foreground-muted">
            Kind
            <select className="mt-1 block w-full max-w-md" name="kind" defaultValue="slack">
              <option value="slack">Slack (incoming webhook)</option>
              <option value="teams">Microsoft Teams (incoming webhook)</option>
              <option value="telegram">Telegram (bot token + chat id)</option>
              <option value="rocketchat">Rocket.Chat (incoming webhook)</option>
              <option value="smtp">Email (SMTP)</option>
              <option value="webhook">Generic webhook (JSON)</option>
            </select>
          </label>
          <label className="text-[12px] text-foreground-muted">
            Name
            <input className="mt-1 block w-full max-w-md" name="name" placeholder="Ops Slack" />
          </label>
          <label className="text-[12px] text-foreground-muted">
            Webhook URL (Slack / Teams / Rocket.Chat / generic)
            <input
              className="mt-1 block w-full max-w-xl"
              name="url"
              placeholder="https://hooks.slack.com/services/… or Teams/RC webhook"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
            <label className="text-[12px] text-foreground-muted">
              Telegram bot token
              <input className="mt-1 block w-full" name="botToken" type="password" autoComplete="off" />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Telegram chat id
              <input className="mt-1 block w-full" name="chatId" placeholder="@channel or -100…" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="enabled" defaultChecked />
            Enabled
          </label>
          <button type="submit" className="btn btn--primary self-start">
            Add channel
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Rules</span>
          <span className="text-[11px] text-foreground-muted">
            lower priority number wins · more specific matchers break ties
          </span>
        </div>
        {rules.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Pri</th>
                  <th>Name</th>
                  <th>Match</th>
                  <th>Action</th>
                  <th>Channels</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.ruleId}>
                    <td className="num font-mono text-[11px]">{rule.priority}</td>
                    <td className="text-[12px]">
                      {rule.name}
                      {!rule.enabled ? <span className="tag tag--muted ml-2">off</span> : null}
                    </td>
                    <td className="font-mono text-[10px] text-foreground-muted">
                      {[
                        rule.matchCheckId && `check=${rule.matchCheckId}`,
                        rule.matchInstanceId != null && `instance=${rule.matchInstanceId}`,
                        rule.matchEngine && `engine=${rule.matchEngine}`,
                        `sev=${rule.matchSeverities.join('|')}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                    <td className="text-[12px]">
                      {rule.action}
                      {rule.hysteresis != null ? ` · hyst ${rule.hysteresis}` : ''}
                      {rule.severityOverride ? ` · as ${rule.severityOverride}` : ''}
                    </td>
                    <td className="font-mono text-[10px]">
                      {rule.channelIds.length ? rule.channelIds.join(',') : 'all'}
                    </td>
                    <td>
                      <form action={removeRule}>
                        <input type="hidden" name="ruleId" value={rule.ruleId} />
                        <button type="submit" className="btn">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-4 text-[13px] text-foreground-muted">
            No rules yet — every finding uses global defaults and all enabled webhooks.
          </p>
        )}

        <form action={saveRule} className="flex flex-col gap-3 border-t border-[var(--border)] p-4">
          <div className="text-[12px] font-medium">Add rule</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-[12px] text-foreground-muted">
              Name
              <input className="mt-1 block w-full" name="name" required placeholder="Suppress noisy lab check" />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Priority (1 = highest)
              <input className="mt-1 block w-full" type="number" name="priority" min={1} defaultValue={50} />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Check id (optional)
              <input className="mt-1 block w-full" name="matchCheckId" list="check-ids" placeholder="mssql_databases" />
              <datalist id="check-ids">
                {checkIds.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Instance (optional)
              <select className="mt-1 block w-full" name="matchInstanceId" defaultValue="">
                <option value="">Any instance</option>
                {instances.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instance.alias} ({instance.engine})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Engine (optional)
              <select className="mt-1 block w-full" name="matchEngine" defaultValue="">
                <option value="">Any engine</option>
                <option value="postgres">postgres</option>
                <option value="mariadb">mariadb</option>
                <option value="mssql">mssql</option>
                <option value="mongodb">mongodb</option>
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Action
              <select className="mt-1 block w-full" name="action" defaultValue="alert">
                <option value="alert">alert (notify)</option>
                <option value="suppress">suppress (never notify)</option>
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Hysteresis override
              <input className="mt-1 block w-full" type="number" min={1} max={20} name="hysteresis" placeholder="default" />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Severity override
              <select className="mt-1 block w-full" name="severityOverride" defaultValue="">
                <option value="">keep finding severity</option>
                <option value="critical">critical</option>
                <option value="warning">warning</option>
                <option value="info">info</option>
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted md:col-span-2">
              Channel ids (comma-separated, empty = all enabled)
              <input
                className="mt-1 block w-full"
                name="channelIds"
                placeholder={channels.map((channel) => channel.channelId).join(',') || 'add a webhook first'}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-[12px]">
            {(['critical', 'warning', 'info'] as const).map((severity) => (
              <label key={severity} className="flex items-center gap-2">
                <input type="checkbox" name={`sev_${severity}`} defaultChecked={severity !== 'info'} />
                match {severity}
              </label>
            ))}
            <label className="flex items-center gap-2">
              <input type="checkbox" name="enabled" defaultChecked />
              enabled
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="notifyResolved" defaultChecked />
              notify on resolve
            </label>
          </div>
          <button type="submit" className="btn btn--primary self-start">
            Add rule
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Custom SQL alerts</span>
          <span className="text-[11px] text-foreground-muted">
            prod Sys_Alerts granularity · check id = {'custom.<name>'}
          </span>
        </div>
        <p className="px-4 pt-3 text-[11px] text-foreground-muted max-w-3xl">
          Same idea as alerts_config.yaml: your SQL + threshold type (rows, numeric, freshness,
          …) + message with {'{rows}'} / {'{all_rows}'}. Scope to an engine or instance. Built-in
          checks still run; this is for the alerts only you can write.
        </p>
        {definitions.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Threshold</th>
                  <th>Sev</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {definitions.map((def) => (
                  <tr key={def.definitionId}>
                    <td className="text-[12px]">
                      <span className="font-mono text-[10px]">custom.{def.name}</span>
                      <div className="text-foreground-muted">{def.title}</div>
                      {!def.enabled ? <span className="tag tag--muted">off</span> : null}
                    </td>
                    <td className="font-mono text-[10px] text-foreground-muted">
                      {[
                        def.matchEngine && `engine=${def.matchEngine}`,
                        def.matchInstanceId != null && `instance=${def.matchInstanceId}`,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="font-mono text-[10px]">
                      {def.thresholdType} {JSON.stringify(def.threshold)}
                    </td>
                    <td>{def.severity}</td>
                    <td>
                      <form action={removeDefinition}>
                        <input type="hidden" name="definitionId" value={def.definitionId} />
                        <button type="submit" className="btn">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-3 text-[12px] text-foreground-muted">
            No custom alerts yet — add one below (e.g. replica lag query with threshold_type rows).
          </p>
        )}
        <form action={saveDefinition} className="flex flex-col gap-3 border-t border-[var(--border)] p-4">
          <div className="text-[12px] font-medium">Add custom SQL alert</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-[12px] text-foreground-muted">
              Name (slug)
              <input className="mt-1 block w-full" name="name" placeholder="mssql_user_sessions_high" required />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Title
              <input className="mt-1 block w-full" name="title" placeholder="User sessions high" required />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Engine scope
              <select className="mt-1 block w-full" name="matchEngine" defaultValue="">
                <option value="">(none — use instance)</option>
                <option value="postgres">postgres</option>
                <option value="mariadb">mariadb</option>
                <option value="mssql">mssql</option>
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Instance scope
              <select className="mt-1 block w-full" name="matchInstanceId" defaultValue="">
                <option value="">(none — use engine)</option>
                {instances.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instance.alias} ({instance.engine})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Severity
              <select className="mt-1 block w-full" name="severity" defaultValue="warning">
                <option value="critical">critical</option>
                <option value="warning">warning</option>
                <option value="info">info</option>
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted">
              Threshold type
              <select className="mt-1 block w-full" name="thresholdType" defaultValue="rows">
                <option value="rows">rows (min_rows)</option>
                <option value="no_rows">no_rows</option>
                <option value="numeric">numeric</option>
                <option value="freshness">freshness</option>
                <option value="text_match">text_match</option>
                <option value="numeric_per_row">numeric_per_row</option>
                <option value="numeric_max_across_rows">numeric_max_across_rows</option>
                <option value="delta">delta</option>
              </select>
            </label>
            <label className="text-[12px] text-foreground-muted md:col-span-2">
              Threshold JSON
              <input
                className="mt-1 block w-full font-mono text-[11px]"
                name="thresholdJson"
                defaultValue='{"min_rows":1}'
                placeholder='{"min_rows":1} or {"column":"lag_s","operator":">","value":30}'
              />
            </label>
            <label className="text-[12px] text-foreground-muted md:col-span-2">
              SQL
              <textarea
                className="mt-1 block w-full min-h-[7rem] font-mono text-[11px]"
                name="sql"
                required
                placeholder="select … — runs with the monitor login on each matching instance"
              />
            </label>
            <label className="text-[12px] text-foreground-muted md:col-span-2">
              Message template
              <textarea
                className="mt-1 block w-full min-h-[3rem] font-mono text-[11px]"
                name="messageTemplate"
                required
                defaultValue="{rows} row(s) matched.&#10;&#10;{all_rows}"
              />
            </label>
            <label className="text-[12px] text-foreground-muted md:col-span-2">
              Remediation
              <input className="mt-1 block w-full" name="remediation" />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Display columns (comma)
              <input className="mt-1 block w-full" name="displayColumns" placeholder="database_name,missing_types" />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Channel ids
              <input
                className="mt-1 block w-full"
                name="channelIds"
                placeholder={channels.map((c) => c.channelId).join(',') || 'optional'}
              />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Hysteresis
              <input className="mt-1 block w-full" type="number" min={1} max={20} name="hysteresis" placeholder="default" />
            </label>
            <label className="text-[12px] text-foreground-muted">
              Cooldown minutes
              <input className="mt-1 block w-full" type="number" min={0} name="cooldownMinutes" defaultValue={0} />
            </label>
            <label className="text-[12px] text-foreground-muted md:col-span-2">
              Recovery message (optional)
              <input className="mt-1 block w-full" name="recoveryMessage" />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-[12px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="enabled" defaultChecked />
              enabled
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="sendRecovery" defaultChecked />
              notify on resolve
            </label>
          </div>
          <button type="submit" className="btn btn--primary self-start">
            Add custom alert
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Temporary silence</span>
        </div>
        <form action={addSilence} className="flex flex-col gap-3 p-4">
          <label className="text-[12px] text-foreground-muted">
            Instance (optional)
            <select className="mt-1 block w-full max-w-md" name="instanceId" defaultValue="">
              <option value="">All instances</option>
              {instances.map((instance) => (
                <option key={instance.instanceId} value={instance.instanceId}>
                  {instance.alias}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-foreground-muted">
            Check id (optional)
            <input className="mt-1 block w-full max-w-md" name="checkId" list="check-ids" />
          </label>
          <label className="text-[12px] text-foreground-muted">
            Hours
            <input className="mt-1 block w-24" type="number" name="hours" min={1} max={168} defaultValue={2} />
          </label>
          <label className="text-[12px] text-foreground-muted">
            Reason
            <input className="mt-1 block w-full max-w-xl" name="reason" required />
          </label>
          <button type="submit" className="btn self-start">
            Add silence
          </button>
        </form>
        {silences.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Reason</th>
                  <th>Ends</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {silences.map((silence) => (
                  <tr key={silence.silenceId}>
                    <td className="text-[12px]">
                      {silence.alias ?? 'all instances'}
                      {silence.checkId ? ` · ${silence.checkId}` : ''}
                    </td>
                    <td className="text-[12px]">{silence.reason}</td>
                    <td className="font-mono text-[10px] text-foreground-muted">{formatAgo(silence.endsAt)}</td>
                    <td className="text-[11px] text-foreground-muted">{silence.createdBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
