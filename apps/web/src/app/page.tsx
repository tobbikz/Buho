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
        <Topbar crumbs={[{ label: 'Flota' }]} />
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
      <Topbar crumbs={[{ label: 'Flota' }]} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Resumen de flota</h1>
            <p className="page-sub">
              {visible.length} instancia{visible.length === 1 ? '' : 's'} monitoreada
              {visible.length === 1 ? '' : 's'} · lectura del store a las {formatClock(new Date())}
            </p>
          </div>
          <div className="flex items-center gap-2">
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
            Esa pantalla es de administración y tu cuenta es de sólo lectura. Puedes ver todo el monitoreo; cambiar
            cuentas, retención o lanzar un descubrimiento requiere rol de administrador.
          </div>
        ) : null}

        <div className="stat-grid">
          <StatCard
            label="Instancias"
            value={formatNumber(instances.length)}
            hint={stale > 0 ? `${stale} sin datos recientes` : 'todas reportando'}
            tone={stale > 0 ? 'warn' : 'ok'}
          />
          <StatCard
            label="Con críticos"
            value={formatNumber(withCritical)}
            hint={withCritical === 0 ? 'nada que atender ahora' : 'requieren atención'}
            tone={withCritical > 0 ? 'error' : 'ok'}
          />
          <StatCard label="Avisos abiertos" value={formatNumber(warnings)} tone={warnings > 0 ? 'warn' : 'ok'} />
          <StatCard
            label="Peor score"
            value={worstScore === null ? '—' : formatNumber(worstScore)}
            unit={worstScore === null ? undefined : '/100'}
            tone={toneForScore(worstScore)}
            hint={scored.length === 0 ? 'sin corridas de checks' : undefined}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Instancias</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {groupKey === NO_GROUP ? 'peor score primero' : `agrupadas por ${groupKey}, grupos con críticos primero`}
            </span>
          </div>
          {instances.length === 0 ? (
            <div className="empty">
              No hay instancias registradas todavía. Levantar el colector con <code>npm run collector</code> para
              que se registren solas.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Instancia</th>
                    <th>Destino</th>
                    <th>Versión</th>
                    <th className="text-right">Score</th>
                    <th className="text-right">Crít.</th>
                    <th className="text-right">Avisos</th>
                    <th className="text-right">Conexiones</th>
                    <th className="text-right">Cache hit</th>
                    <th className="text-right">Commits/s</th>
                    <th className="text-right">Uptime</th>
                    <th className="text-right">Último dato</th>
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
                                  ? ` · ${group.instances.reduce((sum, item) => sum + item.critical, 0)} críticos`
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
            <span className="panel-title">Eventos del colector</span>
            <span className="font-mono text-[10px] text-foreground-muted">últimos {events.length}</span>
          </div>
          {events.length === 0 ? (
            <div className="empty">Sin eventos registrados.</div>
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
