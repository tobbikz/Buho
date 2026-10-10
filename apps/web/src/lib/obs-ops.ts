import { query } from './db';
import {
  listEndpointMonitors,
  listEndpointPathDocuments,
  type EndpointMonitorRow,
  type EndpointPathSample,
} from './endpoints';
import { listInstances, type FleetInstance } from './queries';
import { listApmServices, type ApmServiceRow } from './traces';

/** Default latency / availability targets (Kibana SLO–style, lab defaults). */
const DEFAULT_AVAIL_TARGET = 0.99;
const DEFAULT_LATENCY_P95_MS = 500;
const WARN_LATENCY_MS = 2_000;
const CRIT_LATENCY_MS = 5_000;
const WARN_ERROR_RATE = 0.01;
const CRIT_ERROR_RATE = 0.05;
/** Default RPO: 15 minutes. */
const DEFAULT_RPO_SECONDS = 15 * 60;

export type ObsAlertSeverity = 'critical' | 'warning' | 'info';
export type ObsAlertSource = 'uptime' | 'apm' | 'slo';

/** Observability-space alerts — not the Databases fleet alert table. */
export type ObsAlert = {
  id: string;
  severity: ObsAlertSeverity;
  source: ObsAlertSource;
  title: string;
  message: string;
  entity: string;
  href: string;
  seenAt: Date | null;
};

export type SloStatus = 'met' | 'breached' | 'no_data';

export type ObsSloRow = {
  id: string;
  name: string;
  kind: 'availability' | 'latency' | 'uptime';
  targetLabel: string;
  observedLabel: string;
  status: SloStatus;
  href: string;
};

export async function listObservabilitySlos(): Promise<ObsSloRow[]> {
  const [services, monitors] = await Promise.all([
    listApmServices(null),
    listEndpointMonitors(),
  ]);
  const rows: ObsSloRow[] = [];

  for (const s of services) {
    rows.push(serviceAvailabilitySlo(s));
    rows.push(serviceLatencySlo(s));
  }

  for (const m of monitors) {
    const up = m.up;
    const status: SloStatus = up == null ? 'no_data' : up >= 1 ? 'met' : 'breached';
    rows.push({
      id: `uptime:${m.instanceId}`,
      name: `${m.alias} · probe`,
      kind: 'uptime',
      targetLabel: 'up = 1',
      observedLabel: up == null ? '—' : up >= 1 ? 'up' : 'down',
      status,
      href: `/observability/monitors/${m.instanceId}`,
    });
  }

  return rows;
}

function serviceAvailabilitySlo(s: ApmServiceRow): ObsSloRow {
  const avail = 1 - s.errorRate;
  const status: SloStatus =
    s.traceCount === 0 ? 'no_data' : avail >= DEFAULT_AVAIL_TARGET ? 'met' : 'breached';
  return {
    id: `avail:${s.serviceName}`,
    name: `${s.serviceName} · availability`,
    kind: 'availability',
    targetLabel: `${(DEFAULT_AVAIL_TARGET * 100).toFixed(1)}%`,
    observedLabel: `${(avail * 100).toFixed(1)}% (${s.traceCount} traces)`,
    status,
    href: `/observability/apm?w=all&service=${encodeURIComponent(s.serviceName)}`,
  };
}

function serviceLatencySlo(s: ApmServiceRow): ObsSloRow {
  const p95 = s.p95DurationMs;
  const status: SloStatus =
    p95 == null ? 'no_data' : p95 <= DEFAULT_LATENCY_P95_MS ? 'met' : 'breached';
  return {
    id: `lat:${s.serviceName}`,
    name: `${s.serviceName} · latency p95`,
    kind: 'latency',
    targetLabel: `≤ ${DEFAULT_LATENCY_P95_MS} ms`,
    observedLabel: p95 == null ? '—' : `${Math.round(p95)} ms`,
    status,
    href: `/observability/apm/traces?w=all&service=${encodeURIComponent(s.serviceName)}`,
  };
}

export async function listObservabilityAlerts(): Promise<ObsAlert[]> {
  const [monitors, paths, services] = await Promise.all([
    listEndpointMonitors(),
    listEndpointPathDocuments(300),
    listApmServices(null),
  ]);

  const out: ObsAlert[] = [
    ...uptimeAlerts(monitors, paths),
    ...apmAlerts(services),
  ];

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
  return out;
}

