import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AutoRefresh } from '@/components/AutoRefresh';
import { InstanceTabs } from '@/components/InstanceTabs';
import { LabeledBars } from '@/components/LabeledBars';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { WaitStack } from '@/components/WaitStack';
import { formatNumber, formatPct } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import {
  getInterestingMoments,
  getSessionsAt,
  getWaitShares,
  getWaitTimeline,
  WAIT_TYPE_HELP,
} from '@/lib/sessions';

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

  // El desglose por wait_event es de PostgreSQL. En los otros motores se vuelve
  // al resumen en vez de mostrar una pantalla que nunca tendrá datos.
  const motor = await getInstanceEngine(instanceId);
  if (motor && motor !== 'postgres') redirect(`/instances/${instanceId}`);

  const window = WINDOWS.find((entrada) => entrada.key === v) ?? WINDOWS[1]!;
  const momento = t ? new Date(t) : new Date();

  let instancia;
  let esperas;
  let serie;
  let foto;
  let momentos;
  try {
    instancia = await getInstance(instanceId);
    [esperas, serie, foto, momentos] = await Promise.all([
      getWaitShares(instanceId, window.minutes),
      getWaitTimeline(instanceId, window.minutes),
      getSessionsAt(instanceId, Number.isFinite(momento.getTime()) ? momento : new Date()),
      getInterestingMoments(instanceId, window.minutes),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Sesiones' }]} />
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
          { label: 'Flota', href: '/' },
          { label: instancia.alias, href: `/instances/${instanceId}` },
          { label: 'Sesiones' },
        ]}
      />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Sesiones y esperas · {instancia.alias}</h1>
            <p className="page-sub">
              En qué se va el tiempo del servidor —CPU, disco, bloqueos, red— y qué estaba corriendo en un momento
              concreto. Sale de una foto de <span className="font-mono">pg_stat_activity</span> cada diez segundos, así
              que es <strong>muestreo</strong>: mide bien lo que dura y se pierde lo instantáneo.
            </p>
          </div>
          <AutoRefresh intervalMs={30000} />
        </header>

        <InstanceTabs instanceId={instanceId} />

        <div className="stat-grid">
          <StatCard
            label="Sesiones ocupadas"
            value={esperas.averageBusy.toFixed(1)}
            hint="promedio a la vez en la ventana"
            tone="accent"
          />
          <StatCard
            label="Trabajando (CPU)"
            value={cpu ? formatPct(cpu.share * 100, 0) : '·'}
            hint="del tiempo de sesión, sin esperar nada"
          />
          <StatCard
            label="Esperando bloqueos"
            value={formatPct(bloqueos * 100, 0)}
            hint="esto no se arregla con hardware"
            tone={bloqueos > 0.15 ? 'error' : bloqueos > 0.05 ? 'warn' : 'neutral'}
          />
          <StatCard
            label="Esperando disco"
            value={formatPct(disco * 100, 0)}
            hint="falta caché o el almacenamiento no da más"
            tone={disco > 0.4 ? 'warn' : 'neutral'}
          />
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Perfil de espera en el tiempo</span>
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
              emptyMessage="Todavía no hay fotos de sesiones en esta ventana. El muestreo escribe cada diez segundos; si la instancia acaba de agregarse, esperá un minuto."
            />
            <p className="mt-2 text-[11px] text-foreground-muted">
              La altura son <strong>sesiones a la vez</strong>, no esperas sumadas: así se puede comparar contra el
              número de núcleos del servidor. Si la barra verde supera los núcleos, el cuello es CPU; si crece la roja,
              son transacciones que se pisan y no hay hardware que lo arregle.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
          <LabeledBars
            title="En qué se espera"
            footer={`${formatNumber(esperas.samples)} fotos`}
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
            emptyMessage="Sin esperas registradas: o no hay actividad, o el muestreo todavía no arrancó."
          />

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Momentos que vale la pena mirar</span>
            </div>
            <div className="panel-body">
              {/* Se ofrecen en vez de pedir una hora a ciegas: quien abre esto
                  después de un incidente no siempre sabe la hora exacta, pero sí
                  reconoce el momento cuando lo ve descrito. */}
              {momentos.length === 0 ? (
                <div className="empty">
                  Nada llamativo en la ventana. Sólo se guardan las sesiones que esperan un bloqueo, las que llevan más
                  de un segundo corriendo y las transacciones de más de un minuto; si no hubo ninguna, esto queda vacío
                  y es una buena noticia.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Momento</th>
                      <th className="text-right">Sesiones</th>
                      <th className="text-right">Bloqueadas</th>
                      <th className="text-right">La más larga</th>
                    </tr>
                  </thead>
                  <tbody>
                    {momentos.map((entrada) => (
                      <tr key={entrada.ts.toISOString()}>
                        <td>
                          <Link href={enlace({ t: entrada.ts.toISOString() })} className="link">
                            {entrada.ts.toLocaleString('es')}
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
              Qué estaba corriendo {foto.at ? `· ${foto.at.toLocaleString('es')}` : ''}
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
                No hay ninguna foto con sesiones guardadas cerca de ese instante. El detalle se guarda sólo cuando hay
                algo que reconstruir —un bloqueo, una consulta de más de un segundo, una transacción larga—, así que un
                servidor tranquilo no deja rastro aquí a propósito.
              </div>
            ) : (
              <div className="table-scroll" style={{ maxHeight: '30rem' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>Estado</th>
                      <th>Esperando</th>
                      <th>Aplicación</th>
                      <th>Rol</th>
                      <th className="text-right">Consulta</th>
                      <th className="text-right">Transacción</th>
                      <th>Consulta</th>
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
