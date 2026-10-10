'use client';

import Link from 'next/link';
import { ENGINE_LABEL } from '@/lib/grouping';
import { formatCompactNumber, formatPct, formatVersion, formatDuration } from '@/lib/format';
import type { FleetCardDensity } from '@/components/FleetCardDensity';
import { RelativeTime } from '@/components/RelativeTime';
import type { FleetInstance, Severity } from '@/lib/queries';

const STALE_AFTER_MS = 120_000;

function isStale(instance: FleetInstance): boolean {
  if (!instance.lastSeenAt) return true;
  return Date.now() - new Date(instance.lastSeenAt).getTime() > STALE_AFTER_MS;
}

function cardTone(instance: FleetInstance, stale: boolean): 'idle' | 'error' | 'warn' | 'ok' {
  if (stale) return 'idle';
  if (instance.critical > 0 || (instance.score !== null && instance.score < 60)) return 'error';
  if (instance.warning > 0 || (instance.score !== null && instance.score < 85)) return 'warn';
  return 'ok';
}

function scoreClass(score: number | null): string {
  if (score === null) return '';
  if (score < 60) return 'score--error';
  if (score < 85) return 'score--warn';
  return 'score--ok';
}

function versionLabel(instance: FleetInstance): string {
  if (instance.engine === 'postgres' && instance.versionNum) {
    return `PG ${formatVersion(instance.versionNum)}`;
  }
  if (instance.versionText) {
    const trimmed = instance.versionText.trim();
    return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
  }
  return '—';
}

function throughputValue(instance: FleetInstance): string {
  const rate =
    instance.commitsPerSec ??
    instance.dmlTuplesPerSec ??
    instance.queriesPerSec ??
    instance.mongoOpsPerSec;
  if (rate === null) return '—';
  return `${formatCompactNumber(rate, 1)}/s`;
}

function memoryValue(instance: FleetInstance): string {
  if (instance.memUsedPct !== null) return formatPct(instance.memUsedPct, 0);
  if (instance.mongoMemResidentMb !== null) {
    return `${formatCompactNumber(instance.mongoMemResidentMb, 0)} MB`;
  }
  return '—';
}

function connectionsValue(instance: FleetInstance): string {
  if (instance.connectionsUsedPct !== null) return formatPct(instance.connectionsUsedPct, 0);
  if (instance.connectionsTotal !== null && instance.connectionsMax !== null) {
    return `${formatCompactNumber(instance.connectionsTotal)}/${formatCompactNumber(instance.connectionsMax)}`;
  }
  if (instance.connectionsTotal !== null) return formatCompactNumber(instance.connectionsTotal);
  return '—';
}

function waitValue(instance: FleetInstance): string {
  if (instance.maxBlockedSeconds === null) return '—';
  if (instance.maxBlockedSeconds <= 0) return '0s';
  return formatDuration(instance.maxBlockedSeconds);
}

function metric(value: string, label: string, shortLabel: string, showLabel: boolean) {
  return (
    <div className="fleet-card__metric" title={label}>
      <span className="fleet-card__metric-value">{value}</span>
      {showLabel ? <span className="fleet-card__metric-label">{shortLabel}</span> : null}
    </div>
  );
}

const METRIC_SHORT = {
  CPU: 'CPU',
  Memory: 'MEM',
  Throughput: 'TPT',
  Connections: 'CON',
  Wait: 'WAIT',
} as const;

export function FleetInstanceCard({
  instance,
  density = 'medium',
  onBadgeClick,
}: {
  instance: FleetInstance;
  density?: FleetCardDensity;
  onBadgeClick?: (severity: Severity, instance: FleetInstance) => void;
}) {
  const stale = isStale(instance);
  const tone = cardTone(instance, stale);
  const href = `/instances/${instance.instanceId}`;
  const engine = ENGINE_LABEL[instance.engine] ?? instance.engine;
  const compact = density === 'compact' || density === 'medium';
  const dense = density === 'compact';

  return (
    <article className={`fleet-card fleet-card--${tone} fleet-card--${density}`}>
      <Link href={href} className="fleet-card__link">
        <div className="fleet-card__head">
          <div className="fleet-card__title-block">
            <div className="fleet-card__title-row">
              <span className={`status-dot status-dot--${tone === 'idle' ? 'idle' : tone}`} />
              <span className="fleet-card__alias">{instance.alias}</span>
              {compact ? (
                <span className="fleet-card__score fleet-card__score--inline">
                  <span className={`score ${scoreClass(instance.score)}`}>
                    {instance.score ?? '—'}
                    <span className="score__max">/100</span>
                  </span>
                </span>
              ) : null}
            </div>
            {!compact ? (
              <div className="fleet-card__tags">
                <span className="tag tag--muted">{instance.environment}</span>
                <span className="tag tag--info">{engine}</span>
                {instance.inRecovery ? <span className="tag tag--info">standby</span> : null}
              </div>
            ) : dense ? null : (
              <div className="fleet-card__tags fleet-card__tags--compact">
                <span>{instance.environment}</span>
                <span>·</span>
                <span>{engine}</span>
              </div>
            )}
          </div>

          {!compact ? (
            <div className="fleet-card__score">
              <span className={`score ${scoreClass(instance.score)}`}>
                {instance.score ?? '—'}
                <span className="score__max">/100</span>
              </span>
            </div>
          ) : null}
        </div>

        {!compact ? (
          <div className="fleet-card__target">
            {instance.host}:{instance.port}/{instance.database}
          </div>
        ) : null}

        <div className={`fleet-card__metrics ${compact ? 'fleet-card__metrics--inline' : ''}`}>
          {metric(instance.cpuPct !== null ? formatPct(instance.cpuPct, 0) : '—', 'CPU', METRIC_SHORT.CPU, true)}
          {metric(memoryValue(instance), 'Memory', METRIC_SHORT.Memory, true)}
          {metric(
            throughputValue(instance),
            instance.commitsPerSec !== null
              ? 'Commits per second'
              : instance.dmlTuplesPerSec !== null
                ? 'DML tuples per second'
                : 'Throughput',
            METRIC_SHORT.Throughput,
            true,
          )}
          {metric(connectionsValue(instance), 'Connections', METRIC_SHORT.Connections, true)}
          {metric(
            waitValue(instance),
            instance.blockedSessions && instance.blockedSessions > 0
              ? `Max wait · ${instance.blockedSessions} blocked`
              : 'Max lock wait',
            METRIC_SHORT.Wait,
            true,
          )}
        </div>

        <div className="fleet-card__foot">
          {!compact ? <span className="fleet-card__version">{versionLabel(instance)}</span> : null}
          {!dense ? (
            <RelativeTime
              at={instance.lastSeenAt}
              className={`fleet-card__seen ${stale ? 'fleet-card__seen--stale' : ''}`}
            />
          ) : null}
        </div>
      </Link>

      {(instance.critical > 0 || instance.warning > 0) && onBadgeClick ? (
        <div className="fleet-card__badges">
          {instance.critical > 0 ? (
            <button
              type="button"
              className="fleet-card__badge fleet-card__badge--critical"
              onClick={() => onBadgeClick('critical', instance)}
            >
              {instance.critical} critical
            </button>
          ) : null}
          {instance.warning > 0 ? (
            <button
              type="button"
              className="fleet-card__badge fleet-card__badge--warning"
              onClick={() => onBadgeClick('warning', instance)}
            >
              {instance.warning} warn
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