function uptimeAlerts(
  monitors: EndpointMonitorRow[],
  paths: EndpointPathSample[],
): ObsAlert[] {
  const out: ObsAlert[] = [];
  for (const m of monitors) {
    if (m.up != null && m.up < 1) {
      out.push({
        id: `uptime:down:${m.instanceId}`,
        severity: 'critical',
        source: 'uptime',
        title: `Probe down · ${m.alias}`,
        message: `HTTP probe ${m.host}:${m.port} is not up`,
        entity: m.alias,
        href: `/observability/monitors/${m.instanceId}`,
        seenAt: m.lastSeenAt,
      });
    } else if (m.httpStatus != null && m.httpStatus >= 500) {
      out.push({
        id: `uptime:http5xx:${m.instanceId}`,
        severity: 'critical',
        source: 'uptime',
        title: `HTTP ${m.httpStatus} · ${m.alias}`,
        message: `Latest probe returned status ${m.httpStatus}`,
        entity: m.alias,
        href: `/observability/monitors/${m.instanceId}`,
        seenAt: m.lastSeenAt,
      });
    } else if (m.httpStatus != null && m.httpStatus >= 400) {
      out.push({
        id: `uptime:http4xx:${m.instanceId}`,
        severity: 'warning',
        source: 'uptime',
        title: `HTTP ${m.httpStatus} · ${m.alias}`,
        message: `Latest probe returned status ${m.httpStatus}`,
        entity: m.alias,
        href: `/observability/monitors/${m.instanceId}`,
        seenAt: m.lastSeenAt,
      });
    }

    if (m.httpMs != null && m.httpMs >= CRIT_LATENCY_MS) {
      out.push({
        id: `uptime:lat-crit:${m.instanceId}`,
        severity: 'critical',
        source: 'uptime',
        title: `Probe latency critical · ${m.alias}`,
        message: `${Math.round(m.httpMs)} ms (threshold ${CRIT_LATENCY_MS} ms)`,
        entity: m.alias,
        href: `/observability/monitors/${m.instanceId}`,
        seenAt: m.lastSeenAt,
      });
    } else if (m.httpMs != null && m.httpMs >= WARN_LATENCY_MS) {
      out.push({
        id: `uptime:lat-warn:${m.instanceId}`,
        severity: 'warning',
        source: 'uptime',
        title: `Probe latency high · ${m.alias}`,
        message: `${Math.round(m.httpMs)} ms (threshold ${WARN_LATENCY_MS} ms)`,
        entity: m.alias,
        href: `/observability/monitors/${m.instanceId}`,
        seenAt: m.lastSeenAt,
      });
    }

    if (m.tlsDays != null && m.tlsDays < 14) {
      out.push({
        id: `uptime:tls:${m.instanceId}`,
        severity: m.tlsDays < 7 ? 'critical' : 'warning',
        source: 'uptime',
        title: `TLS expires soon · ${m.alias}`,
        message: `${Math.floor(m.tlsDays)} days left on certificate`,
        entity: m.alias,
        href: `/observability/monitors/${m.instanceId}`,
        seenAt: m.lastSeenAt,
      });
    }
  }

  for (const p of paths) {
    if (p.httpOk != null && p.httpOk < 1) {
      out.push({
        id: `uptime:path:${p.instanceId}:${p.path}`,
        severity: p.httpStatus != null && p.httpStatus >= 500 ? 'critical' : 'warning',
        source: 'uptime',
        title: `Path failing · ${p.alias}${p.path}`,
        message:
          p.httpStatus != null
            ? `HTTP ${p.httpStatus} on path probe`
            : 'Path probe marked not ok',
        entity: `${p.alias}${p.path}`,
        href: `/observability/monitors/${p.instanceId}`,
        seenAt: p.ts,
      });
    }
  }
  return out;
}

