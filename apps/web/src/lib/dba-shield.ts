import {
  backupAgeHours,
  backupKindLabel,
  backupState,
  backupStateLabel,
  getInstanceInventory,
  type BackupRow,
  type BackupState,
} from '@/lib/estate';
import { formatDays, getCapacityBudget } from '@/lib/capacity';
import { formatDuration, formatPct } from '@/lib/format';
import { getHostSummary, getLockEpisodes, getTopStatements, type LockEpisode } from '@/lib/queries';
import { getWaitShares } from '@/lib/sessions';

/** Where the pain is — used to defend the DBA when the root cause is elsewhere. */
export type BlameLane =
  | 'application'
  | 'host_io'
  | 'locks'
  | 'cpu'
  | 'capacity'
  | 'recovery'
  | 'config'
  | 'ha'
  | 'connections'
  | 'healthy'
  | 'unknown';

/** Who should own the next action — defends the DBA in the war room. */
export type PageOwner = 'application' | 'infrastructure' | 'dba' | 'shared' | 'watch';

export type ShieldTone = 'ok' | 'warn' | 'error' | 'neutral';

export interface ShieldChip {
  label: string;
  tone: ShieldTone;
  href?: string;
  title?: string;
}

export interface LockStory {
  activeCount: number;
  worstWaitSeconds: number;
  blockerPid: number | null;
  blockerUser: string | null;
  blockerApp: string | null;
  blockerQuery: string | null;
  blockerXactSeconds: number | null;
  waiterCount: number;
  waiterQuery: string | null;
  summary: string;
}

export interface RecoveryReadiness {
  score: number; // 0–100
  tone: ShieldTone;
  label: string;
  detail: string;
  rpoHours: number | null;
}

export interface ChangeRadarItem {
  kind: 'settings' | 'jobs_failed' | 'jobs_disabled';
  label: string;
  tone: ShieldTone;
  href: string;
}

export interface HostDbCorrelation {
  iowaitPct: number | null;
  ioWaitShare: number | null;
  verdict: string;
  tone: ShieldTone;
  blameHost: boolean;
}

export interface NoisyNeighbor {
  queryid: string | null;
  sharePct: number | null;
  execMs: number;
  calls: number;
  username: string | null;
  query: string | null;
  summary: string;
  tone: ShieldTone;
  /** Resolved owner for paging (tag / application / username). */
  ownerLabel: string | null;
  ownerPageLabel: string | null;
}

export interface BlameLaneVerdict {
  lane: BlameLane;
  tone: ShieldTone;
  headline: string;
  body: string;
  pageOwner: PageOwner;
  pageLabel: string;
}

export interface BlamePicture {
  /**
   * @deprecated Prefer `pain` / `risk` — kept as the louder of the two for chips/compat.
   */
  lane: BlameLane;
  tone: ShieldTone;
  headline: string;
  body: string;
  pageOwner: PageOwner;
  pageLabel: string;
  /** Live symptoms: locks, host I/O, pools, client waits, noisy query, disk fill. */
  pain: BlameLaneVerdict;
  /** Standing risk: recovery/RPO chain, config/jobs — may be red while traffic looks fine. */
  risk: BlameLaneVerdict;
  chips: ShieldChip[];
  lockStory: LockStory | null;
  recovery: RecoveryReadiness;
  changes: ChangeRadarItem[];
  hostDb: HostDbCorrelation;
  noisy: NoisyNeighbor | null;
  /** Plain-text summary (not shown in UI by default). */
  brief: string;
}

export function pageOwnerForLane(lane: BlameLane): { owner: PageOwner; label: string } {
  switch (lane) {
    case 'locks':
    case 'application':
    case 'cpu':
    case 'connections':
      return {
        owner: 'application',
        label: 'Page · Application / owners of the blocker query',
      };
    case 'host_io':
      return {
        owner: 'infrastructure',
        label: 'Page · Infra / storage — host I/O, not SQL knobs',
      };
    case 'capacity':
      return {
        owner: 'infrastructure',
        label: 'Page · Infra / capacity — volume growth or cleanup',
      };
    case 'ha':
      return {
        owner: 'shared',
        label: 'Page · DBA + Infra — HA / replication path',
      };
    case 'recovery':
    case 'config':
      return {
        owner: 'dba',
        label: 'Page · DBA — recovery chain or config/jobs',
      };
    case 'healthy':
      return {
        owner: 'watch',
        label: 'No page yet · no smoking gun; keep watching App + Host',
      };
    default:
      return {
        owner: 'shared',
        label: 'Collecting · keep App + Infra + DBA on the bridge',
      };
  }
}

