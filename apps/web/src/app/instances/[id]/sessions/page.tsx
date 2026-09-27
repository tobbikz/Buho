import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IncidentPanel } from '@/components/IncidentPanel';
import { InstanceTabs } from '@/components/InstanceTabs';
import { LabeledBars } from '@/components/LabeledBars';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { WaitStack } from '@/components/WaitStack';
import { formatDuration, formatNumber, formatPct } from '@/lib/format';
import { explainIncident } from '@/lib/incident';
import { getInstance } from '@/lib/queries';
import {
  getInterestingMoments,
  getSessionsAt,
  getWaitShares,
  getWaitTimeline,
  WAIT_TYPE_HELP,
} from '@/lib/sessions';

const WAIT_ORDER = ['CPU', 'IO', 'Lock', 'LWLock', 'IPC', 'Timeout', 'Client'];
const SAMPLE_SECONDS = 10;

function waitElapsed(waits: { waitType: string; sessions: number }[]) {
  const seconds = new Map<string, number>();
  for (const wait of waits) {
    seconds.set(wait.waitType, (seconds.get(wait.waitType) ?? 0) + wait.sessions * SAMPLE_SECONDS);
  }
  const named = WAIT_ORDER.filter((type) => seconds.has(type));
  const rest = [...seconds.keys()].filter((type) => !WAIT_ORDER.includes(type));
  return [...named, ...rest].map((type) => ({
    type,
    label: formatDuration(seconds.get(type) ?? 0),
  }));
}

export const dynamic = 'force-dynamic';

const WINDOWS = [
  { key: '1h', label: '1 h', minutes: 60 },
  { key: '6h', label: '6 h', minutes: 360 },
  { key: '24h', label: '24 h', minutes: 1440 },
  { key: '7d', label: '7 d', minutes: 10080 },
];