function apmAlerts(services: ApmServiceRow[]): ObsAlert[] {
  const out: ObsAlert[] = [];
  for (const s of services) {
    if (s.traceCount === 0) continue;
    if (s.errorRate >= CRIT_ERROR_RATE) {
      out.push({
        id: `apm:err-crit:${s.serviceName}`,
        severity: 'critical',
        source: 'apm',
        title: `High error rate · ${s.serviceName}`,
        message: `${(s.errorRate * 100).toFixed(1)}% errors (${s.errorTraces}/${s.traceCount} traces)`,
        entity: s.serviceName,
        href: `/observability/apm/traces?w=all&service=${encodeURIComponent(s.serviceName)}`,
        seenAt: s.lastSeenAt,
      });
    } else if (s.errorRate >= WARN_ERROR_RATE) {
      out.push({
        id: `apm:err-warn:${s.serviceName}`,
        severity: 'warning',
        source: 'apm',
        title: `Elevated error rate · ${s.serviceName}`,
        message: `${(s.errorRate * 100).toFixed(1)}% errors (${s.errorTraces}/${s.traceCount} traces)`,
        entity: s.serviceName,
        href: `/observability/apm/traces?w=all&service=${encodeURIComponent(s.serviceName)}`,
        seenAt: s.lastSeenAt,
      });
    }

    if (s.p95DurationMs != null && s.p95DurationMs >= CRIT_LATENCY_MS) {
      out.push({
        id: `apm:lat-crit:${s.serviceName}`,
        severity: 'critical',
        source: 'apm',
        title: `p95 latency critical · ${s.serviceName}`,
        message: `${Math.round(s.p95DurationMs)} ms (threshold ${CRIT_LATENCY_MS} ms)`,
        entity: s.serviceName,
        href: `/observability/apm?w=all&service=${encodeURIComponent(s.serviceName)}`,
        seenAt: s.lastSeenAt,
      });
    } else if (s.p95DurationMs != null && s.p95DurationMs >= DEFAULT_LATENCY_P95_MS) {
      out.push({
        id: `apm:lat-warn:${s.serviceName}`,
        severity: 'warning',
        source: 'apm',
        title: `p95 latency high · ${s.serviceName}`,
        message: `${Math.round(s.p95DurationMs)} ms (SLO ${DEFAULT_LATENCY_P95_MS} ms)`,
        entity: s.serviceName,
        href: `/observability/apm?w=all&service=${encodeURIComponent(s.serviceName)}`,
        seenAt: s.lastSeenAt,
      });
    }
  }
  return out;
}

export type ObsCaseRow = {
  caseId: string;
  title: string;
  severity: ObsAlertSeverity;
  status: 'open';
  source: ObsAlertSource;
  entity: string;
  href: string;
  message: string;
  lastSeenAt: Date | null;
};

/** Cases = Observability alerts framed as investigation tickets (not DB alerts). */
export async function listObservabilityCases(): Promise<ObsCaseRow[]> {
  const alerts = await listObservabilityAlerts();
  return alerts.map((a, i) => ({
    caseId: `OBS-${String(i + 1).padStart(3, '0')}`,
    title: a.title,
    severity: a.severity,
    status: 'open' as const,
    source: a.source,
    entity: a.entity,
    href: a.href,
    message: a.message,
    lastSeenAt: a.seenAt,
  }));
}

export type RpoStatus = 'met' | 'breached' | 'unknown';

export type ObsRpoRow = {
  instanceId: number;
  alias: string;
  engine: string;
  rpoSeconds: number;
  lagSeconds: number | null;
  backupAgeSeconds: number | null;
  backupKind: string | null;
  backupSource: string | null;
  /** Worst of lag vs backup age against RPO. */
  exposureSeconds: number | null;
  status: RpoStatus;
};

type BackupRow = {
  instance_id: number;
  kind: string;
  source: string;
  finished_at: Date | null;
  captured_at: Date;
};

export async function listObservabilityRpo(): Promise<ObsRpoRow[]> {
  const [instances, backups] = await Promise.all([
    listInstances(),
    query<BackupRow>(
      `select distinct on (instance_id)
              instance_id, kind, source, finished_at, captured_at
         from buho.backup_state
        order by instance_id, coalesce(finished_at, captured_at) desc nulls last`,
    ),
  ]);

  const byId = new Map<number, BackupRow>();
  for (const b of backups) byId.set(Number(b.instance_id), b);

  const dbs = instances.filter((i) => i.engine !== 'endpoint');
  return dbs.map((inst) => toRpoRow(inst, byId.get(inst.instanceId) ?? null));
}

function toRpoRow(inst: FleetInstance, backup: BackupRow | null): ObsRpoRow {
  const tagRpo = inst.tags['rpo_seconds'] ?? inst.tags['rpo'];
  const parsed = tagRpo != null ? Number(tagRpo) : NaN;
  const rpoSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RPO_SECONDS;

  const lagSeconds = inst.replicationLagSeconds;
  let backupAgeSeconds: number | null = null;
  if (backup) {
    const ts = backup.finished_at ?? backup.captured_at;
    backupAgeSeconds = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  }

  const candidates = [lagSeconds, backupAgeSeconds].filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  const exposureSeconds = candidates.length === 0 ? null : Math.max(...candidates);

  let status: RpoStatus = 'unknown';
  if (exposureSeconds != null) {
    status = exposureSeconds <= rpoSeconds ? 'met' : 'breached';
  }

  return {
    instanceId: inst.instanceId,
    alias: inst.alias,
    engine: inst.engine,
    rpoSeconds,
    lagSeconds,
    backupAgeSeconds,
    backupKind: backup?.kind ?? null,
    backupSource: backup?.source ?? null,
    exposureSeconds,
    status,
  };
}
