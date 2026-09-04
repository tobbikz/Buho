import type { CheckResult } from '@buho/checks';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'pending' | 'firing' | 'resolved';
export type AlertChannelKind = 'webhook' | 'slack' | 'teams' | 'telegram' | 'rocketchat' | 'smtp';

export interface AlertSettings {
  enabled: boolean;
  /** Minimum severity to open alerts. info is ignored by default. */
  minSeverity: AlertSeverity;
  /** Consecutive check cycles before firing. */
  hysteresis: { critical: number; warning: number; info: number };
}

export const ALERT_SETTINGS_DEFAULTS: AlertSettings = {
  enabled: true,
  minSeverity: 'warning',
  hysteresis: { critical: 1, warning: 2, info: 3 },
};

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function severityAtLeast(value: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[value] >= SEVERITY_RANK[minimum];
}

export function alertDedupeKey(checkId: string, object?: string | null): string {
  return `${checkId}|${object ?? ''}`;
}

export interface AlertRow {
  alertId: number;
  instanceId: number;
  alias: string;
  engine: string;
  dedupeKey: string;
  checkId: string;
  object: string | null;
  severity: AlertSeverity;
  title: string;
  message: string;
  remediation: string;
  status: AlertStatus;
  pendingCount: number;
  firedAt: Date | null;
  resolvedAt: Date | null;
  lastSeenAt: Date;
  updatedAt: Date;
}

export interface AlertChannelConfig {
  url?: string;
  headers?: Record<string, string>;
  /** Telegram bot token (without bot prefix handling — paste as BotFather gave it). */
  botToken?: string;
  /** Telegram chat id (@channel or numeric). */
  chatId?: string;
  /** SMTP relay */
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
}

