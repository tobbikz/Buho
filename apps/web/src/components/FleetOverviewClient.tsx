'use client';

import { useEffect, useMemo, useState } from 'react';
import { FleetCardDensity, type FleetCardDensity as Density } from '@/components/FleetCardDensity';
import { FleetGrid } from '@/components/FleetGrid';
import { FindingsModalList } from '@/components/FindingsModal';
import { Modal } from '@/components/Modal';
import { StatCard, type StatTone } from '@/components/StatCard';
import { formatCompactNumber, formatDuration } from '@/lib/format';
import {
  findingLane,
  partitionFindings,
  postureHint,
  scoreIsMostlyPosture,
  toneForHealthScore,
} from '@/lib/health-posture';
import type { Group } from '@/lib/grouping';
import type { FleetFinding, FleetInstance, Severity } from '@/lib/queries';

const DENSITY_KEY = 'buho-fleet-card-density';

type ModalFilter = {
  severity: Severity | 'any';
  lane?: 'live' | 'posture' | 'all';
  instanceId?: number;
  instanceAlias?: string;
};

function ClickableStat({
  label,
  value,
  unit,
  hint,
  tone,
  onClick,
  disabled,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: StatTone;
  onClick?: () => void;
  disabled?: boolean;
}) {
  if (!onClick || disabled) {
    return <StatCard label={label} value={value} unit={unit} hint={hint} tone={tone} />;
  }

  return (
    <button type="button" className="stat-btn" onClick={onClick}>
      <StatCard label={label} value={value} unit={unit} hint={hint} tone={tone} />
    </button>
  );
}

