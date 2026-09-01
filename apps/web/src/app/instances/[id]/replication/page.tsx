import { notFound, redirect } from 'next/navigation';
import { AutoRefresh } from '@/components/AutoRefresh';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatClock, formatDuration, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance, getSeries, getSeriesByLabel } from '@/lib/queries';
import { getInstanceReplication, type InstanceReplicationRow } from '@/lib/replication';

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '6h', minutes: 360, bucket: 60 },
  { key: '24h', minutes: 1440, bucket: 300 },
  { key: '7d', minutes: 10080, bucket: 1800 },
];

const ROLE_LABEL: Record<string, string> = {
  primary: 'Primario',
  standby: 'Standby',
  slot: 'Slot',
  replica: 'Replica',
  availability_group: 'Grupo de disponibilidad',
};

/**
 * Colores estables por standby.
 *
 * Con un color asignado por posición, agregar un standby nuevo recolorea todos
 * los demás y una comparación entre dos capturas de pantalla deja de servir.
 */
const SERIES_COLORS = ['#1f5f8b', '#9a4a00', '#2f6b4f', '#7b1fa2', '#b01818', '#4a6fa5'];

function slotRow(row: InstanceReplicationRow) {
  const safeWal = row.detail['safe_wal_size'];
  const walStatus = typeof row.detail['wal_status'] === 'string' ? row.detail['wal_status'] : null;

  return (
    <tr key={`${row.role}:${row.peer}`}>
      <td className="font-mono text-[11.5px]">{row.peer}</td>
      <td>
        <span
          className={`tag ${
            row.state === 'active' || row.state === 'streaming'
              ? 'tag--ok'
              : row.state === 'inactive'
                ? 'tag--error'
                : 'tag--muted'
          }`}
        >
          {row.state ?? 'no state'}
        </span>
      </td>
      <td className="num">{row.lagBytes === null ? '—' : formatBytes(row.lagBytes)}</td>
      <td className="num">{row.lagSeconds === null ? '—' : formatDuration(row.lagSeconds)}</td>
      <td className="font-mono text-[11px] text-foreground-muted">
        {walStatus ?? '—'}
        {typeof safeWal === 'number' && safeWal > 0 ? ` · ${formatBytes(safeWal)} de margen` : ''}
      </td>
      <td className="font-mono text-[10px] text-foreground-muted">{formatAgo(row.capturedAt)}</td>
    </tr>
  );
}

