import { notFound } from 'next/navigation';
import { ApmBlameLite } from '@/components/ApmBlameLite';
import { BaselineAnomalies } from '@/components/BaselineAnomalies';
import { ChangeTimeline } from '@/components/ChangeTimeline';
import { DbaShield } from '@/components/DbaShield';
import { IncidentFreeze } from '@/components/IncidentFreeze';
import { InstanceTabs } from '@/components/InstanceTabs';
import {
  instanceProveRestoreItems,
  ProveRestore,
} from '@/components/ProveRestore';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { BlamePlaybook } from '@/components/BlamePlaybook';
import { BlockingChainLite } from '@/components/BlockingChainLite';
import { BlockingTreePanel } from '@/components/BlockingTreePanel';
import { WhoHoldsLocks } from '@/components/WhoHoldsLocks';
import { IndexAdvisorLite } from '@/components/IndexAdvisorLite';
import { PlanFingerprintHistory } from '@/components/PlanFingerprintHistory';
import { HaSloPanel } from '@/components/HaSloPanel';
import { VacuumRiskLite } from '@/components/VacuumRiskLite';
import { WaitClassTimeline } from '@/components/WaitClassTimeline';
import { DdlPlanCorrelate } from '@/components/DdlPlanCorrelate';
import { WaitSqlPlanBlame } from '@/components/WaitSqlPlanBlame';
import { ENGINE_LABEL, getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Blame tab: calm Overview stays elsewhere; this page answers
 * “who to page now” vs “what DBA risk remains”.
 */
export default async function BlamePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { id } = await params;
  const { v } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const windowKey =
    v === '1h' || v === '6h' || v === '24h' || v === '7d' ? v : '1h';
  const windowMinutes =
    windowKey === '1h'
      ? 60
      : windowKey === '6h'
        ? 360
        : windowKey === '24h'
          ? 1440
          : 10080;

  let instance;
  let engine;
  try {
    [instance, engine] = await Promise.all([getInstance(instanceId), getInstanceEngine(instanceId)]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const motor = engine ?? 'postgres';

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Blame' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Blame</h1>
            <p className="page-sub">
              Pain now vs DBA risk — recovery red does not mean the live pain is yours.
            </p>
          </div>
          <span className="tag tag--info">{ENGINE_LABEL[motor] ?? motor}</span>
        </header>

        <InstanceTabs
          instanceId={instanceId}
          engine={motor}
          blockedCount={instance.blockedSessions ?? 0}
        />

        <div className="flex flex-col gap-[0.875rem]">
          <IncidentFreeze
            instanceId={instanceId}
            windowKey={windowKey}
            windowMinutes={windowMinutes}
          />

          <BlamePlaybook
            instanceId={instanceId}
            alias={instance.alias}
            engine={motor}
            windowMinutes={windowMinutes}
            blockedSessions={instance.blockedSessions ?? 0}
          />

          <WaitSqlPlanBlame instanceId={instanceId} windowMinutes={windowMinutes} />

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <WaitClassTimeline instanceId={instanceId} windowMinutes={windowMinutes} />
            <BlockingChainLite
              instanceId={instanceId}
              alias={instance.alias}
              hours={Math.max(1, Math.round(windowMinutes / 60))}
              actionsEnabled
            />
          </div>

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <BlockingTreePanel
              instanceId={instanceId}
              hours={Math.max(1, Math.round(windowMinutes / 60))}
            />
            <WhoHoldsLocks
              instanceId={instanceId}
              hours={Math.max(1, Math.round(windowMinutes / 60))}
            />
          </div>

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <IndexAdvisorLite instanceId={instanceId} />
            <BaselineAnomalies instanceId={instanceId} />
          </div>

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <PlanFingerprintHistory instanceId={instanceId} windowMinutes={windowMinutes} />
            <HaSloPanel instanceId={instanceId} windowMinutes={Math.min(windowMinutes, 60)} />
          </div>

          {motor === 'postgres' ? (
            <DdlPlanCorrelate instanceId={instanceId} windowMinutes={windowMinutes} />
          ) : null}

          {motor === 'postgres' ? (
            <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
              <VacuumRiskLite instanceId={instanceId} />
            </div>
          ) : null}

          <DbaShield
            instanceId={instanceId}
            alias={instance.alias}
            connectionsUsedPct={instance.connectionsUsedPct}
            replicationLagSeconds={instance.replicationLagSeconds}
            windowMinutes={windowMinutes}
          />

          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <ChangeTimeline instanceId={instanceId} hours={24} limit={6} />
            <div id="prove-restore">
              <ProveRestore items={instanceProveRestoreItems(instanceId)} compact />
            </div>
          </div>

          <ApmBlameLite instanceId={instanceId} windowMinutes={windowMinutes} />
        </div>
      </div>
    </>
  );
}