export interface AlertChannelRow {
  channelId: number;
  name: string;
  kind: AlertChannelKind;
  config: AlertChannelConfig;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertReconcileSummary {
  opened: number;
  fired: number;
  resolved: number;
  silenced: number;
  suppressed: number;
}

export interface AlertRuleRow {
  ruleId: number;
  name: string;
  enabled: boolean;
  matchCheckId: string | null;
  matchInstanceId: number | null;
  matchEngine: string | null;
  matchSeverities: AlertSeverity[];
  action: 'alert' | 'suppress';
  hysteresis: number | null;
  severityOverride: AlertSeverity | null;
  channelIds: number[];
  notifyResolved: boolean;
  priority: number;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface AlertDeliveryJob {
  deliveryId: number;
  alertId: number;
  channelId: number;
  event: 'fired' | 'resolved';
  attempts: number;
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

export type AlertNotifyPayload = {
  alertId: number;
  instanceId: number;
  alias: string;
  engine: string;
  checkId: string;
  object: string | null;
  severity: string;
  title: string;
  message: string;
  remediation: string;
  firedAt: Date | null;
  resolvedAt: Date | null;
};

/** Canonical JSON body (generic webhook / automation). */
export function webhookPayload(
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
): Record<string, unknown> {
  return {
    source: 'buho',
    event,
    alert_id: alert.alertId,
    instance: {
      id: alert.instanceId,
      alias: alert.alias,
      engine: alert.engine,
    },
    check_id: alert.checkId,
    object: alert.object,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    remediation: alert.remediation,
    fired_at: alert.firedAt?.toISOString() ?? null,
    resolved_at: alert.resolvedAt?.toISOString() ?? null,
  };
}

function statusLabel(event: 'fired' | 'resolved'): string {
  return event === 'fired' ? 'FIRING' : 'RESOLVED';
}

function plainText(event: 'fired' | 'resolved', alert: AlertNotifyPayload): string {
  const object = alert.object ? ` · ${alert.object}` : '';
  const lines = [
    `Búho · ${statusLabel(event)} · ${alert.severity.toUpperCase()}`,
    `${alert.alias} (${alert.engine}) · ${alert.checkId}${object}`,
    alert.title,
    alert.message,
  ];
  if (alert.remediation.trim()) lines.push(`Remediation: ${alert.remediation}`);
  return lines.join('\n');
}

/** Slack incoming webhook. */
export function slackPayload(
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
): Record<string, unknown> {
  const color =
    event === 'resolved' ? '#2eb886' : alert.severity === 'critical' ? '#e01e5a' : '#ecb22e';
  return {
    text: `Búho ${statusLabel(event)}: ${alert.title}`,
    attachments: [
      {
        color,
        mrkdwn_in: ['text', 'fields'],
        title: alert.title,
        text: plainText(event, alert),
        footer: 'Búho',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

/** Microsoft Teams Incoming Webhook (MessageCard). */
export function teamsPayload(
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
): Record<string, unknown> {
  const theme =
    event === 'resolved' ? '00FF00' : alert.severity === 'critical' ? 'FF0000' : 'FFAA00';
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: theme,
    summary: `Búho ${statusLabel(event)}: ${alert.title}`,
    sections: [
      {
        activityTitle: `Búho · ${statusLabel(event)} · ${alert.severity}`,
        activitySubtitle: `${alert.alias} (${alert.engine}) · ${alert.checkId}`,
        text: `${alert.message}${alert.remediation ? `\n\n**Remediation:** ${alert.remediation}` : ''}`,
        markdown: true,
      },
    ],
  };
}

/** Telegram sendMessage body (URL carries the bot token). */
export function telegramPayload(
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
  chatId: string,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    text: plainText(event, alert).slice(0, 4000),
    disable_web_page_preview: true,
  };
}

/** Rocket.Chat incoming webhook. */
export function rocketchatPayload(
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
): Record<string, unknown> {
  return {
    text: plainText(event, alert),
    alias: 'Búho',
  };
}

export function resolveChannelDelivery(
  kind: AlertChannelKind,
  config: AlertChannelConfig,
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const headers = { ...(config.headers ?? {}) };

  if (kind === 'smtp') {
    throw new Error('smtp is delivered via deliverSmtp(), not HTTP');
  }

  if (kind === 'telegram') {
    const token = (config.botToken ?? '').trim();
    const chatId = (config.chatId ?? '').trim();
    if (!token || !chatId) throw new Error('telegram needs botToken and chatId');
    return {
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      headers: { 'content-type': 'application/json', ...headers },
      body: telegramPayload(event, alert, chatId),
    };
  }

  const url = (config.url ?? '').trim();
  if (!url) throw new Error(`${kind} url missing`);

  switch (kind) {
    case 'slack':
      return {
        url,
        headers: { 'content-type': 'application/json', ...headers },
        body: slackPayload(event, alert),
      };
    case 'teams':
      return {
        url,
        headers: { 'content-type': 'application/json', ...headers },
        body: teamsPayload(event, alert),
      };
    case 'rocketchat':
      return {
        url,
        headers: { 'content-type': 'application/json', ...headers },
        body: rocketchatPayload(event, alert),
      };
    case 'webhook':
    default:
      return {
        url,
        headers: { 'content-type': 'application/json', ...headers },
        body: webhookPayload(event, alert),
      };
  }
}

export function smtpMailContent(
  event: 'fired' | 'resolved',
  alert: AlertNotifyPayload,
): { subject: string; text: string } {
  return {
    subject: `[Búho ${statusLabel(event)}] ${alert.severity}: ${alert.title} · ${alert.alias}`,
    text: plainText(event, alert),
  };
}

export function actionableFindings(
  results: CheckResult[],
  settings: AlertSettings,
): CheckResult[] {
  return results.filter((result) => severityAtLeast(result.severity, settings.minSeverity));
}

/** Lowest priority number wins. More specific matchers sort first when tied. */
export function pickAlertRule(
  rules: AlertRuleRow[],
  finding: CheckResult,
  instanceId: number,
  engine: string,
): AlertRuleRow | null {
  const matches = rules
    .filter((rule) => rule.enabled)
    .filter((rule) => {
      if (rule.matchCheckId && rule.matchCheckId !== finding.checkId) return false;
      if (rule.matchInstanceId != null && rule.matchInstanceId !== instanceId) return false;
      if (rule.matchEngine && rule.matchEngine !== engine) return false;
      if (
        rule.matchSeverities.length > 0 &&
        !rule.matchSeverities.includes(finding.severity as AlertSeverity)
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const score = (rule: AlertRuleRow) =>
        (rule.matchCheckId ? 4 : 0) +
        (rule.matchInstanceId != null ? 2 : 0) +
        (rule.matchEngine ? 1 : 0);
      return score(b) - score(a);
    });
  return matches[0] ?? null;
}