export default async function ReplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { id } = await params;
  const { w } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engineKind = await getInstanceEngine(instanceId);
  if (engineKind && engineKind !== 'postgres') redirect(`/instances/${instanceId}`);

  const window = WINDOWS.find((candidate) => candidate.key === w) ?? WINDOWS[1]!;

  let instance;
  try {
    instance = await getInstance(instanceId);
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

  const crumbs = [
    { label: 'Fleet', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Replication' },
  ];

  let rows: InstanceReplicationRow[];
  let lag: Awaited<ReturnType<typeof getSeriesByLabel>>;
  let standby: Awaited<ReturnType<typeof getSeries>>;
  try {
    [rows, lag, standby] = await Promise.all([
      getInstanceReplication(instanceId),
      getSeriesByLabel(
        instanceId,
        'replication_replay_lag_seconds',
        'standby',
        window.minutes,
        window.bucket,
        6,
      ),
      getSeries(
        instanceId,
        ['standby_replay_delay_seconds', 'standby_pending_bytes', 'replication_standbys'],
        window.minutes,
        window.bucket,
      ),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }

  const standbys = rows.filter((row) => row.role === 'standby' || row.role === 'replica');
  const slots = rows.filter((row) => row.role === 'slot');
  const primary = rows.find((row) => row.role === 'primary');
  // En una réplica, la fila `upstream` es su enlace con el primario: de ahí sale
  // de who depende esta instancia.
  const upstream = rows.find((row) => row.role === 'upstream');

  // El último punto de la serie: la foto de inventario se toma cada hora, pero
  // las métricas del standby cada medio minuto, y para "ahora" gana la métrica.
  const lastPoint = standby.at(-1);
  const ownDelay = (lastPoint?.['standby_replay_delay_seconds'] as number | null | undefined) ?? null;
  const ownPending = (lastPoint?.['standby_pending_bytes'] as number | null | undefined) ?? null;
  const inactiveSlots = slots.filter((row) => row.state === 'inactive');
  const worstLag = standbys.reduce((peak, row) => Math.max(peak, row.lagSeconds ?? 0), 0);
  const isStandby = instance.inRecovery;

  // Sin filas de replicación y sin recuperación, esta instancia es un servidor
  // solo. Decirlo es más útil que seis paneles vacíos.
  const standalone = rows.length === 0 && !isStandby;

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Replication · {instance.alias}</h1>
            <p className="page-sub">
              Lag over time, not only right now. A standby that falls behind on every nightly load and
              catches up by day does not show in a snapshot, and that is the difference between a healthy system and one that will fail
              cuando haga falta promoverlo.
            </p>
          </div>
          <AutoRefresh intervalMs={30000} />
        </header>

        <InstanceTabs instanceId={instanceId} />

        {standalone ? (
          <div className="notice">
            <strong>This instance has no replication configured.</strong> No connected standbys, not
            in recovery, and no slots. If it should have a replica, that is already a finding: the{' '}
            <span className="font-mono">replication_lag</span> overview check cannot warn about a standby that
            never existió.
          </div>
        ) : (
          <div className="stat-grid">
            <StatCard
              label="Rol"
              value={isStandby ? 'Standby' : 'Primario'}
              tone="neutral"
              hint={isStandby ? 'aplicando WAL' : `${standbys.length} standby(s) conectado(s)`}
            />
            {/* En un standby no hay standbys propios ni lag de otros: sus
                tarjetas son el retraso propio, que sale de las métricas. */}
            {!isStandby && (
              <>
                <StatCard
                  label="Standbys"
                  value={formatNumber(standbys.length)}
                  tone={standbys.length === 0 ? 'warn' : 'ok'}
                  hint="with an open streaming session"
                />
                <StatCard
                  label="Max lag"
                  value={worstLag > 0 ? formatDuration(worstLag) : '0 s'}
                  tone={worstLag >= 60 ? 'error' : worstLag >= 10 ? 'warn' : 'ok'}
                  hint="worst standby now"
                />
              </>
            )}
            {isStandby && (
              <>
                <StatCard
                  label="Retraso propio"
                  value={ownDelay === null ? '—' : formatDuration(ownDelay)}
                  tone={
                    ownDelay === null ? 'neutral' : ownDelay >= 60 ? 'error' : ownDelay >= 10 ? 'warn' : 'ok'
                  }
                  hint="since the last applied change"
                />
                <StatCard
                  label="WAL not applied"
                  value={ownPending === null ? '—' : formatBytes(ownPending)}
                  tone={ownPending && ownPending > 64 * 1024 * 1024 ? 'warn' : 'ok'}
                  hint={
                    // Un retraso alto con cero bytes pendientes es un primario
                    // quieto, no una réplica atrasada. Es la confusión más común.
                    ownPending === 0 ? 'caught up: primary is idle' : 'received and pending'
                  }
                />
              </>
            )}
            {(slots.length > 0 || !isStandby) && (
            <StatCard
              label="Slots"
              value={formatNumber(slots.length)}
              tone={inactiveSlots.length > 0 ? 'error' : 'neutral'}
              hint={
                inactiveSlots.length > 0
                  ? `${inactiveSlots.length} inactivo(s): retienen WAL`
                  : 'todos activos'
              }
            />
            )}
            {upstream ? (
              <StatCard
                label="Recibe de"
                value={upstream.peer || '—'}
                tone={upstream.state === 'streaming' ? 'ok' : 'warn'}
                hint={upstream.state ?? 'no state'}
              />
            ) : (
              primary && (
                <StatCard
                  label="Primario"
                  value={primary.peer || '—'}
                  tone="neutral"
                  hint={primary.state ?? 'no state'}
                />
              )
            )}
          </div>
        )}

        {inactiveSlots.length > 0 && (
          <div className="notice notice--warn">
            <strong>
              {inactiveSlots.length} slot{inactiveSlots.length === 1 ? '' : 's'} inactivo
              {inactiveSlots.length === 1 ? '' : 's'}.
            </strong>{' '}
            A slot with no consumer retains WAL forever: the most common way to fill the disk of a
            healthy primary. If the consumer is not coming back,{' '}
            <span className="font-mono">pg_drop_replication_slot()</span> libera el espacio.
          </div>
        )}

        {!standalone && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Window</span>
            {WINDOWS.map((candidate) => (
              <a
                key={candidate.key}
                href={`/instances/${instanceId}/replication?w=${candidate.key}`}
                className={`tag ${candidate.key === window.key ? 'tag--info' : 'tag--muted'}`}
              >
                {candidate.key}
              </a>
            ))}
          </div>
        )}

        {isStandby ? (
          <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
            <TimeseriesPanel
              title="Apply delay"
              hint={`window ${window.key} · measured on this standby`}
              data={standby}
              unit="seconds"
              height={170}
              series={[
                { metric: 'standby_replay_delay_seconds', label: 'Retraso', color: '#9a4a00' },
              ]}
            />
            <TimeseriesPanel
              title="WAL received not applied"
              hint={`window ${window.key}`}
              data={standby}
              unit="bytes"
              height={170}
              series={[{ metric: 'standby_pending_bytes', label: 'Pendiente de aplicar', color: '#1f5f8b' }]}
            />
          </div>
        ) : (
          !standalone && (
            <TimeseriesPanel
              title="Apply lag by standby"
              hint={`window ${window.key}`}
              data={lag.points}
              unit="seconds"
              height={190}
              series={lag.keys.map((key, index) => ({
                metric: key,
                label: key,
                color: SERIES_COLORS[index % SERIES_COLORS.length]!,
              }))}
            />
          )
        )}

        {standbys.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Standbys · {standbys.length}</span>
              <span className="font-mono text-[10px] text-foreground-muted">estado actual</span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Standby</th>
                    <th>State</th>
                    <th className="text-right">Bytes behind</th>
                    <th className="text-right">Seconds behind</th>
                    <th>Detail</th>
                    <th className="text-right">Visto</th>
                  </tr>
                </thead>
                <tbody>
                  {standbys.map((row) => {
                    const syncState = row.detail['sync_state'];
                    const client = row.detail['client_addr'];
                    return (
                      <tr key={`${row.role}:${row.peer}`}>
                        <td className="font-mono text-[11.5px]">{row.peer}</td>
                        <td>
                          <span className={`tag ${row.state === 'streaming' ? 'tag--ok' : 'tag--warn'}`}>
                            {row.state ?? 'no state'}
                          </span>
                        </td>
                        <td className="num">{row.lagBytes === null ? '—' : formatBytes(row.lagBytes)}</td>
                        <td className="num">
                          <span
                            className={
                              (row.lagSeconds ?? 0) >= 60
                                ? 'text-[var(--error)]'
                                : (row.lagSeconds ?? 0) >= 10
                                  ? 'text-[var(--warning)]'
                                  : ''
                            }
                          >
                            {row.lagSeconds === null ? '—' : formatDuration(row.lagSeconds)}
                          </span>
                        </td>
                        <td className="font-mono text-[11px] text-foreground-muted">
                          {typeof syncState === 'string' ? syncState : '—'}
                          {typeof client === 'string' ? ` · ${client}` : ''}
                        </td>
                        <td className="num font-mono text-[10px] text-foreground-muted">
                          {formatClock(row.capturedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {slots.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Slots · {slots.length}</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                an inactive slot retains WAL until the disk fills
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>State</th>
                    <th className="text-right">WAL retenido</th>
                    <th className="text-right">Seconds behind</th>
                    <th>WAL status</th>
                    <th className="text-right">Visto</th>
                  </tr>
                </thead>
                <tbody>{slots.map(slotRow)}</tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