function asVerdict(
  core: Pick<BlameLaneVerdict, 'lane' | 'tone' | 'headline' | 'body'>,
): BlameLaneVerdict {
  const page = pageOwnerForLane(core.lane);
  return { ...core, pageOwner: page.owner, pageLabel: page.label };
}

export function formatIncidentBrief(
  picture: Omit<BlamePicture, 'brief'>,
  meta: { alias?: string; instanceId: number },
): string {
  const lines = [
    `Búho blame picture · ${meta.alias ?? `instance ${meta.instanceId}`}`,
    `Pain now: ${picture.pain.headline}`,
    `  ${picture.pain.pageLabel}`,
    `  ${picture.pain.body}`,
    `DBA risk: ${picture.risk.headline}`,
    `  ${picture.risk.pageLabel}`,
    `  ${picture.risk.body}`,
    '',
    `Recovery: ${picture.recovery.label} — ${picture.recovery.detail}`,
    `Host↔DB: ${picture.hostDb.verdict}`,
  ];
  if (picture.lockStory) {
    lines.push(`Locks: ${picture.lockStory.summary}`);
    lines.push(`Blocker SQL: ${clip(picture.lockStory.blockerQuery)}`);
  }
  if (picture.noisy && picture.noisy.sharePct != null && picture.noisy.sharePct >= 20) {
    lines.push(`Noisy neighbor: ${picture.noisy.summary}`);
    lines.push(`SQL: ${clip(picture.noisy.query, 200)}`);
  }
  for (const c of picture.changes.slice(0, 3)) {
    lines.push(`Change: ${c.label}`);
  }
  lines.push('', `Console: /instances/${meta.instanceId}/blame`);
  return lines.join('\n');
}

