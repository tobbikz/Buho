import Link from 'next/link';
import {
  backupKindLabel,
  backupState,
  backupStateLabel,
  getInstanceInventory,
  type BackupState,
} from '@/lib/estate';
import { formatDays, getCapacityBudget } from '@/lib/capacity';
import { formatAgo, formatDuration, formatPct } from '@/lib/format';

/**
 * On-call strip for every SQL engine Overview: is the collector fresh, is
 * anyone blocked, can we recover from backup, is disk about to fill, are
 * connections near the ceiling, and is HA lagging. Answers the 3am question
 * before opening deeper tabs.
 */
export async function OpsPulse({
  instanceId,
  lastSeenAt,
  blockedSessions,
  connectionsUsedPct,
  replicationLagSeconds,
}: {
  instanceId: number;
  lastSeenAt: Date | null;
  blockedSessions: number | null;
  connectionsUsedPct?: number | null;
  replicationLagSeconds?: number | null;
}) {
  const [inventory, forecasts] = await Promise.all([
    getInstanceInventory(instanceId).catch(() => null),
    getCapacityBudget(instanceId, 28).catch(() => []),
  ]);

  const ageSec =
    lastSeenAt === null ? null : Math.max(0, (Date.now() - lastSeenAt.getTime()) / 1000);
  const freshTone =
    ageSec === null ? 'neutral' : ageSec > 300 ? 'error' : ageSec > 90 ? 'warn' : 'ok';
  const freshLabel =
    ageSec === null
      ? 'No samples yet'
      : ageSec < 60
        ? `Fresh · ${Math.round(ageSec)}s ago`
        : `Stale · ${formatAgo(lastSeenAt)}`;

  const blocked = blockedSessions ?? 0;
  const blockTone = blocked > 0 ? 'error' : 'ok';

  let backupTone: 'ok' | 'warn' | 'error' | 'neutral' = 'neutral';
  let backupLabel = 'No backup inventory';
  const backupHref = `/instances/${instanceId}/backups`;
  if (inventory && inventory.backups.length > 0) {
    const rank: Record<BackupState, number> = {
      sin_recuperacion: 3,
      atrasado: 2,
      no_verificable: 1,
      ok: 0,
    };
    let worst = inventory.backups[0]!;
    let worstRank = rank[backupState(worst)] ?? 0;
    for (const row of inventory.backups) {
      const r = rank[backupState(row)] ?? 0;
      if (r > worstRank) {
        worst = row;
        worstRank = r;
      }
    }
    const state = backupState(worst);
    backupTone =
      state === 'sin_recuperacion' ? 'error' : state === 'atrasado' ? 'warn' : state === 'ok' ? 'ok' : 'neutral';
    backupLabel = `${backupKindLabel(worst)} · ${backupStateLabel(worst)}`;
  }

  const capacity =
    forecasts.find(
      (f) =>
        f.resource === 'disco' &&
        f.daysToExhaust !== null &&
        f.dailyRate !== null &&
        f.dailyRate > 0,
    ) ?? null;
  let capacityTone: 'ok' | 'warn' | 'error' | 'neutral' = 'neutral';
  let capacityLabel = 'No disk projection';
  if (capacity && capacity.daysToExhaust !== null) {
    capacityTone =
      capacity.daysToExhaust <= 14 ? 'error' : capacity.daysToExhaust <= 56 ? 'warn' : 'ok';
    capacityLabel =
      capacity.daysToExhaust === 0
        ? 'Disk at limit'
        : `Disk ~${formatDays(capacity.daysToExhaust)} to fill`;
  }

  const connPct = connectionsUsedPct ?? null;
  let connTone: 'ok' | 'warn' | 'error' | 'neutral' = 'neutral';
  let connLabel = 'Connections n/a';
  if (connPct !== null) {
    connTone = connPct >= 90 ? 'error' : connPct >= 75 ? 'warn' : 'ok';
    connLabel = `Connections ${formatPct(connPct, 0)}`;
  }

  const lag = replicationLagSeconds ?? null;
  let haTone: 'ok' | 'warn' | 'error' | 'neutral' = 'neutral';
  let haLabel: string | null = null;
  if (lag !== null && lag >= 0) {
    haTone = lag >= 60 ? 'error' : lag >= 10 ? 'warn' : 'ok';
    haLabel = lag < 1 ? 'HA lag <1s' : `HA lag ${formatDuration(lag)}`;
  } else if (inventory?.replication?.length) {
    // Skip posture-only rows (e.g. "Always On DISABLED") — not an incident.
    const peers = inventory.replication.filter(
      (r) => !/DISABLED/i.test(r.state ?? '') && r.role !== 'availability_group',
    );
    const broken = peers.find((r) => /broken|error|IO=No|SQL=No/i.test(r.state ?? ''));
    const anyLag = peers.find((r) => r.lagSeconds !== null && r.lagSeconds >= 0);
    if (broken) {
      haTone = 'error';
      haLabel = broken.state ?? 'HA issue';
    } else if (anyLag?.lagSeconds != null) {
      haTone =
        anyLag.lagSeconds >= 60 ? 'error' : anyLag.lagSeconds >= 10 ? 'warn' : 'ok';
      haLabel =
        anyLag.lagSeconds < 1
          ? 'HA lag <1s'
          : `HA lag ${formatDuration(anyLag.lagSeconds)}`;
    }
  }

  const pendingNote = inventory?.notes?.find((n) => n.domain === 'settings' && n.level === 'warn');
  const chip = (tone: string) =>
    tone === 'error' ? 'tag--error' : tone === 'warn' ? 'tag--warn' : tone === 'ok' ? 'tag--ok' : 'tag--muted';

  return (
    <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div className="panel-header">
        <span className="panel-title">Ops pulse</span>
        <span className="font-mono text-[10px] text-foreground-muted">on-call at a glance</span>
      </div>
      <div className="panel-body flex flex-wrap items-center gap-2">
        <span className={`tag ${chip(freshTone)}`} title="Age of last collector sample for this instance">
          {freshLabel}
        </span>
        <Link
          href={`/instances/${instanceId}/locks`}
          className={`tag ${chip(blockTone)}`}
          title="Sessions waiting on locks right now"
        >
          {blocked > 0 ? `${blocked} blocked` : 'No blockers'}
        </Link>
        <Link href={backupHref} className={`tag ${chip(backupTone)}`} title="Worst backup / recovery signal">
          {backupLabel}
        </Link>
        <Link
          href={`/instances/${instanceId}/capacity`}
          className={`tag ${chip(capacityTone)}`}
          title="Disk growth projection from capacity history"
        >
          {capacityLabel}
        </Link>
        <Link
          href={`/instances/${instanceId}/sessions`}
          className={`tag ${chip(connTone)}`}
          title="Current connections vs configured max"
        >
          {connLabel}
        </Link>
        {haLabel ? (
          <Link
            href={`/instances/${instanceId}/replication`}
            className={`tag ${chip(haTone)}`}
            title="Replication / HA lag from latest inventory"
          >
            {haLabel}
          </Link>
        ) : null}
        {pendingNote ? (
          <Link
            href={`/instances/${instanceId}/inventory`}
            className="tag tag--warn"
            title={pendingNote.message}
          >
            Config pending apply
          </Link>
        ) : null}
        <Link
          href={`/instances/${instanceId}/queries?vista=live`}
          className="tag tag--muted"
          title="What is running right now"
        >
          Live queries →
        </Link>
        <Link
          href={`/instances/${instanceId}/blame`}
          className="tag tag--muted"
          title="Open Blame tab — who to page (kept off Overview so routine checks stay calm)"
        >
          Blame →
        </Link>
      </div>
    </section>
  );
}
