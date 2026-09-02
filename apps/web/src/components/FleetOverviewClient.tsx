'use client';

import { useEffect, useMemo, useState } from 'react';
import { FleetCardDensity, type FleetCardDensity as Density } from '@/components/FleetCardDensity';
import { FleetGrid } from '@/components/FleetGrid';
import { FindingsModalList } from '@/components/FindingsModal';
import { Modal } from '@/components/Modal';
import { StatCard, toneForScore, type StatTone } from '@/components/StatCard';
import { formatNumber, formatDuration } from '@/lib/format';
import type { Group } from '@/lib/grouping';
import type { FleetFinding, FleetInstance, Severity } from '@/lib/queries';

const DENSITY_KEY = 'buho-fleet-card-density';

type ModalFilter = {
  severity: Severity;
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

  const visibleFindings = useMemo(() => {
    if (!modal) return [];
    return findings.filter((finding) => {
      if (finding.severity !== modal.severity) return false;
      if (modal.instanceId !== undefined && finding.instanceId !== modal.instanceId) return false;
      return true;
    });
  }, [findings, modal]);

  const criticalCount = findings.filter((finding) => finding.severity === 'critical').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;

  const modalTitle =
    modal?.instanceAlias !== undefined
      ? `${modal.severity === 'critical' ? 'Critical' : 'Warnings'} · ${modal.instanceAlias}`
      : modal?.severity === 'critical'
        ? 'Critical findings'
        : 'Warnings';

  return (
    <>
      <div className="stat-grid">
        <StatCard
          label="Instances"
          value={formatNumber(stats.instanceCount)}
          hint={stats.stale > 0 ? `${stats.stale} without recent data` : 'all reporting'}
          tone={stats.stale > 0 ? 'warn' : 'ok'}
        />
        <ClickableStat
          label="With critical"
          value={formatNumber(stats.withCritical)}
          hint={stats.withCritical === 0 ? 'nothing to handle now' : 'click to view'}
          tone={stats.withCritical > 0 ? 'error' : 'ok'}
          onClick={() => setModal({ severity: 'critical' })}
          disabled={criticalCount === 0}
        />
        <ClickableStat
          label="Open warnings"
          value={formatNumber(stats.warnings)}
          hint={stats.warnings === 0 ? undefined : 'click to view'}
          tone={stats.warnings > 0 ? 'warn' : 'ok'}
          onClick={() => setModal({ severity: 'warning' })}
          disabled={warningCount === 0}
        />
        <StatCard
          label="Worst score"
          value={stats.worstScore === null ? '—' : formatNumber(stats.worstScore)}
          unit={stats.worstScore === null ? undefined : '/100'}
          tone={toneForScore(stats.worstScore)}
          hint={stats.scoredCount === 0 ? 'no check runs' : undefined}
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

      <div className="fleet-toolbar">
        <FleetCardDensity value={density} onChange={changeDensity} />
      </div>

      <FleetGrid
        groups={groups}
        groupKey={groupKey}
        density={density}
        onBadgeClick={(severity, instance) =>
          setModal({
            severity,
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
