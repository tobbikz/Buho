import Link from 'next/link';
import { FleetOverviewClient } from '@/components/FleetOverviewClient';
import { GroupBy } from '@/components/GroupBy';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatClock } from '@/lib/format';
import {
  availableKeys,
  defaultGroupKey,
  groupInstances,
  matchesFilter,
  parseFilter,
} from '@/lib/grouping';
import { getFleetFindings, listInstances, type FleetInstance } from '@/lib/queries';

export const metadata = { title: 'Fleet · Búho' };

export const dynamic = 'force-dynamic';

const STALE_AFTER_MS = 120_000;

function isStale(instance: FleetInstance): boolean {
  if (!instance.lastSeenAt) return true;
  return Date.now() - new Date(instance.lastSeenAt).getTime() > STALE_AFTER_MS;
}

export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<{ agrupar?: string; filtro?: string; denegado?: string }>;
}) {
  const { agrupar, filtro, denegado } = await searchParams;

  let instances: FleetInstance[];
  let findings;
  try {
    [instances, findings] = await Promise.all([
      listInstances(),
      getFleetFindings(['critical', 'warning']),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  // Endpoints live under Observability — keep Databases overview DB-only.
  instances = instances.filter((i) => i.engine !== 'endpoint');

  const keys = availableKeys(instances);
  const groupKey = agrupar && keys.some((entry) => entry.key === agrupar)
    ? agrupar
    : defaultGroupKey(instances);
  const filter = parseFilter(filtro);
  const visible = filter ? instances.filter((instance) => matchesFilter(instance, filter)) : instances;
  const groups = groupInstances(visible, groupKey);
  const visibleIds = new Set(visible.map((instance) => instance.instanceId));
  const visibleFindings = findings.filter((finding) => visibleIds.has(finding.instanceId));

  const withCritical = visible.filter((instance) => instance.critical > 0).length;
  const warnings = visible.reduce((total, instance) => total + instance.warning, 0);
  const stale = visible.filter(isStale).length;
  const scored = visible.filter((instance) => instance.score !== null);
  const worstScore = scored.length > 0 ? Math.min(...scored.map((instance) => instance.score ?? 100)) : null;
  const waitSamples = visible
    .map((instance) => instance.maxBlockedSeconds)
    .filter((seconds): seconds is number => seconds !== null);
  const maxWaitSeconds = waitSamples.length > 0 ? Math.max(...waitSamples) : null;
  const waitingInstances = visible.filter(
    (instance) => (instance.maxBlockedSeconds ?? 0) > 0 || (instance.blockedSessions ?? 0) > 0,
  ).length;

  return (
    <>
      <Topbar crumbs={[{ label: 'Fleet' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Fleet overview</h1>
            <p className="page-sub">
              {visible.length} monitored instance{visible.length === 1 ? '' : 's'} · store read at{' '}
              {formatClock(new Date())}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {visible.length === 0 ? (
              <Link href="/get-started" className="btn btn--primary">
                Get started
              </Link>
            ) : (
              <Link href="/admin/targets" className="btn btn--primary">
                Add database
              </Link>
            )}
            {visible.length === 0 ? (
              <Link href="/admin/targets" className="btn">
                Add database
              </Link>
            ) : null}
            {filter ? (
              <Link href={`/?agrupar=${encodeURIComponent(groupKey)}`} className="tag tag--info">
                {filter.key}: {filter.value} ×
              </Link>
            ) : null}
            <GroupBy keys={keys} current={groupKey} />
          </div>
        </header>

        {denegado === 'admin' ? (
          <div className="notice notice--warn">
            That screen is admin-only and your account is read-only. You can see all monitoring; changing
            accounts, retention, or running discovery requires an administrator role.
          </div>
        ) : null}

        {instances.length === 0 ? (
          <div className="panel">
            <div className="empty">
              No instances yet.{' '}
              <Link href="/admin/targets" className="link">
                Add database
              </Link>{' '}
              from the console (targets persist in the store volume — do not use{' '}
              <code>docker compose down -v</code>), or bootstrap from{' '}
              <code>config.json</code> for labs.
            </div>
          </div>
        ) : (
          <FleetOverviewClient
            groups={groups}
            groupKey={groupKey}
            findings={visibleFindings}
            stats={{
              instanceCount: instances.length,
              withCritical,
              warnings,
              stale,
              worstScore,
              scoredCount: scored.length,
              maxWaitSeconds,
              waitingInstances,
            }}
          />
        )}
      </div>
    </>
  );
}
