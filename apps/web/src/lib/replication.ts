import { query } from './db';

export interface InstanceReplicationRow {
  role: string;
  peer: string;
  state: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  detail: Record<string, unknown>;
  capturedAt: Date;
}

export interface FleetReplicationNode {
  instanceId: number;
  alias: string;
  host: string;
  port: number;
  inRecovery: boolean;
  versionText: string | null;
}

/** A streaming peer, optionally matched to another monitored instance. */
export interface ReplicationTopologyPeer {
  peer: string;
  state: string | null;
  syncState: string | null;
  application: string | null;
  clientAddr: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  capturedAt: Date | null;
  /** Matched fleet instance, if this peer is also monitored by Búho. */
  linked: FleetReplicationNode | null;
}

export interface ReplicationTopology {
  self: FleetReplicationNode;
  role: 'primary' | 'standby' | 'standalone';
  /** Dominant sync mode across connected standbys (async / sync / quorum / mixed). */
  syncMode: string | null;
  /** From this node: streaming standbys (primary) or upstream primary (standby). */
  streamingPeers: ReplicationTopologyPeer[];
  /** Other monitored instances that belong to this HA pair/cluster. */
  fleetPeers: Array<FleetReplicationNode & { relation: 'primary' | 'standby'; upstreamPeer: string | null }>;
  slots: InstanceReplicationRow[];
}

function mapReplicationRow(row: Record<string, unknown>): InstanceReplicationRow {
  return {
    role: String(row['role'] ?? ''),
    peer: String(row['peer'] ?? ''),
    state: (row['state'] as string | null) ?? null,
    lagBytes: row['lag_bytes'] === null || row['lag_bytes'] === undefined ? null : Number(row['lag_bytes']),
    lagSeconds:
      row['lag_seconds'] === null || row['lag_seconds'] === undefined ? null : Number(row['lag_seconds']),
    detail: (row['detail'] as Record<string, unknown>) ?? {},
    capturedAt: row['captured_at'] as Date,
  };
}

/** Strip port, CIDR, brackets — compare hostnames loosely. */
export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[') && host.includes(']')) {
    host = host.slice(1, host.indexOf(']'));
  }
  host = host.replace(/\/\d+$/, '');
  if (host.includes(':') && !host.includes('::')) {
    const maybePort = host.slice(host.lastIndexOf(':') + 1);
    if (/^\d+$/.test(maybePort)) host = host.slice(0, host.lastIndexOf(':'));
  }
  return host;
}

/** `buho-datalake-primary` ↔ `datalake-primary`, IP equality, DNS-style suffix. */
export function hostsLikelySame(a: string, b: string): boolean {
  const na = normalizeHost(a);
  const nb = normalizeHost(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith('.' + nb) || nb.endsWith('.' + na)) return true;
  // Substring only for longer fragments (avoid alias "db" matching everything).
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  if (shorter.length >= 8 && (longer === shorter || longer.endsWith('-' + shorter) || longer.includes(shorter))) {
    return true;
  }
  return false;
}

function syncModeLabel(states: string[]): string | null {
  const unique = [...new Set(states.filter(Boolean))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0]!;
  return 'mixed';
}

/**
 * Replication rows for one instance (no fleet dedupe — this is the instance view).
 */