export function FleetOverviewClient({
  groups,
  groupKey,
  findings,
  stats,
}: {
  groups: Group<FleetInstance>[];
  groupKey: string;
  findings: FleetFinding[];
  stats: {
    instanceCount: number;
    withCritical: number;
    warnings: number;
    stale: number;
    worstScore: number | null;
    scoredCount: number;
    maxWaitSeconds: number | null;
    waitingInstances: number;
  };
}) {
  const [density, setDensity] = useState<Density>('medium');
  const [modal, setModal] = useState<ModalFilter | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(DENSITY_KEY);
    if (saved === 'compact' || saved === 'medium' || saved === 'comfortable') {
      setDensity(saved);
    } else if (saved === 'standard') {
      setDensity('medium');
    }
  }, []);

  function changeDensity(next: Density) {
    setDensity(next);
    localStorage.setItem(DENSITY_KEY, next);
  }

  const { live: liveFindings, posture: postureFindings } = useMemo(
    () => partitionFindings(findings),
    [findings],
  );

  const liveCritical = liveFindings.filter((f) => f.severity === 'critical');
  const postureCritical = postureFindings.filter((f) => f.severity === 'critical');
  const liveWarnings = liveFindings.filter((f) => f.severity === 'warning');
  const postureWarnings = postureFindings.filter((f) => f.severity === 'warning');
  const mostlyPosture = scoreIsMostlyPosture(findings);
  const posture = postureHint(findings);

  const postureHeavyIds = useMemo(() => {
    const byInst = new Map<number, FleetFinding[]>();
    for (const finding of findings) {
      const list = byInst.get(finding.instanceId) ?? [];
      list.push(finding);
      byInst.set(finding.instanceId, list);
    }
    const ids = new Set<number>();
    for (const [id, list] of byInst) {
      if (scoreIsMostlyPosture(list)) ids.add(id);
    }
    return ids;
  }, [findings]);

  const visibleFindings = useMemo(() => {
    if (!modal) return [];
    return findings.filter((finding) => {
      if (modal.severity !== 'any' && finding.severity !== modal.severity) return false;
      if (modal.instanceId !== undefined && finding.instanceId !== modal.instanceId) return false;
      if (modal.lane === 'live' && findingLane(finding.checkId) !== 'live') return false;
      if (modal.lane === 'posture' && findingLane(finding.checkId) !== 'posture') return false;
      return true;
    });
  }, [findings, modal]);

  const modalTitle =
    modal?.instanceAlias !== undefined
      ? `${modal.severity === 'critical' ? 'Critical' : modal.severity === 'warning' ? 'Warnings' : 'Findings'} · ${modal.instanceAlias}`
      : modal?.lane === 'live'
        ? modal.severity === 'critical'
          ? 'Live critical'
          : 'Live warnings'
        : modal?.lane === 'posture'
          ? 'Posture gaps'
          : modal?.severity === 'critical'
            ? 'Critical findings'
            : 'Warnings';

  return (
    <>
      <div className="stat-grid">
        <StatCard
          label="Instances"
          value={formatCompactNumber(stats.instanceCount)}
          hint={stats.stale > 0 ? `${stats.stale} without recent data` : 'all reporting'}
          tone={stats.stale > 0 ? 'warn' : 'ok'}
        />
        <ClickableStat
          label="Live critical"
          value={formatCompactNumber(liveCritical.length)}
          hint={
            liveCritical.length === 0
              ? 'nothing to page for load/locks'
              : 'on-call · click to view'
          }
          tone={liveCritical.length > 0 ? 'error' : 'ok'}
          onClick={() => setModal({ severity: 'critical', lane: 'live' })}
          disabled={liveCritical.length === 0}
        />
        <ClickableStat
          label="Posture gaps"
          value={formatCompactNumber(postureCritical.length + postureWarnings.length)}
          hint={
            postureCritical.length > 0
              ? `${postureCritical.length} critical · backups/HA/RPO`
              : postureWarnings.length > 0
                ? 'config / recovery — not a live outage'
                : 'recovery chain looks OK'
          }
          tone={
            postureCritical.length > 0 ? 'warn' : postureWarnings.length > 0 ? 'warn' : 'ok'
          }
          onClick={() => setModal({ severity: 'any', lane: 'posture' })}
          disabled={postureCritical.length + postureWarnings.length === 0}
        />
        <StatCard
          label={mostlyPosture ? 'Posture score' : 'Worst score'}
          value={stats.worstScore === null ? '—' : formatCompactNumber(stats.worstScore)}
          unit={stats.worstScore === null ? undefined : '/100'}
          tone={toneForHealthScore(stats.worstScore, mostlyPosture)}
          hint={
            mostlyPosture
              ? 'low because of config/recovery — not a SEV-1'
              : stats.scoredCount === 0
                ? 'no check runs'
                : liveWarnings.length > 0
                  ? `${liveWarnings.length} live warning(s)`
                  : undefined
          }
        />
        <StatCard
          label="Wait time"
          value={
            stats.maxWaitSeconds === null
              ? '—'
              : stats.maxWaitSeconds > 0
                ? formatDuration(stats.maxWaitSeconds)
                : '0s'
          }
          hint={
            stats.waitingInstances > 0
              ? `${stats.waitingInstances} instance${stats.waitingInstances === 1 ? '' : 's'} waiting`
              : 'no active lock waits'
          }
          tone={
            stats.maxWaitSeconds === null
              ? 'neutral'
              : stats.maxWaitSeconds > 60
                ? 'error'
                : stats.maxWaitSeconds > 0
                  ? 'warn'
                  : 'ok'
          }
        />
      </div>

      {posture ? <div className="notice">{posture}</div> : null}

      <div className="fleet-toolbar">
        <FleetCardDensity value={density} onChange={changeDensity} />
      </div>

      <FleetGrid
        groups={groups}
        groupKey={groupKey}
        density={density}
        postureHeavyIds={postureHeavyIds}
        onBadgeClick={(severity, instance) =>
          setModal({
            severity,
            lane: 'live',
            instanceId: instance.instanceId,
            instanceAlias: instance.alias,
          })
        }
      />

      <Modal
        open={modal !== null}
        title={modalTitle}
        subtitle={
          visibleFindings.length > 0
            ? `${visibleFindings.length} finding${visibleFindings.length === 1 ? '' : 's'}`
            : undefined
        }
        onClose={() => setModal(null)}
      >
        <FindingsModalList findings={visibleFindings} />
      </Modal>
    </>
  );
}