function duracion(ms: number | null): string {
  if (ms === null) return '·';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; t?: string }>;
}) {
  const { id } = await params;
  const { v, t } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();


  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[1]!;
  const momento = t ? new Date(t) : new Date();

  let instancia;
  let esperas;
  let serie;
  let foto;
  let momentos;
  let incidente;
  try {
    instancia = await getInstance(instanceId);
    [esperas, serie, foto, momentos, incidente] = await Promise.all([
      getWaitShares(instanceId, window.minutes),
      getWaitTimeline(instanceId, window.minutes),
      getSessionsAt(instanceId, Number.isFinite(momento.getTime()) ? momento : new Date()),
      getInterestingMoments(instanceId, window.minutes),
      explainIncident(instanceId, window.minutes),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Sessions' }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instancia) notFound();

  const enlace = (cambios: Record<string, string>) => {
    const parametros = new URLSearchParams({ v: window.key, ...(t ? { t } : {}), ...cambios });
    return `/instances/${instanceId}/sessions?${parametros.toString()}`;
  };

  const cpu = esperas.waits.find((espera) => espera.waitType === 'CPU');
  const bloqueos = esperas.waits
    .filter((espera) => espera.waitType === 'Lock')
    .reduce((suma, espera) => suma + espera.share, 0);
  const disco = esperas.waits
    .filter((espera) => espera.waitType === 'IO')
    .reduce((suma, espera) => suma + espera.share, 0);

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Fleet', href: '/' },
          { label: instancia.alias, href: `/instances/${instanceId}` },
          { label: 'Sessions' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Sessions and waits · {instancia.alias}</h1>
            <p className="page-sub">
              En qué se va el tiempo del servidor —CPU, disco, bloqueos, red— y qué estaba corriendo en un momento
              concreto. Sale de una foto cada diez segundos (
              {instancia.engine === 'mariadb'
                ? <span className="font-mono">PROCESSLIST</span>
                : instancia.engine === 'mssql'
                  ? <span className="font-mono">dm_exec_requests</span>
                  : <span className="font-mono">pg_stat_activity</span>}
              ), so it is <strong>sampling</strong>: it measures what lasts and misses the instantaneous.
            </p>
          </div>
        </header>

        <InstanceTabs
          instanceId={instanceId}
          engine={instancia.engine ?? 'postgres'}
          blockedCount={instancia.blockedSessions ?? 0}
        />

        <IncidentPanel
          headline={incidente.headline}
          body={incidente.body}
          tone={incidente.tone}
          at={incidente.at}
        />

        <div className="stat-grid">
          <StatCard
            label="Busy sessions"
            value={esperas.averageBusy.toFixed(1)}
            hint="average concurrent in the window"
            tone="accent"
          />
          <StatCard
            label="Trabajando (CPU)"
            value={cpu ? formatPct(cpu.share * 100, 0) : '·'}
            hint="of session time, not waiting"
          />
          <StatCard
            label="Waiting on locks"
            value={formatPct(bloqueos * 100, 0)}
            hint="hardware will not fix this"
            tone={bloqueos > 0.15 ? 'error' : bloqueos > 0.05 ? 'warn' : 'neutral'}
          />
          <StatCard
            label="Waiting on disk"
            value={formatPct(disco * 100, 0)}
            hint="cache is short or storage cannot keep up"
            tone={disco > 0.4 ? 'warn' : 'neutral'}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Wait profile over time</span>
            <div className="flex items-center gap-1">
              {WINDOWS.map((opcion) => (
                <Link
                  key={opcion.key}
                  href={enlace({ v: opcion.key })}
                  className={`tag ${opcion.key === window.key ? 'tag--info' : 'tag--muted'}`}
                >
                  {opcion.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="panel-body">
            <WaitStack
              buckets={serie.map((cubo) => ({
                bucket: cubo.bucket.toISOString(),
                byType: cubo.byType,
                total: cubo.total,
              }))}
              elapsed={waitElapsed(esperas.waits)}
              emptyMessage="No session samples in this window yet. Sampling writes every ten seconds; if the instance was just added, wait a minute."
            />
            <p className="mt-2 text-[11px] text-foreground-muted">
              Height is <strong>sessions at once</strong>, not summed waits: so you can compare against
              número de cores del servidor. Si la barra verde supera los cores, el cuello es CPU; si crece la roja,
              son transactions que se pisan y no hay hardware que lo arregle.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <LabeledBars
            title="Where waits go"
            footer={`${formatNumber(esperas.samples)} samples`}
            rows={esperas.waits.map((espera) => ({
              label: espera.waitEvent ? `${espera.waitType} · ${espera.waitEvent}` : espera.waitType,
              sub: WAIT_TYPE_HELP[espera.waitType],
              value: espera.share,
              display: `${formatPct(espera.share * 100, 1)} · ${espera.averageSessions.toFixed(2)} ses.`,
              tone:
                espera.waitType === 'Lock'
                  ? 'error'
                  : espera.waitType === 'IO'
                    ? 'warn'
                    : espera.waitType === 'CPU'
                      ? 'accent'
                      : undefined,
            }))}
            emptyMessage="No waits recorded: either there is no activity, or sampling has not started yet."
          />

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Moments worth looking at</span>
            </div>
            <div className="panel-body">
              {/* Se ofrecen en vez de pedir una hora a ciegas: quien abre esto
                  after an incident does not always know the exact hour, but does
                  reconoce el momento cuando lo ve descrito. */}
              {momentos.length === 0 ? (
                <div className="empty">
                  Nada llamativo en la window. Sólo se guardan las sessions que esperan un bloqueo, las que llevan más
                  de un segundo corriendo y las transactions de más de un minuto; si no hubo ninguna, esto queda vacío
                  y es una buena noticia.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Momento</th>
                      <th className="text-right">Sessions</th>
                      <th className="text-right">Bloqueadas</th>
                      <th className="text-right">Longest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {momentos.map((entrada) => (
                      <tr key={entrada.ts.toISOString()}>
                        <td>
                          <Link href={enlace({ t: entrada.ts.toISOString() })} className="link">
                            {entrada.ts.toLocaleString('en')}
                          </Link>
                        </td>
                        <td className="num">{entrada.sessions}</td>
                        <td className="num">
                          {entrada.blocked > 0 ? (
                            <span className="tag tag--error">{entrada.blocked}</span>
                          ) : (
                            '·'
                          )}
                        </td>
                        <td className="num">{duracion(entrada.longestMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">
              What was running {foto.at ? `· ${foto.at.toLocaleString('en')}` : ''}
            </span>
            {t && (
              <Link href={enlace({ t: new Date().toISOString() })} className="tag tag--muted">
                volver a ahora
              </Link>
            )}
          </div>
          <div className="panel-body">
            {foto.sessions.length === 0 ? (
              <div className="empty">
                No session snapshot near that instant. Detail is kept only when there is
                something to reconstruct — a lock, a query over one second, a long transaction — so a
                quiet server leaves no trail here on purpose.
              </div>
            ) : (
              <div className="table-scroll" style={{ maxHeight: '30rem' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>State</th>
                      <th>Waiting</th>
                      <th>Application</th>
                      <th>Role</th>
                      <th className="text-right">Query</th>
                      <th className="text-right">Transaction</th>
                      <th>Query</th>
                    </tr>
                  </thead>
                  <tbody>
                    {foto.sessions.map((sesion) => (
                      <tr key={sesion.pid}>
                        <td className="font-mono text-[11px]">{sesion.pid}</td>
                        <td className="text-[11px]">{sesion.state}</td>
                        <td className="text-[11px]">
                          {sesion.waitType ? (
                            <span
                              className={`tag ${sesion.waitType === 'Lock' ? 'tag--error' : 'tag--muted'}`}
                            >
                              {sesion.waitType}
                              {sesion.waitEvent ? ` · ${sesion.waitEvent}` : ''}
                            </span>
                          ) : (
                            <span className="text-foreground-muted">CPU</span>
                          )}
                          {sesion.blockedBy ? (
                            <span className="ml-1 font-mono text-[10px] text-foreground-muted">
                              por {sesion.blockedBy}
                            </span>
                          ) : null}
                        </td>
                        <td className="font-mono text-[11px]">{sesion.application}</td>
                        <td className="font-mono text-[11px]">{sesion.username}</td>
                        <td className="num">{duracion(sesion.queryMs)}</td>
                        <td className="num">{duracion(sesion.xactMs)}</td>
                        <td className="max-w-[28rem] truncate font-mono text-[10px] text-foreground-muted">
                          {sesion.query ?? '·'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[11px] text-foreground-muted">
              El texto de cada consulta está cortado a 900 caracteres: guardar consultas enteras cada diez segundos
              llenaría el store, y para reconocer qué corría alcanza con el principio. La columna «por» dice qué PID
              tenía el bloqueo, que es por dónde empieza cualquier investigación de contención.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