export async function getInstanceReplication(instanceId: number): Promise<InstanceReplicationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select role, peer, state, lag_bytes, lag_seconds, detail, captured_at
       from buho.replication_state
      where instance_id = $1
      order by case role
                 when 'primary' then 0
                 when 'standby' then 1
                 when 'replica' then 2
                 else 3
               end,
               peer`,
    [instanceId],
  );
  return rows.map(mapReplicationRow);
}

/**
 * Primary ↔ standby map for the instance page: live streaming peers plus other
 * Búho-monitored nodes that belong to the same pair (matched by upstream host
 * or by application / client address).
 */
export async function getReplicationTopology(instanceId: number): Promise<ReplicationTopology | null> {
  const selfRows = await query<Record<string, unknown>>(
    `select i.instance_id, i.alias, i.host, i.port,
            coalesce(c.in_recovery, false) as in_recovery,
            c.version_text
       from buho.instances i
       left join buho.instance_capabilities c using (instance_id)
      where i.instance_id = $1`,
    [instanceId],
  );
  const selfRow = selfRows[0];
  if (!selfRow) return null;

  const self: FleetReplicationNode = {
    instanceId: Number(selfRow['instance_id']),
    alias: String(selfRow['alias']),
    host: String(selfRow['host']),
    port: Number(selfRow['port']),
    inRecovery: Boolean(selfRow['in_recovery']),
    versionText: (selfRow['version_text'] as string | null) ?? null,
  };

  const [localRows, fleetRows, fleetRepRows] = await Promise.all([
    getInstanceReplication(instanceId),
    query<Record<string, unknown>>(
      `select i.instance_id, i.alias, i.host, i.port,
              coalesce(c.in_recovery, false) as in_recovery,
              c.version_text
         from buho.instances i
         left join buho.instance_capabilities c using (instance_id)
        where i.instance_id <> $1
        order by i.alias`,
      [instanceId],
    ),
    query<Record<string, unknown>>(
      `select instance_id, role, peer, state, lag_bytes, lag_seconds, detail, captured_at
         from buho.replication_state
        where instance_id <> $1`,
      [instanceId],
    ),
  ]);

  const fleet: FleetReplicationNode[] = fleetRows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    host: String(row['host']),
    port: Number(row['port']),
    inRecovery: Boolean(row['in_recovery']),
    versionText: (row['version_text'] as string | null) ?? null,
  }));

  const fleetRepByInstance = new Map<number, InstanceReplicationRow[]>();
  for (const row of fleetRepRows) {
    const id = Number(row['instance_id']);
    const list = fleetRepByInstance.get(id) ?? [];
    list.push(mapReplicationRow(row));
    fleetRepByInstance.set(id, list);
  }

  const slots = localRows.filter((row) => row.role === 'slot');
  const standbyRows = localRows.filter((row) => row.role === 'standby' || row.role === 'replica');
  const upstream = localRows.find((row) => row.role === 'upstream');

  const usedFleet = new Set<number>();

  /** Resolve the monitored primary this standby follows (live peer, conninfo, or sole fleet primary). */
  function matchFleetPrimary(upstreamPeer: string | null, configuredHost: string | null): FleetReplicationNode | null {
    const primaries = fleet.filter((node) => !node.inRecovery);
    const candidates = [upstreamPeer, configuredHost].filter(
      (value): value is string => Boolean(value) && value !== 'unknown primary',
    );
    for (const candidate of candidates) {
      const match = primaries.find(
        (node) => hostsLikelySame(candidate, node.host) || hostsLikelySame(candidate, node.alias),
      );
      if (match) {
        usedFleet.add(match.instanceId);
        return match;
      }
    }
    // WAL receiver down and conninfo missing/unmatched: if the fleet has a single
    // primary, that is the only sensible upstream to show.
    if (primaries.length === 1) {
      usedFleet.add(primaries[0]!.instanceId);
      return primaries[0]!;
    }
    return null;
  }

  function matchFleetToStandby(row: InstanceReplicationRow): FleetReplicationNode | null {
    const application =
      typeof row.detail['application'] === 'string' ? row.detail['application'] : null;
    const clientAddr =
      typeof row.detail['client_addr'] === 'string'
        ? row.detail['client_addr']
        : normalizeHost(row.peer);

    for (const node of fleet) {
      if (usedFleet.has(node.instanceId)) continue;
      if (application && application === node.alias) {
        usedFleet.add(node.instanceId);
        return node;
      }
      if (clientAddr && hostsLikelySame(clientAddr, node.host)) {
        usedFleet.add(node.instanceId);
        return node;
      }
      if (hostsLikelySame(row.peer, node.alias) || hostsLikelySame(row.peer, node.host)) {
        usedFleet.add(node.instanceId);
        return node;
      }
    }

    // Reverse: monitored standby whose upstream points at this primary.
    for (const node of fleet) {
      if (usedFleet.has(node.instanceId) || !node.inRecovery) continue;
      const up = (fleetRepByInstance.get(node.instanceId) ?? []).find((r) => r.role === 'upstream');
      if (up && (hostsLikelySame(up.peer, self.host) || hostsLikelySame(up.peer, self.alias))) {
        usedFleet.add(node.instanceId);
        return node;
      }
    }

    return null;
  }

  const streamingPeers: ReplicationTopologyPeer[] = [];

  if (self.inRecovery) {
    const configuredHost =
      typeof upstream?.detail['configured_host'] === 'string'
        ? upstream.detail['configured_host']
        : null;
    const linkedPrimary = matchFleetPrimary(upstream?.peer ?? null, configuredHost);
    streamingPeers.push({
      peer: linkedPrimary?.alias ?? upstream?.peer ?? 'unknown primary',
      state: upstream?.state ?? null,
      syncState: null,
      application: null,
      clientAddr: null,
      lagBytes: upstream?.lagBytes ?? null,
      lagSeconds: upstream?.lagSeconds ?? null,
      capturedAt: upstream?.capturedAt ?? null,
      linked: linkedPrimary,
    });
  } else {
    for (const row of standbyRows) {
      streamingPeers.push({
        peer: row.peer,
        state: row.state,
        syncState: typeof row.detail['sync_state'] === 'string' ? row.detail['sync_state'] : null,
        application: typeof row.detail['application'] === 'string' ? row.detail['application'] : null,
        clientAddr:
          typeof row.detail['client_addr'] === 'string'
            ? row.detail['client_addr']
            : normalizeHost(row.peer),
        lagBytes: row.lagBytes,
        lagSeconds: row.lagSeconds,
        capturedAt: row.capturedAt,
        linked: matchFleetToStandby(row),
      });
    }

    // One streaming row + one unmatched fleet standby that points here → pair them.
    if (streamingPeers.length === 1 && !streamingPeers[0]!.linked) {
      const orphan = fleet.find((node) => {
        if (usedFleet.has(node.instanceId) || !node.inRecovery) return false;
        const up = (fleetRepByInstance.get(node.instanceId) ?? []).find((r) => r.role === 'upstream');
        return up
          ? hostsLikelySame(up.peer, self.host) || hostsLikelySame(up.peer, self.alias)
          : false;
      });
      if (orphan) {
        usedFleet.add(orphan.instanceId);
        streamingPeers[0]!.linked = orphan;
      }
    }
  }

  const fleetPeers: ReplicationTopology['fleetPeers'] = [];
  if (self.inRecovery) {
    const primary = streamingPeers[0]?.linked;
    if (primary) {
      fleetPeers.push({ ...primary, relation: 'primary', upstreamPeer: null });
    }
  } else {
    for (const node of fleet) {
      if (!node.inRecovery) continue;
      const up = (fleetRepByInstance.get(node.instanceId) ?? []).find((r) => r.role === 'upstream');
      const pointsHere =
        up && (hostsLikelySame(up.peer, self.host) || hostsLikelySame(up.peer, self.alias));
      const alreadyShown = streamingPeers.some((p) => p.linked?.instanceId === node.instanceId);
      if (pointsHere || alreadyShown) {
        fleetPeers.push({
          ...node,
          relation: 'standby',
          upstreamPeer: up?.peer ?? null,
        });
        // If primary sees no pg_stat_replication row yet but fleet standby exists, surface it.
        if (!alreadyShown && pointsHere) {
          streamingPeers.push({
            peer: node.alias,
            state: up?.state ?? 'monitored',
            syncState: null,
            application: null,
            clientAddr: null,
            lagBytes: up?.lagBytes ?? null,
            lagSeconds: up?.lagSeconds ?? null,
            capturedAt: up?.capturedAt ?? null,
            linked: node,
          });
        }
      }
    }
  }

  const role: ReplicationTopology['role'] =
    self.inRecovery ? 'standby' : streamingPeers.length > 0 || slots.length > 0 ? 'primary' : 'standalone';

  return {
    self,
    role,
    syncMode: syncModeLabel(
      streamingPeers.map((p) => p.syncState).filter((s): s is string => Boolean(s)),
    ),
    streamingPeers,
    fleetPeers,
    slots,
  };
}

export function replicationRowKey(instanceId: number, role: string, peer: string): string {
  return `${instanceId}:${role}:${peer}`;
}

interface LagTrendTarget {
  instanceId: number;
  role: string;
  peer: string;
  detail: Record<string, unknown>;
}

/**
 * Sparkline data for replication lag (replay delay in seconds).
 * Primary standbys use `replication_replay_lag_seconds` (labeled by application).
 * Standby instances use `standby_pending_bytes` (not replay delay — idle DBs lie).
 */
export async function getReplicationLagTrends(
  rows: LagTrendTarget[],
  windowMinutes = 1440,
  bucketSeconds = 300,
): Promise<Record<string, number[]>> {
  const instanceIds = [...new Set(rows.map((row) => row.instanceId))];
  if (instanceIds.length === 0) return {};

  const relation = windowMinutes > 1440 ? 'buho.metric_rollup_1h' : 'buho.metric_rollup_5m';
  const samples = await query<Record<string, unknown>>(
    `select instance_id,
            metric,
            labels,
            date_bin(make_interval(secs => $3::int), bucket, timestamptz 'epoch') as bucket,
            avg(avg_value) as value
       from ${relation}
      where instance_id = any($1::bigint[])
        and metric in (
          'replication_replay_lag_seconds',
          'standby_replay_delay_seconds',
          'standby_pending_bytes'
        )
        and bucket > now() - make_interval(mins => $2::int)
      group by 1, 2, 3, 4
      order by 4`,
    [instanceIds, windowMinutes, bucketSeconds],
  );

  type SeriesKey = string;
  const series = new Map<SeriesKey, { bucket: number; value: number }[]>();

  for (const row of samples) {
    const instanceId = Number(row['instance_id']);
    const metric = String(row['metric']);
    const labels = (row['labels'] as Record<string, string>) ?? {};
    const label =
      metric === 'standby_replay_delay_seconds'
        ? ''
        : (labels['standby'] ?? labels['replica'] ?? '');
    const key = `${instanceId}:${metric}:${label}`;
    const bucket = (row['bucket'] as Date).getTime();
    const value = Number(row['value']);
    if (!Number.isFinite(value)) continue;
    const points = series.get(key) ?? [];
    points.push({ bucket, value });
    series.set(key, points);
  }

  const out: Record<string, number[]> = {};
  for (const row of rows) {
    const key = replicationRowKey(row.instanceId, row.role, row.peer);
    if (row.role === 'slot' || row.role === 'primary') {
      out[key] = [];
      continue;
    }

    if (row.role === 'upstream' || row.role === 'replica') {
      const points = series.get(`${row.instanceId}:standby_pending_bytes:`) ?? [];
      out[key] = points.sort((a, b) => a.bucket - b.bucket).map((point) => point.value);
      continue;
    }

    const application = typeof row.detail['application'] === 'string' ? row.detail['application'] : '';
    let points = series.get(`${row.instanceId}:replication_replay_lag_seconds:${application}`);
    if (!points) {
      const prefix = `${row.instanceId}:replication_replay_lag_seconds:`;
      const matches = [...series.entries()].filter(([seriesKey]) => seriesKey.startsWith(prefix));
      if (matches.length === 1) points = matches[0]![1];
    }
    out[key] = (points ?? []).sort((a, b) => a.bucket - b.bucket).map((point) => point.value);
  }

  return out;
}