function clip(sql: string | null | undefined, n = 120): string {
  if (!sql) return '—';
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function recoveryFromBackups(backups: BackupRow[]): RecoveryReadiness {
  if (backups.length === 0) {
    return {
      score: 40,
      tone: 'neutral',
      label: 'Recovery unknown',
      detail: 'No backup inventory yet — cannot prove RPO.',
      rpoHours: null,
    };
  }

  const rank: Record<BackupState, number> = {
    sin_recuperacion: 0,
    atrasado: 45,
    no_verificable: 70,
    ok: 100,
  };

  let worstState: BackupState = 'ok';
  let worstScore = 100;
  let worstRow = backups[0]!;
  let bestRpo: number | null = null;

  for (const row of backups) {
    const state = backupState(row);
    const score = rank[state] ?? 50;
    if (score < worstScore) {
      worstScore = score;
      worstState = state;
      worstRow = row;
    }
    const age = backupAgeHours(row);
    if (age !== null && (bestRpo === null || age < bestRpo)) bestRpo = age;
  }

  // Binlog/WAL "on" without a full backup catalog still scores mid if not broken.
  if (worstState === 'ok' && backups.every((r) => r.kind === 'wal_archive')) {
    worstScore = Math.min(worstScore, 75);
  }

  const tone: ShieldTone =
    worstScore < 40 ? 'error' : worstScore < 70 ? 'warn' : worstScore >= 90 ? 'ok' : 'neutral';

  return {
    score: worstScore,
    tone,
    label: `Recovery ${worstScore}/100`,
    detail: `${backupKindLabel(worstRow)} · ${backupStateLabel(worstRow)}${
      bestRpo !== null ? ` · best age ${bestRpo.toFixed(1)} h` : ''
    }`,
    rpoHours: bestRpo,
  };
}

function recoveryFromInventory(
  inventory: Awaited<ReturnType<typeof getInstanceInventory>> | null,
): RecoveryReadiness {
  return recoveryFromBackups(inventory?.backups ?? []);
}

function buildLockStory(episodes: LockEpisode[]): LockStory | null {
  const active = episodes.filter((e) => e.active);
  if (active.length === 0) return null;

  const byBlocker = new Map<number, LockEpisode[]>();
  for (const ep of active) {
    const key = ep.blockerPid ?? -1;
    const list = byBlocker.get(key) ?? [];
    list.push(ep);
    byBlocker.set(key, list);
  }

  let best: { blockerPid: number; eps: LockEpisode[]; wait: number } | null = null;
  for (const [blockerPid, eps] of byBlocker) {
    const wait = Math.max(...eps.map((e) => e.waitSeconds));
    if (!best || wait > best.wait || eps.length > best.eps.length) {
      best = { blockerPid, eps, wait };
    }
  }
  if (!best) return null;

  const head = best.eps.sort((a, b) => b.waitSeconds - a.waitSeconds)[0]!;
  const app = head.blockerApplication || head.blockerUser || 'unknown';
  const summary =
    `Blocker pid ${head.blockerPid ?? '?'} (${app}) holds ` +
    `${best.eps.length} waiter(s) for up to ${formatDuration(best.wait)}` +
    (head.blockerXactSeconds != null
      ? ` · blocker xact ${formatDuration(head.blockerXactSeconds)}`
      : '');

  return {
    activeCount: active.length,
    worstWaitSeconds: best.wait,
    blockerPid: head.blockerPid,
    blockerUser: head.blockerUser,
    blockerApp: head.blockerApplication,
    blockerQuery: head.blockerQuery,
    blockerXactSeconds: head.blockerXactSeconds,
    waiterCount: best.eps.length,
    waiterQuery: head.waiterQuery,
    summary,
  };
}

type LaneCore = Pick<BlameLaneVerdict, 'lane' | 'tone' | 'headline' | 'body'>;

/** Live / performance symptoms — separate from standing DBA risk. */
function pickPainNow(args: {
  lockStory: LockStory | null;
  hostDb: HostDbCorrelation;
  noisy: NoisyNeighbor | null;
  waitShares: Awaited<ReturnType<typeof getWaitShares>>;
  connectionsUsedPct: number | null;
  replicationLagSeconds: number | null;
  haBroken: boolean;
  diskDaysToExhaust: number | null;
}): LaneCore {
  const {
    lockStory,
    hostDb,
    noisy,
    waitShares,
    connectionsUsedPct,
    replicationLagSeconds,
    haBroken,
    diskDaysToExhaust,
  } = args;

  if (lockStory && lockStory.activeCount > 0) {
    return {
      lane: 'locks',
      tone: 'error',
      headline: 'Pain now · locks (application / long txn)',
      body:
        `${lockStory.summary}. ` +
        `Usually an application holding a transaction open — not missing DB capacity. ` +
        `Blocker SQL: ${clip(lockStory.blockerQuery)}.`,
    };
  }

  if (hostDb.blameHost) {
    return {
      lane: 'host_io',
      tone: hostDb.tone,
      headline: 'Pain now · host storage / I/O',
      body:
        `${hostDb.verdict} ` +
        `DB I/O waits with high OS iowait — fix storage or host noisy neighbors before tuning SQL.`,
    };
  }

  if (haBroken || (replicationLagSeconds !== null && replicationLagSeconds >= 60)) {
    return {
      lane: 'ha',
      tone: 'error',
      headline: 'Pain now · HA / replication',
      body:
        haBroken
          ? 'Replication / HA reports a broken peer. Failover and lag risk sit with DBA + Infra.'
          : `Replication lag is ${formatDuration(replicationLagSeconds!)}. Secondary reads and failover are the issue — not “slow SQL” first.`,
    };
  }

  if (connectionsUsedPct !== null && connectionsUsedPct >= 90) {
    return {
      lane: 'connections',
      tone: 'error',
      headline: 'Pain now · connection pressure (app pool)',
      body:
        `Connections are at ${formatPct(connectionsUsedPct, 0)} of max. ` +
        `Usually leaked pools or too many app replicas — fix pools before raising max_connections.`,
    };
  }

  if (diskDaysToExhaust !== null && diskDaysToExhaust <= 14) {
    return {
      lane: 'capacity',
      tone: 'error',
      headline: 'Pain now · disk capacity',
      body: `Disk projects ~${formatDays(diskDaysToExhaust)} to fill. Performance symptoms may be secondary to a full volume.`,
    };
  }

  const clientShare =
    waitShares.waits.find((w) => w.waitType === 'Client' || w.waitType === 'Network')?.share ?? 0;
  if (clientShare >= 0.35) {
    return {
      lane: 'application',
      tone: 'warn',
      headline: 'Pain now · application (client wait)',
      body:
        `Client/network waits are ${formatPct(clientShare * 100, 0)} of busy time. ` +
        `The database is waiting on the app — not a DBA knob.`,
    };
  }

  // Noisy neighbor alone is enough for "pain now" — do not require CPU wait dominance.
  if (noisy && noisy.sharePct != null && noisy.sharePct >= 40) {
    return {
      lane: 'cpu',
      tone: noisy.tone === 'ok' ? 'warn' : noisy.tone,
      headline: 'Pain now · noisy neighbor query',
      body:
        `${noisy.summary}. ` +
        `This is consuming most sampled DB time — page the app/owner of that role, not “the database” in general. ` +
        `SQL: ${clip(noisy.query)}.`,
    };
  }

  const cpuShare = waitShares.waits.find((w) => w.waitType === 'CPU')?.share ?? 0;
  if (cpuShare >= 0.5 && (noisy?.sharePct ?? 0) >= 25) {
    return {
      lane: 'cpu',
      tone: 'warn',
      headline: 'Pain now · query / CPU',
      body:
        `CPU dominates waits and one statement takes ~${formatPct(noisy!.sharePct!, 0)} of DB time. ` +
        `Tune or throttle that query/app role before adding cores.`,
    };
  }

  if (waitShares.samples === 0) {
    return {
      lane: 'unknown',
      tone: 'neutral',
      headline: 'Pain now · collecting',
      body: 'Not enough session samples yet to attribute live pain.',
    };
  }

  return {
    lane: 'healthy',
    tone: 'ok',
    headline: 'Pain now · no live smoking gun',
    body:
      'No lock storm, host iowait is calm relative to DB I/O, and no single query dominates. ' +
      'If users still complain, check Client waits and the query budget below.',
  };
}

/** Standing DBA risk — may be red while live traffic looks fine. */
function pickDbaRisk(args: {
  recovery: RecoveryReadiness;
  changes: ChangeRadarItem[];
}): LaneCore {
  const { recovery, changes } = args;

  if (recovery.tone === 'error') {
    return {
      lane: 'recovery',
      tone: 'error',
      headline: 'DBA risk · recovery chain broken',
      body: `${recovery.detail}. Live traffic may look fine — restore would fail. Not the cause of “slow right now,” but highest DBA risk.`,
    };
  }

  if (recovery.tone === 'warn') {
    return {
      lane: 'recovery',
      tone: 'warn',
      headline: 'DBA risk · recovery at risk',
      body: `${recovery.detail}. Keep this on the DBA board even if performance is calm.`,
    };
  }

  const badChange = changes.find((c) => c.tone === 'error' || c.tone === 'warn');
  if (badChange) {
    return {
      lane: 'config',
      tone: badChange.tone,
      headline: 'DBA risk · config / jobs',
      body: `${badChange.label}. Check Change radar before assuming a runtime performance root cause.`,
    };
  }

  return {
    lane: 'healthy',
    tone: recovery.tone === 'ok' ? 'ok' : 'neutral',
    headline: 'DBA risk · recovery posture OK',
    body:
      recovery.tone === 'ok'
        ? `${recovery.detail}. No broken PITR signal and no failed/disabled jobs in inventory.`
        : `${recovery.detail}. Recovery score is soft — prove backups outside the engine if needed.`,
  };
}

/** Prefer pain when it is actionable; otherwise surface standing DBA risk. */
function pickPrimary(pain: BlameLaneVerdict, risk: BlameLaneVerdict): BlameLaneVerdict {
  const painHot = !['healthy', 'unknown'].includes(pain.lane);
  const riskHot = !['healthy', 'unknown'].includes(risk.lane);
  if (painHot) return pain;
  if (riskHot) return risk;
  return pain;
}

/**
 * Full on-call "who is actually at fault" pack for one instance.
 * Purely derived from store data already collected — no new collectors.
 */
export async function buildBlamePicture(
  instanceId: number,
  opts: {
    connectionsUsedPct?: number | null;
    windowMinutes?: number;
    alias?: string | null;
    replicationLagSeconds?: number | null;
  } = {},
): Promise<BlamePicture> {
  const windowMinutes = opts.windowMinutes ?? 60;
  const connectionsUsedPct = opts.connectionsUsedPct ?? null;

  const [inventory, forecasts, lockEps, waitShares, host, statements] = await Promise.all([
    getInstanceInventory(instanceId).catch(() => null),
    getCapacityBudget(instanceId, 28).catch(() => []),
    getLockEpisodes(instanceId, 6, 40).catch(() => [] as LockEpisode[]),
    getWaitShares(instanceId, windowMinutes).catch(() => ({
      waits: [],
      samples: 0,
      averageBusy: 0,
    })),
    getHostSummary(instanceId).catch(() => null),
    getTopStatements(instanceId, windowMinutes, 'time', true, 5).catch(() => []),
  ]);

  let replicationLagSeconds = opts.replicationLagSeconds ?? null;
  let haBroken = false;
  if (inventory?.replication?.length) {
    const peers = inventory.replication.filter(
      (r) => !/DISABLED/i.test(r.state ?? '') && r.role !== 'availability_group',
    );
    if (peers.some((r) => /broken|error|IO=No|SQL=No/i.test(r.state ?? ''))) haBroken = true;
    if (replicationLagSeconds === null) {
      const anyLag = peers.find((r) => r.lagSeconds !== null && r.lagSeconds >= 0);
      if (anyLag?.lagSeconds != null) replicationLagSeconds = anyLag.lagSeconds;
    }
  }

  const lockStory = buildLockStory(lockEps);
  const recovery = recoveryFromInventory(inventory);

  const changes: ChangeRadarItem[] = [];
  if (inventory) {
    const pending = inventory.notes.filter((n) => n.domain === 'settings' && n.level === 'warn');
    for (const n of pending.slice(0, 2)) {
      changes.push({
        kind: 'settings',
        label: n.message.length > 90 ? `${n.message.slice(0, 90)}…` : n.message,
        tone: 'warn',
        href: `/instances/${instanceId}/inventory`,
      });
    }
    const failed = inventory.jobs.filter(
      (j) => j.lastStatus === 'failed' || j.lastStatus === 'falló',
    );
    if (failed.length > 0) {
      changes.push({
        kind: 'jobs_failed',
        label: `${failed.length} job(s) failed last run: ${failed
          .slice(0, 3)
          .map((j) => j.name)
          .join(', ')}`,
        tone: 'error',
        href: `/instances/${instanceId}/inventory`,
      });
    }
    const disabled = inventory.jobs.filter((j) => j.enabled === false);
    if (disabled.length > 0) {
      changes.push({
        kind: 'jobs_disabled',
        label: `${disabled.length} job(s) disabled`,
        tone: 'warn',
        href: `/instances/${instanceId}/inventory`,
      });
    }
  }

  const ioShare =
    waitShares.waits
      .filter((w) => w.waitType === 'IO' || w.waitType === 'Log')
      .reduce((s, w) => s + w.share, 0) || null;
  const iowait = host?.iowaitPct ?? null;
  let hostDb: HostDbCorrelation;
  if (iowait !== null && ioShare !== null && ioShare >= 0.25 && iowait >= 15) {
    hostDb = {
      iowaitPct: iowait,
      ioWaitShare: ioShare,
      verdict: `Host iowait ${formatPct(iowait, 0)} with DB I/O waits ${formatPct(ioShare * 100, 0)}.`,
      tone: iowait >= 30 || ioShare >= 0.45 ? 'error' : 'warn',
      blameHost: true,
    };
  } else if (ioShare !== null && ioShare >= 0.35 && (iowait === null || iowait < 8)) {
    hostDb = {
      iowaitPct: iowait,
      ioWaitShare: ioShare,
      verdict:
        iowait === null
          ? `DB I/O waits ${formatPct(ioShare * 100, 0)} but host metrics are missing — enable hostMetrics to prove storage guilt.`
          : `DB I/O waits ${formatPct(ioShare * 100, 0)} while host iowait is only ${formatPct(iowait, 0)} — more likely buffer/cache or query shape than raw disk.`,
      tone: 'warn',
      blameHost: false,
    };
  } else {
    hostDb = {
      iowaitPct: iowait,
      ioWaitShare: ioShare,
      verdict:
        iowait === null && ioShare === null
          ? 'No host/DB I/O correlation yet.'
          : `Host iowait ${iowait === null ? 'n/a' : formatPct(iowait, 0)} · DB I/O wait share ${
              ioShare === null ? 'n/a' : formatPct(ioShare * 100, 0)
            }.`,
      tone: 'ok',
      blameHost: false,
    };
  }

  const totalExec = statements.reduce((s, q) => s + q.execMs, 0);
  let noisy: NoisyNeighbor | null = null;
  if (statements[0] && totalExec > 0) {
    const top = statements[0];
    const sharePct = (top.execMs / totalExec) * 100;
    const { getInstance } = await import('@/lib/queries');
    const { pageLabelForOwner, resolveQueryOwner } = await import('@/lib/owners');
    const inst = await getInstance(instanceId).catch(() => null);
    const owner = await resolveQueryOwner(instanceId, {
      queryid: top.queryid,
      username: top.username,
      tags: inst?.tags,
      windowMinutes,
    });
    noisy = {
      queryid: top.queryid,
      sharePct,
      execMs: top.execMs,
      calls: top.calls,
      username: top.username,
      query: top.query,
      summary:
        sharePct >= 40
          ? `Top statement is ${formatPct(sharePct, 0)} of DB time (${top.calls} calls) as ${top.username ?? '?'}${
              owner.application ? ` · app ${owner.application}` : ''
            }`
          : `Top statement ${formatPct(sharePct, 0)} of sampled DB time`,
      tone: sharePct >= 50 ? 'error' : sharePct >= 30 ? 'warn' : 'ok',
      ownerLabel: owner.label,
      ownerPageLabel: pageLabelForOwner(owner),
    };
  }

  const disk = forecasts.find(
    (f) =>
      f.resource === 'disco' &&
      f.daysToExhaust !== null &&
      f.dailyRate !== null &&
      f.dailyRate > 0,
  );

  let pain = asVerdict(
    pickPainNow({
      lockStory,
      hostDb,
      noisy,
      waitShares,
      connectionsUsedPct,
      replicationLagSeconds,
      haBroken,
      diskDaysToExhaust: disk?.daysToExhaust ?? null,
    }),
  );
  // Prefer concrete query owner on application/cpu pain lanes.
  if (
    (pain.lane === 'cpu' || pain.lane === 'application' || pain.lane === 'locks') &&
    noisy?.ownerPageLabel
  ) {
    pain = { ...pain, pageLabel: noisy.ownerPageLabel };
  }
  const risk = asVerdict(pickDbaRisk({ recovery, changes }));
  const primary = pickPrimary(pain, risk);

  const chips: ShieldChip[] = [
    {
      label: recovery.label,
      tone: recovery.tone,
      href: `/instances/${instanceId}/backups`,
      title: recovery.detail,
    },
  ];
  if (lockStory) {
    chips.push({
      label: `${lockStory.activeCount} lock episode(s)`,
      tone: 'error',
      href: `/instances/${instanceId}/locks`,
      title: lockStory.summary,
    });
  } else {
    chips.push({
      label: 'No active locks',
      tone: 'ok',
      href: `/instances/${instanceId}/locks`,
    });
  }
  chips.push({
    label: hostDb.blameHost ? 'Host I/O guilty' : 'Host↔DB calm',
    tone: hostDb.tone,
    href: `/instances/${instanceId}/host`,
    title: hostDb.verdict,
  });
  if (noisy && noisy.sharePct != null && noisy.sharePct >= 25) {
    chips.push({
      label: `Noisy ${formatPct(noisy.sharePct, 0)} DB time`,
      tone: noisy.tone,
      href: noisy.queryid
        ? `/instances/${instanceId}/queries/${noisy.queryid}`
        : `/instances/${instanceId}/queries`,
      title: noisy.summary,
    });
  }
  if (disk?.daysToExhaust != null) {
    chips.push({
      label:
        disk.daysToExhaust === 0
          ? 'Disk at limit'
          : `Disk ~${formatDays(disk.daysToExhaust)}`,
      tone: disk.daysToExhaust <= 14 ? 'error' : disk.daysToExhaust <= 56 ? 'warn' : 'ok',
      href: `/instances/${instanceId}/capacity`,
    });
  }
  if (haBroken || (replicationLagSeconds !== null && replicationLagSeconds >= 10)) {
    chips.push({
      label: haBroken
        ? 'HA broken'
        : `HA lag ${formatDuration(replicationLagSeconds!)}`,
      tone: haBroken || (replicationLagSeconds ?? 0) >= 60 ? 'error' : 'warn',
      href: `/instances/${instanceId}/replication`,
    });
  }
  if (changes.length > 0) {
    chips.push({
      label: `${changes.length} change signal(s)`,
      tone: changes.some((c) => c.tone === 'error') ? 'error' : 'warn',
      href: `/instances/${instanceId}/inventory`,
    });
  }

  const withoutBrief = {
    lane: primary.lane,
    tone: primary.tone,
    headline: primary.headline,
    body: primary.body,
    pageOwner: primary.pageOwner,
    pageLabel: primary.pageLabel,
    pain,
    risk,
    chips,
    lockStory,
    recovery,
    changes,
    hostDb,
    noisy,
  };

  return {
    ...withoutBrief,
    brief: formatIncidentBrief(withoutBrief, {
      instanceId,
      alias: opts.alias ?? inventory?.engine?.alias ?? undefined,
    }),
  };
}

export interface FleetBlameChip {
  instanceId: number;
  alias: string;
  engine: string;
  painTone: ShieldTone;
  painLabel: string;
  riskTone: ShieldTone;
  riskLabel: string;
  href: string;
}

/**
 * Lightweight dual-lane chips for Estate (no full BlamePicture per instance).
 * Pain from live fleet signals; risk from recovery SLO.
 */
export async function getFleetBlameChips(): Promise<FleetBlameChip[]> {
  const { listInstances } = await import('@/lib/queries');
  const SQL = new Set(['postgres', 'mssql', 'mariadb', 'oracle']);
  const [instances, recovery] = await Promise.all([
    listInstances().catch(() => []),
    getEstateRecoverySlo().catch(() => []),
  ]);
  const recById = new Map(recovery.map((r) => [r.instanceId, r]));

  const chips: FleetBlameChip[] = [];
  for (const i of instances) {
    if (!SQL.has(i.engine)) continue;
    const blocked = i.blockedSessions ?? 0;
    const conn = i.connectionsUsedPct ?? 0;
    const critical = i.critical ?? 0;
    let painTone: ShieldTone = 'ok';
    let painLabel = 'Calm';
    if (blocked > 0) {
      painTone = 'error';
      painLabel = `${blocked} blocked`;
    } else if (conn >= 90) {
      painTone = 'error';
      painLabel = `conn ${conn.toFixed(0)}%`;
    } else if (conn >= 75) {
      painTone = 'warn';
      painLabel = `conn ${conn.toFixed(0)}%`;
    } else if (critical > 0) {
      painTone = 'warn';
      painLabel = `${critical} critical`;
    }
    const rec = recById.get(i.instanceId);
    chips.push({
      instanceId: i.instanceId,
      alias: i.alias,
      engine: i.engine,
      painTone,
      painLabel,
      riskTone: rec?.tone ?? 'neutral',
      riskLabel: rec?.label ?? 'No RPO signal',
      href: `/instances/${i.instanceId}/blame`,
    });
  }

  const rank = (t: ShieldTone) =>
    t === 'error' ? 0 : t === 'warn' ? 1 : t === 'ok' ? 3 : 2;
  return chips.sort(
    (a, b) =>
      Math.min(rank(a.painTone), rank(a.riskTone)) -
        Math.min(rank(b.painTone), rank(b.riskTone)) ||
      a.alias.localeCompare(b.alias),
  );
}

/** Fleet-level recovery SLO rows for Estate. */
export async function getEstateRecoverySlo(): Promise<
  Array<{
    instanceId: number;
    alias: string;
    engine: string;
    score: number;
    tone: ShieldTone;
    label: string;
    rpoHours: number | null;
  }>
> {
  const { getEngineVersions, getBackups } = await import('@/lib/estate');
  const [engines, backups] = await Promise.all([getEngineVersions(), getBackups()]);
  const byInstance = new Map<number, typeof backups>();
  for (const row of backups) {
    const list = byInstance.get(row.instanceId) ?? [];
    list.push(row);
    byInstance.set(row.instanceId, list);
  }

  return engines.map((eng) => {
    const rec = recoveryFromBackups(byInstance.get(eng.instanceId) ?? []);
    return {
      instanceId: eng.instanceId,
      alias: eng.alias,
      engine: eng.engine,
      score: rec.score,
      tone: rec.tone,
      label: rec.detail,
      rpoHours: rec.rpoHours,
    };
  });
}
