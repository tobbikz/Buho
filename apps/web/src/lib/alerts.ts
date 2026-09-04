import { query } from './db';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'pending' | 'firing' | 'resolved';

export interface AlertSettings {
  enabled: boolean;
  minSeverity: AlertSeverity;
  hysteresis: { critical: number; warning: number; info: number };
}

export const ALERT_SETTINGS_DEFAULTS: AlertSettings = {
  enabled: true,
  minSeverity: 'warning',
  hysteresis: { critical: 1, warning: 2, info: 3 },
};

export interface FleetAlert {
  alertId: number;
  instanceId: number;
  alias: string;
  engine: string;
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
}

export interface AlertChannel {
  channelId: number;
  name: string;
  kind:
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
  url: string;
  chatId: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface AlertSilence {
  silenceId: number;
  instanceId: number | null;
  alias: string | null;
  checkId: string | null;
  reason: string;
  startsAt: Date;
  endsAt: Date;
  createdBy: string | null;
}

export async function getAlertSettings(): Promise<AlertSettings> {
  const rows = await query<{ value: Partial<AlertSettings> }>(
    "select value from buho.settings where key = 'alerts'",
  );
  const stored = rows[0]?.value;
  if (!stored) {
    return { ...ALERT_SETTINGS_DEFAULTS, hysteresis: { ...ALERT_SETTINGS_DEFAULTS.hysteresis } };
  }
  return {
    enabled: stored.enabled ?? ALERT_SETTINGS_DEFAULTS.enabled,
    minSeverity: stored.minSeverity ?? ALERT_SETTINGS_DEFAULTS.minSeverity,
    hysteresis: { ...ALERT_SETTINGS_DEFAULTS.hysteresis, ...(stored.hysteresis ?? {}) },
  };
}

export async function saveAlertSettings(settings: AlertSettings, updatedBy: string): Promise<void> {
  await query(
    `insert into buho.settings (key, value, updated_at, updated_by)
          values ('alerts', $1::jsonb, now(), $2)
     on conflict (key) do update
            set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [JSON.stringify(settings), updatedBy],
  );
}

export async function listFleetAlerts(statuses: AlertStatus[] = ['pending', 'firing']): Promise<FleetAlert[]> {
  const rows = await query<Record<string, unknown>>(
    `select a.alert_id, a.instance_id, i.alias, i.engine, a.check_id, a.object,
            a.severity, a.title, a.message, a.remediation, a.status, a.pending_count,
            a.fired_at, a.resolved_at, a.last_seen_at
       from buho.alerts a
       join buho.instances i using (instance_id)
      where a.status = any($1::text[])
      order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
               a.last_seen_at desc
      limit 300`,
    [statuses],
  );
  return rows.map((row) => ({
    alertId: Number(row['alert_id']),
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine']),
    checkId: String(row['check_id']),
    object: (row['object'] as string | null) ?? null,
    severity: row['severity'] as AlertSeverity,
    title: String(row['title']),
    message: String(row['message']),
    remediation: String(row['remediation']),
    status: row['status'] as AlertStatus,
    pendingCount: Number(row['pending_count']),
    firedAt: (row['fired_at'] as Date | null) ?? null,
    resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    lastSeenAt: row['last_seen_at'] as Date,
  }));
}

export async function countOpenAlerts(): Promise<{ firing: number; pending: number; critical: number }> {
  const rows = await query<{ status: string; severity: string; n: string }>(
    `select status, severity, count(*)::text as n
       from buho.alerts
      where status in ('pending', 'firing')
      group by status, severity`,
  );
  let firing = 0;
  let pending = 0;
  let critical = 0;
  for (const row of rows) {
    const n = Number(row.n);
    if (row.status === 'firing') firing += n;
    if (row.status === 'pending') pending += n;
    if (row.severity === 'critical') critical += n;
  }
  return { firing, pending, critical };
}

export async function listAlertChannels(): Promise<AlertChannel[]> {
  const rows = await query<Record<string, unknown>>(
    `select channel_id, name, kind, config, enabled, updated_at
       from buho.alert_channels
      order by channel_id`,
  );
  return rows.map((row) => {
    const config = (row['config'] ?? {}) as {
      url?: string;
      chatId?: string;
      botToken?: string;
      routingKey?: string;
      host?: string;
      from?: string;
      to?: string;
    };
    const raw = String(row['kind'] ?? 'webhook');
    const kind = (
      [
        'webhook',
        'slack',
        'teams',
        'discord',
        'googlechat',
        'mattermost',
        'telegram',
        'rocketchat',
        'pagerduty',
        'smtp',
      ].includes(raw)
        ? raw
        : 'webhook'
    ) as AlertChannel['kind'];
    let url = config.url ?? '';
    if (!url && config.botToken) url = '(telegram bot)';
    if (kind === 'pagerduty') url = config.routingKey ? '(pagerduty routing key)' : '—';
    if (kind === 'smtp') {
      url = [config.host, config.from && `from ${config.from}`, config.to && `→ ${config.to}`]
        .filter(Boolean)
        .join(' · ');
    }
    return {
      channelId: Number(row['channel_id']),
      name: String(row['name']),
      kind,
      url,
      chatId: config.chatId ?? '',
      enabled: Boolean(row['enabled']),
      updatedAt: row['updated_at'] as Date,
    };
  });
}


export async function listActiveSilences(): Promise<AlertSilence[]> {
  const rows = await query<Record<string, unknown>>(
    `select s.silence_id, s.instance_id, i.alias, s.check_id, s.reason,
            s.starts_at, s.ends_at, s.created_by
       from buho.alert_silences s
       left join buho.instances i using (instance_id)
      where s.ends_at > now()
      order by s.ends_at`,
  );
  return rows.map((row) => ({
    silenceId: Number(row['silence_id']),
    instanceId: row['instance_id'] == null ? null : Number(row['instance_id']),
    alias: (row['alias'] as string | null) ?? null,
    checkId: (row['check_id'] as string | null) ?? null,
    reason: String(row['reason']),
    startsAt: row['starts_at'] as Date,
    endsAt: row['ends_at'] as Date,
    createdBy: (row['created_by'] as string | null) ?? null,
  }));
}

export async function createSilence(input: {
  instanceId: number | null;
  checkId: string | null;
  reason: string;
  hours: number;
  createdBy: string;
}): Promise<void> {
  await query(
    `insert into buho.alert_silences (instance_id, check_id, reason, ends_at, created_by)
          values ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
    [
      input.instanceId,
      input.checkId,
      input.reason,
      String(Math.max(1, Math.min(168, input.hours))),
      input.createdBy,
    ],
  );
}


export interface AlertRule {
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
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const rows = await query<Record<string, unknown>>(
    `select rule_id, name, enabled, match_check_id, match_instance_id, match_engine,
            match_severities, action, hysteresis, severity_override, channel_ids,
            notify_resolved, priority
       from buho.alert_rules
      order by priority, rule_id`,
  );
  return rows.map((row) => ({
    ruleId: Number(row['rule_id']),
    name: String(row['name']),
    enabled: Boolean(row['enabled']),
    matchCheckId: (row['match_check_id'] as string | null) ?? null,
    matchInstanceId: row['match_instance_id'] == null ? null : Number(row['match_instance_id']),
    matchEngine: (row['match_engine'] as string | null) ?? null,
    matchSeverities: ((row['match_severities'] as string[]) ?? []) as AlertSeverity[],
    action: row['action'] as 'alert' | 'suppress',
    hysteresis: row['hysteresis'] == null ? null : Number(row['hysteresis']),
    severityOverride: (row['severity_override'] as AlertSeverity | null) ?? null,
    channelIds: ((row['channel_ids'] as Array<string | number>) ?? []).map(Number),
    notifyResolved: Boolean(row['notify_resolved']),
    priority: Number(row['priority'] ?? 100),
  }));
}

export async function saveAlertRule(input: {
  ruleId?: number;
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
  updatedBy: string;
}): Promise<void> {
  if (input.ruleId) {
    await query(
      `update buho.alert_rules
          set name=$2, enabled=$3, match_check_id=$4, match_instance_id=$5, match_engine=$6,
              match_severities=$7::text[], action=$8, hysteresis=$9, severity_override=$10,
              channel_ids=$11::bigint[], notify_resolved=$12, priority=$13,
              updated_at=now(), updated_by=$14
        where rule_id=$1`,
      [
        input.ruleId, input.name, input.enabled, input.matchCheckId, input.matchInstanceId,
        input.matchEngine, input.matchSeverities, input.action, input.hysteresis,
        input.severityOverride, input.channelIds, input.notifyResolved, input.priority, input.updatedBy,
      ],
    );
    return;
  }
  await query(
    `insert into buho.alert_rules
       (name, enabled, match_check_id, match_instance_id, match_engine, match_severities,
        action, hysteresis, severity_override, channel_ids, notify_resolved, priority, updated_by)
     values ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10::bigint[],$11,$12,$13)`,
    [
      input.name, input.enabled, input.matchCheckId, input.matchInstanceId, input.matchEngine,
      input.matchSeverities, input.action, input.hysteresis, input.severityOverride,
      input.channelIds, input.notifyResolved, input.priority, input.updatedBy,
    ],
  );
}

export async function deleteAlertRule(ruleId: number): Promise<void> {
  await query(`delete from buho.alert_rules where rule_id = $1`, [ruleId]);
}

export async function listKnownCheckIds(): Promise<string[]> {
  const rows = await query<{ check_id: string }>(
    `select distinct check_id from (
        select check_id from buho.check_results
        union
        select 'custom.' || name from buho.alert_definitions
        union
        select 'pack.' || unnest(array[
          'host_cpu','host_memory','host_swap','host_disk','host_load','host_iowait',
          'connections','blocking','block_wait','replication_lag','cache_hit','xid_age'
        ])
      ) q
      order by check_id`,
  );
  return rows.map((row) => row.check_id);
}

export type CustomThresholdType =
  | 'rows'
  | 'no_rows'
  | 'numeric'
  | 'freshness'
  | 'text_match'
  | 'numeric_per_row'
  | 'numeric_max_across_rows'
  | 'delta';

export interface CustomAlertDefinition {
  definitionId: number;
  name: string;
  title: string;
  enabled: boolean;
  matchInstanceId: number | null;
  matchEngine: string | null;
  severity: AlertSeverity;
  sql: string;
  thresholdType: CustomThresholdType;
  threshold: Record<string, unknown>;
  messageTemplate: string;
  remediation: string;
  recoveryMessage: string | null;
  sendRecovery: boolean;
  cooldownMinutes: number;
  displayColumns: string[];
  hysteresis: number | null;
  channelIds: number[];
}

export async function listAlertDefinitions(): Promise<CustomAlertDefinition[]> {
  const rows = await query<Record<string, unknown>>(
    `select definition_id, name, title, enabled, match_instance_id, match_engine, severity,
            sql, threshold_type, threshold, message_template, remediation, recovery_message,
            send_recovery, cooldown_minutes, display_columns, hysteresis, channel_ids
       from buho.alert_definitions
      order by name`,
  );
  return rows.map((row) => ({
    definitionId: Number(row['definition_id']),
    name: String(row['name']),
    title: String(row['title']),
    enabled: Boolean(row['enabled']),
    matchInstanceId:
      row['match_instance_id'] == null ? null : Number(row['match_instance_id']),
    matchEngine: (row['match_engine'] as string | null) ?? null,
    severity: row['severity'] as AlertSeverity,
    sql: String(row['sql']),
    thresholdType: row['threshold_type'] as CustomThresholdType,
    threshold: (row['threshold'] as Record<string, unknown>) ?? {},
    messageTemplate: String(row['message_template']),
    remediation: String(row['remediation'] ?? ''),
    recoveryMessage: (row['recovery_message'] as string | null) ?? null,
    sendRecovery: Boolean(row['send_recovery']),
    cooldownMinutes: Number(row['cooldown_minutes'] ?? 0),
    displayColumns: (row['display_columns'] as string[]) ?? [],
    hysteresis: row['hysteresis'] == null ? null : Number(row['hysteresis']),
    channelIds: ((row['channel_ids'] as Array<string | number>) ?? []).map(Number),
  }));
}

export async function saveAlertDefinition(input: {
  definitionId?: number;
  name: string;
  title: string;
  enabled: boolean;
  matchInstanceId: number | null;
  matchEngine: string | null;
  severity: AlertSeverity;
  sql: string;
  thresholdType: CustomThresholdType;
  threshold: Record<string, unknown>;
  messageTemplate: string;
  remediation: string;
  recoveryMessage: string | null;
  sendRecovery: boolean;
  cooldownMinutes: number;
  displayColumns: string[];
  hysteresis: number | null;
  channelIds: number[];
  updatedBy: string;
}): Promise<void> {
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const params = [
    name,
    input.title.trim() || name,
    input.enabled,
    input.matchInstanceId,
    input.matchEngine,
    input.severity,
    input.sql,
    input.thresholdType,
    JSON.stringify(input.threshold),
    input.messageTemplate,
    input.remediation,
    input.recoveryMessage,
    input.sendRecovery,
    input.cooldownMinutes,
    input.displayColumns,
    input.hysteresis,
    input.channelIds,
    input.updatedBy,
  ];
  if (input.definitionId) {
    await query(
      `update buho.alert_definitions
          set name=$2, title=$3, enabled=$4, match_instance_id=$5, match_engine=$6,
              severity=$7, sql=$8, threshold_type=$9, threshold=$10::jsonb,
              message_template=$11, remediation=$12, recovery_message=$13,
              send_recovery=$14, cooldown_minutes=$15, display_columns=$16::text[],
              hysteresis=$17, channel_ids=$18::bigint[], updated_at=now(), updated_by=$19
        where definition_id=$1`,
      [input.definitionId, ...params],
    );
    return;
  }
  await query(
    `insert into buho.alert_definitions
       (name, title, enabled, match_instance_id, match_engine, severity, sql, threshold_type,
        threshold, message_template, remediation, recovery_message, send_recovery,
        cooldown_minutes, display_columns, hysteresis, channel_ids, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::text[],$16,$17::bigint[],$18)`,
    params,
  );
}

export async function deleteAlertDefinition(definitionId: number): Promise<void> {
  await query(`delete from buho.alert_definitions where definition_id = $1`, [definitionId]);
}

export async function upsertWebhookChannel(
  name: string,
  url: string,
  enabled: boolean,
  channelId?: number,
): Promise<void> {
  await upsertAlertChannel({
    channelId,
    name,
    kind: 'webhook',
    config: { url },
    enabled,
  });
}

export async function upsertAlertChannel(input: {
  channelId?: number;
  name: string;
  kind: AlertChannel['kind'];
  config: Record<string, unknown>;
  enabled: boolean;
}): Promise<void> {
  if (input.channelId) {
    await query(
      `update buho.alert_channels
          set name = $2, kind = $3, config = $4::jsonb, enabled = $5, updated_at = now()
        where channel_id = $1`,
      [input.channelId, input.name, input.kind, JSON.stringify(input.config), input.enabled],
    );
    return;
  }
  await query(
    `insert into buho.alert_channels (name, kind, config, enabled)
          values ($1, $2, $3::jsonb, $4)`,
    [input.name, input.kind, JSON.stringify(input.config), input.enabled],
  );
}

export type PackThresholds = { enabled: boolean; warning: number; critical: number };
export type AlertPackConfig = Record<string, PackThresholds>;

export const ALERT_PACK_META: Array<{
  id: string;
  title: string;
  description: string;
  unit: string;
  requiresHost?: boolean;
  defaults: PackThresholds;
}> = [
  {
    id: 'host_cpu',
    title: 'Host CPU high',
    description: 'CPU usage on the database host',
    unit: '%',
    requiresHost: true,
    defaults: { enabled: true, warning: 85, critical: 95 },
  },
  {
    id: 'host_memory',
    title: 'Host memory high',
    description: 'RAM used on the database host',
    unit: '%',
    requiresHost: true,
    defaults: { enabled: true, warning: 85, critical: 95 },
  },
  {
    id: 'host_swap',
    title: 'Host swap in use',
    description: 'Swap usage',
    unit: '%',
    requiresHost: true,
    defaults: { enabled: true, warning: 10, critical: 40 },
  },
  {
    id: 'host_disk',
    title: 'Host disk almost full',
    description: 'Data volume used percent',
    unit: '%',
    requiresHost: true,
    defaults: { enabled: true, warning: 85, critical: 95 },
  },
  {
    id: 'host_load',
    title: 'Host load high',
    description: 'Load average per CPU core',
    unit: '×/core',
    requiresHost: true,
    defaults: { enabled: true, warning: 1.5, critical: 3 },
  },
  {
    id: 'host_iowait',
    title: 'Host I/O wait high',
    description: 'CPU time waiting on disk',
    unit: '%',
    requiresHost: true,
    defaults: { enabled: true, warning: 25, critical: 50 },
  },
  {
    id: 'connections',
    title: 'Connection saturation',
    description: 'Sessions vs configured maximum',
    unit: '%',
    defaults: { enabled: true, warning: 75, critical: 90 },
  },
  {
    id: 'blocking',
    title: 'Sessions blocked',
    description: 'Sessions waiting on locks',
    unit: 'sessions',
    defaults: { enabled: true, warning: 3, critical: 10 },
  },
  {
    id: 'block_wait',
    title: 'Long lock wait',
    description: 'Worst blocked session wait',
    unit: 's',
    defaults: { enabled: true, warning: 30, critical: 120 },
  },
  {
    id: 'replication_lag',
    title: 'Replication lag high',
    description: 'Replay / apply lag',
    unit: 's',
    defaults: { enabled: true, warning: 30, critical: 120 },
  },
  {
    id: 'cache_hit',
    title: 'Buffer cache hit low',
    description: 'Cache hit ratio (lower is worse)',
    unit: '%',
    defaults: { enabled: true, warning: 95, critical: 90 },
  },
  {
    id: 'xid_age',
    title: 'Transaction ID age high',
    description: 'XID age % of wraparound (PostgreSQL)',
    unit: '%',
    defaults: { enabled: true, warning: 50, critical: 75 },
  },
];

export function defaultAlertPack(): AlertPackConfig {
  const pack: AlertPackConfig = {};
  for (const item of ALERT_PACK_META) pack[item.id] = { ...item.defaults };
  return pack;
}

export async function getAlertPack(): Promise<AlertPackConfig> {
  const rows = await query<{ value: Partial<AlertPackConfig> }>(
    "select value from buho.settings where key = 'alert_pack'",
  );
  const base = defaultAlertPack();
  const stored = rows[0]?.value;
  if (!stored) return base;
  for (const item of ALERT_PACK_META) {
    const row = stored[item.id];
    if (!row) continue;
    base[item.id] = {
      enabled: row.enabled ?? item.defaults.enabled,
      warning: Number(row.warning) || item.defaults.warning,
      critical: Number(row.critical) || item.defaults.critical,
    };
  }
  return base;
}

export async function saveAlertPack(pack: AlertPackConfig, updatedBy: string): Promise<void> {
  await query(
    `insert into buho.settings (key, value, updated_at, updated_by)
          values ('alert_pack', $1::jsonb, now(), $2)
     on conflict (key) do update
            set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [JSON.stringify(pack), updatedBy],
  );
}

export async function deleteAlertChannel(channelId: number): Promise<void> {
  await query(`delete from buho.alert_channels where channel_id = $1`, [channelId]);
}

/** One-shot channel probe (Admin → Alerts / Get started). */
export async function sendChannelTest(channelId: number): Promise<void> {
  const { Store } = await import('@buho/store');
  const url = process.env['BUHO_STORE_URL'];
  if (!url) {
    // Dev fallback mirrors db.ts without importing its private helper.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const configPath = resolve(process.env['BUHO_CONFIG'] ?? '../../config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { store?: { url?: string } };
    if (!parsed.store?.url) throw new Error('BUHO_STORE_URL missing');
    const store = new Store(parsed.store.url);
    try {
      await store.sendChannelTest(channelId);
    } finally {
      await store.close();
    }
    return;
  }
  const store = new Store(url);
  try {
    await store.sendChannelTest(channelId);
  } finally {
    await store.close();
  }
}
