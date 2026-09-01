import Link from 'next/link';
import { GroupBy } from '@/components/GroupBy';
import { StatCard, toneForScore } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatClock, formatDuration, formatNumber, formatPct, formatVersion } from '@/lib/format';
import {
  availableKeys,
  defaultGroupKey,
  groupInstances,
  matchesFilter,
  parseFilter,
  NO_GROUP,
} from '@/lib/grouping';
import { getEvents, listInstances, type FleetInstance } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const STALE_AFTER_MS = 120_000;

function isStale(instance: FleetInstance): boolean {
  if (!instance.lastSeenAt) return true;
  return Date.now() - new Date(instance.lastSeenAt).getTime() > STALE_AFTER_MS;
}

function scoreClass(score: number | null): string {
  if (score === null) return '';
  if (score < 60) return 'score--error';
  if (score < 85) return 'score--warn';
  return 'score--ok';
}

export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<{ agrupar?: string; filtro?: string; denegado?: string }>;
}) {
  const { agrupar, filtro, denegado } = await searchParams;

  let instances: FleetInstance[];
  try {
    instances = await listInstances();
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

  const events = await getEvents(null, 12).catch(() => []);

  const keys = availableKeys(instances);
  const groupKey = agrupar && keys.some((entry) => entry.key === agrupar)
    ? agrupar
    : defaultGroupKey(instances);
  const filter = parseFilter(filtro);
  const visible = filter ? instances.filter((instance) => matchesFilter(instance, filter)) : instances;
  const groups = groupInstances(visible, groupKey);

  const withCritical = visible.filter((instance) => instance.critical > 0).length;
  const warnings = visible.reduce((total, instance) => total + instance.warning, 0);
  const stale = visible.filter(isStale).length;
  const scored = visible.filter((instance) => instance.score !== null);
  const worstScore = scored.length > 0 ? Math.min(...scored.map((instance) => instance.score ?? 100)) : null;

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
            <Link href="/admin/instances" className="btn btn--primary">
              Add database
            </Link>
            {filter ? (
              <Link href={`/?agrupar=${encodeURIComponent(groupKey)}`} className="tag tag--info">
                {filter.key}: {filter.value} ×
              </Link>
            ) : null}
            <GroupBy keys={keys} current={groupKey} />
          </div>
        </header>

        {denegado === 'admin' ? (
          // Sin esto, un viewer que llega por un enlace guardado aparece en la
          // flota sin explicación y cree que la página se rompió.
          <div className="notice notice--warn">
            That screen is admin-only and your account is read-only. You can see all monitoring; changing
            accounts, retention, or running discovery requires an administrator role.
          </div>
        ) : null}

        <div className="stat-grid">
          <StatCard
            label="Instances"
            value={formatNumber(instances.length)}
            hint={stale > 0 ? `${stale} without recent data` : 'all reporting'}
            tone={stale > 0 ? 'warn' : 'ok'}
          />
          <StatCard
            label="With critical"
            value={formatNumber(withCritical)}
            hint={withCritical === 0 ? 'nothing to handle now' : 'need attention'}
            tone={withCritical > 0 ? 'error' : 'ok'}
          />
          <StatCard label="Open warnings" value={formatNumber(warnings)} tone={warnings > 0 ? 'warn' : 'ok'} />
          <StatCard
            label="Worst score"
            value={worstScore === null ? '—' : formatNumber(worstScore)}
            unit={worstScore === null ? undefined : '/100'}
            tone={toneForScore(worstScore)}
            hint={scored.length === 0 ? 'no check runs' : undefined}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Instancias</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {groupKey === NO_GROUP ? 'worst score first' : `grouped by ${groupKey}, groups with criticals first`}
            </span>
          </div>
          {instances.length === 0 ? (
            <div className="empty">
              No instances registered yet. Start the collector with <code>npm run collector</code> to
              que se registren solas.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instancia</th>
                    <th>Destino</th>
                    <th>Version</th>
                    <th className="text-right">Score</th>
                    <th className="text-right">Crit.</th>
                    <th className="text-right">Warn</th>
                    <th className="text-right">Connections</th>
                    <th className="text-right">Cache hit</th>
                    <th className="text-right">Commits/s</th>
                    <th className="text-right">Uptime</th>
                    <th className="text-right">Last sample</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.flatMap((group) => [
                    ...(group.value
                      ? [
                          <tr key={`grupo-${group.value}`} className="group-row">
                            <td colSpan={11}>
                              <Link
                                href={`/?agrupar=${encodeURIComponent(groupKey)}&filtro=${encodeURIComponent(`${groupKey}:${group.value}`)}`}
                                className="group-row__label"
                              >
                                {group.value}
                              </Link>
                              <span className="group-row__meta">
                                {group.instances.length} instancia{group.instances.length === 1 ? '' : 's'}
                                {group.instances.reduce((sum, item) => sum + item.critical, 0) > 0
                                  ? ` · ${group.instances.reduce((sum, item) => sum + item.critical, 0)} critical`
                                  : ''}
                              </span>
                            </td>
                          </tr>,
                        ]
                      : []),
                    ...group.instances.map((instance) => {
                    const staleRow = isStale(instance);
                    return (
                      <tr key={instance.instanceId}>
                        <td>
                          <div className="flex items-center gap-2">
                            <span
                              className={`status-dot ${
                                staleRow
                                  ? 'status-dot--idle'
                                  : instance.critical > 0
                                    ? 'status-dot--error'
                                    : instance.warning > 0
                                      ? 'status-dot--warn'
                                      : 'status-dot--ok'
                              }`}
                            />
                            <Link
                              href={`/instances/${instance.instanceId}`}
                              className="font-mono text-[12px] font-semibold text-accent hover:underline"
                            >
                              {instance.alias}
                            </Link>
                            <span className="tag tag--muted">{instance.environment}</span>
                            {instance.inRecovery && <span className="tag tag--info">standby</span>}
                          </div>
                        </td>
                        <td className="font-mono text-[11px] text-foreground-secondary">
                          {instance.host}:{instance.port}/{instance.database}
                        </td>
                        <td className="font-mono text-[11px]">
                          {instance.versionNum ? `PG ${formatVersion(instance.versionNum)}` : '—'}
                        </td>
                        <td className="num">
                          <span className={`score ${scoreClass(instance.score)}`}>
                            {instance.score ?? '—'}
                            <span className="score__max">/100</span>
                          </span>
                        </td>
                        <td className="num">{instance.critical > 0 ? instance.critical : '·'}</td>
                        <td className="num">{instance.warning > 0 ? instance.warning : '·'}</td>
                        <td className="num">
                          {instance.connectionsTotal === null
                            ? '—'
                            : `${formatNumber(instance.connectionsTotal)}/${formatNumber(instance.connectionsMax)}`}
                          <span className="ml-1 text-[10px] text-foreground-muted">
                            {formatPct(instance.connectionsUsedPct, 0)}
                          </span>
                        </td>
                        <td className="num">{formatPct(instance.cacheHitPct, 1)}</td>
                        <td className="num">{formatNumber(instance.commitsPerSec, 1)}</td>
                        <td className="num">{formatDuration(instance.uptimeSeconds)}</td>
                        <td className="num" style={{ color: staleRow ? 'var(--warning)' : undefined }}>
                          {formatAgo(instance.lastSeenAt)}
                        </td>
                      </tr>
                    );
                  }),
                  ])}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Collector events</span>
            <span className="font-mono text-[10px] text-foreground-muted">latest {events.length}</span>
          </div>
          {events.length === 0 ? (
            <div className="empty">No events recorded.</div>
          ) : (
            <table className="data-table">
              <tbody>
                {events.map((event, index) => (
                  <tr key={`${event.ts}-${index}`}>
                    <td className="font-mono text-[11px] text-foreground-muted" style={{ width: '5.5rem' }}>
                      {formatClock(event.ts)}
                    </td>
                    <td style={{ width: '4.5rem' }}>
                      <span
                        className={`tag ${
                          event.level === 'error' ? 'tag--error' : event.level === 'warn' ? 'tag--warn' : 'tag--muted'
                        }`}
                      >
                        {event.level}
                      </span>
                    </td>
                    <td className="font-mono text-[11px] text-foreground-secondary" style={{ width: '11rem' }}>
                      {event.component}
                    </td>
                    <td className="text-[12px]">{event.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
