import { notFound, redirect } from 'next/navigation';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance, getSeries } from '@/lib/queries';
import { MeasureBloat } from '@/components/MeasureBloat';
import { PollWhilePending } from '@/components/PollWhilePending';
import { currentSession } from '@/lib/session';
import {
  getLatestBloat,
  getPgstattupleState,
  hasPending,
  requestBloat,
  type BloatMode,
} from '@/lib/bloat';
import {
  getVacuumProgress,
  getVacuumTables,
  getVacuumTotals,
  type VacuumOrder,
  type VacuumProgressRow,
  type VacuumTableRow,
} from '@/lib/vacuum';

export const dynamic = 'force-dynamic';

const ORDERS: { key: VacuumOrder; label: string }[] = [
  { key: 'muertas', label: 'Most dead tuples' },
  { key: 'bloat', label: 'Most wasted space' },
  { key: 'antiguedad', label: 'Longest since vacuum' },
  { key: 'tamano', label: 'Largest' },
  { key: 'wraparound', label: 'Closest to wraparound' },
];

/**
 * Las fases del vacuum, en castellano.
 *
 * El nombre crudo de PostgreSQL no dice nada a quien no lo conoce, y la fase es
 * justamente lo que explica por qué un vacuum lleva dos horas: si está en
 * `vacuuming indexes` el problema son los indexs, no la tabla.
 */
const PHASE_LABEL: Record<string, string> = {
  initializing: 'arrancando',
  'scanning heap': 'recorriendo la tabla',
  'vacuuming indexes': 'cleaning indexes',
  'vacuuming heap': 'cleaning the table',
  'cleaning up indexes': 'closing indexes',
  'truncating heap': 'returning space to disk',
  'performing final cleanup': 'cierre final',
  'acquiring sample rows': 'taking a sample',
  'computing statistics': 'computing statistics',
  'finalizing analyze': 'cerrando analyze',
};

function ProgressCard({ entry }: { entry: VacuumProgressRow }) {
  const pct = entry.progressPct;
  const target = `${entry.schema ?? '?'}.${entry.table ?? '?'}`;
  const memory =
    entry.deadTupleBytes !== null && entry.maxDeadTupleBytes
      ? `${formatBytes(entry.deadTupleBytes)} de ${formatBytes(entry.maxDeadTupleBytes)} de memoria de trabajo`
      : null;

  return (
    <div className="vacuum-run">
      <div className="vacuum-run__head">
        <span className={`tag ${entry.kind === 'vacuum' ? 'tag--info' : 'tag--muted'}`}>
          {entry.kind === 'vacuum' ? 'VACUUM' : 'ANALYZE'}
        </span>
        <span className="font-mono text-[12px] font-semibold">{target}</span>
        <span className="text-[11.5px] text-foreground-secondary">
          {PHASE_LABEL[entry.phase ?? ''] ?? entry.phase ?? 'fase desconocida'}
        </span>
        <span className="font-mono text-[10px] text-foreground-muted">
          pid {entry.pid}
          {entry.startedAt ? ` · desde ${formatAgo(entry.startedAt)}` : ''}
        </span>
      </div>

      {pct !== null ? (
        <div className="vacuum-bar">
          <div className="vacuum-bar__fill" style={{ width: `${Math.max(pct, 1)}%` }} />
          <span className="vacuum-bar__label font-mono">{pct.toFixed(0)}%</span>
        </div>
      ) : (
        <p className="text-[11px] text-foreground-muted">
          This phase reports no progress: PostgreSQL only measures the table scan.
        </p>
      )}

      <div className="vacuum-run__meta">
        {entry.heapBlksTotal !== null && (
          <span>
            {formatNumber(entry.heapBlksScanned ?? 0)} de {formatNumber(entry.heapBlksTotal)} bloques recorridos
          </span>
        )}
        {entry.indexVacuumCount !== null && entry.indexVacuumCount > 0 && (
          <span>
            {formatNumber(entry.indexVacuumCount)} pasada{entry.indexVacuumCount === 1 ? '' : 's'} por los indexs
          </span>
        )}
        {memory && <span>{memory}</span>}
      </div>
    </div>
  );
}

function lastPass(row: VacuumTableRow): { text: string; tone: string } {
  const last =
    row.lastAutovacuum && row.lastVacuum
      ? row.lastAutovacuum > row.lastVacuum
        ? row.lastAutovacuum
        : row.lastVacuum
      : row.lastAutovacuum ?? row.lastVacuum;

  if (!last) return { text: 'never', tone: 'text-[var(--error)]' };

  const hours = (Date.now() - last.getTime()) / 3_600_000;
  return {
    text: formatAgo(last),
    tone: hours > 168 ? 'text-[var(--error)]' : hours > 24 ? 'text-[var(--warning)]' : 'text-foreground-muted',
  };
}


/**
 * Qué tan cerca está la tabla del vacuum de congelamiento forzado.
 *
 * Se muestra el peor de los dos relojes —transactions y multixact— porque el
 * que llegue primero es el que va a disparar el vacuum, y avanzan por causas
 * distintas: las escrituras mueven uno, las claves foráneas y los locks
 * compartidos mueven el otro.
 */
function freezeCell(row: VacuumTableRow) {
  const xid = row.xidPct ?? 0;
  const mxid = row.mxidPct ?? 0;
  const peor = Math.max(xid, mxid);
  if (row.freezeMaxAge <= 0) return <span className="text-foreground-muted">—</span>;

  const cual = mxid > xid ? 'multixact' : 'transactions';
  const tono = peor >= 90 ? 'text-[var(--error)]' : peor >= 75 ? 'text-[var(--warning)]' : '';
  return (
    <span
      className={tono}
      title={`edad de ${cual}: ${Math.round(mxid > xid ? row.mxidAge : row.xidAge).toLocaleString('es-CR')} sobre ${row.freezeMaxAge.toLocaleString('es-CR')}`}
    >
      {peor.toFixed(0)}%
      {peor >= 60 && <span className="ml-1 text-[10px] text-foreground-muted">{cual}</span>}
    </span>
  );
}

/**
 * Encola una medición con pgstattuple.
 *
 * Sólo admin: la medición exacta lee la tabla completa en la base del cliente.
 * Un viewer puede ver el resultado de lo que otro midió, pero no provocar el
 * escaneo.
 */
async function pedirMedicion(formData: FormData): Promise<void> {
  'use server';

  const session = await currentSession();
  const instanceId = Number(formData.get('instanceId'));
  const schema = String(formData.get('schema') ?? '');
  const table = String(formData.get('table') ?? '');
  const mode = String(formData.get('mode')) as BloatMode;
  const crudo = String(formData.get('estimatedPct') ?? '');
  const estimatedPct = crudo === '' ? null : Number(crudo);

  if (session.role !== 'admin') {
    redirect(`/instances/${instanceId}/vacuum?error=${encodeURIComponent('Measuring bloat requires an administrator role.')}`);
  }
  if (!schema || !table || (mode !== 'exacto' && mode !== 'aproximado')) {
    redirect(`/instances/${instanceId}/vacuum?error=${encodeURIComponent('Incomplete measurement request.')}`);
  }

  await requestBloat(instanceId, schema, table, mode, session.username, estimatedPct);
  redirect(`/instances/${instanceId}/vacuum`);
}

export default async function VacuumPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ orden?: string; error?: string }>;
}) {
  const { id } = await params;
  const { orden, error: aviso } = await searchParams;

  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engineKind = await getInstanceEngine(instanceId);
  if (engineKind && engineKind !== 'postgres') redirect(`/instances/${instanceId}`);

  const order = ORDERS.find((entry) => entry.key === orden)?.key ?? 'muertas';

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
    { label: 'Vacuum' },
  ];

  let tables: VacuumTableRow[];
  let progress: VacuumProgressRow[];
  let totals: Awaited<ReturnType<typeof getVacuumTotals>>;
  let series: Awaited<ReturnType<typeof getSeries>>;
  let medidas: Awaited<ReturnType<typeof getLatestBloat>>;
  let session: Awaited<ReturnType<typeof currentSession>>;
  let pgstattuple: Awaited<ReturnType<typeof getPgstattupleState>>;
  try {
    [tables, progress, totals, series, medidas, session, pgstattuple] = await Promise.all([
      getVacuumTables(instanceId, order, 40),
      getVacuumProgress(instanceId),
      getVacuumTotals(instanceId),
      getSeries(instanceId, ['bloat_estimated_bytes', 'vacuum_running'], 1440, 300),
      getLatestBloat(instanceId),
      currentSession(),
      getPgstattupleState(instanceId),
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

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Vacuum y bloat · {instance.alias}</h1>
            <p className="page-sub">
              Qué tablas están peor, cuándo pasó el autovacuum por última vez y qué está corriendo ahora. El
              espacio desperdiciado es una <strong>estimate</strong> a partir del ancho de las columnas, no una
              medición: sirve para ordenar de peor a mejor, no para facturar bytes.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} />

        {aviso && <div className="notice notice--warn">{aviso}</div>}

        {/* Una medición exacta puede tardar minutos: se refresca solo mientras
            haya alguna en cola, y se deja de molestar cuando terminan. */}
        {hasPending(medidas.values()) && <PollWhilePending intervalMs={3000} />}

        {totals.tables === 0 && (
          <div className="notice notice--warn">
            Todavía no hay una foto de vacuum para esta instancia. El colector la toma cada dos minutos.
          </div>
        )}

        <div className="stat-grid">
          <StatCard
            label="Dead tuples"
            value={formatNumber(totals.deadTuples)}
            tone={totals.deadTuples > 1_000_000 ? 'warn' : 'neutral'}
            hint={`across ${formatNumber(totals.tables)} tables`}
          />
          <StatCard
            label="Estimated reclaimable space"
            value={formatBytes(totals.bloatBytes)}
            tone={totals.bloatBytes > 1024 ** 3 ? 'warn' : 'neutral'}
            hint="estimate, heap only"
          />
          <StatCard
            label="Pasadas pendientes"
            value={formatNumber(totals.overdue)}
            tone={totals.overdue > 0 ? 'warn' : 'ok'}
            hint="tables over their threshold"
          />
          <StatCard
            label="Running now"
            value={formatNumber(progress.length)}
            tone={progress.length > 0 ? 'accent' : 'neutral'}
            hint={progress.length > 0 ? 'vacuum o analyze activo' : 'nothing in progress'}
          />
          <StatCard
            label="No ANALYZE"
            value={formatNumber(totals.missingAnalyze)}
            tone={totals.missingAnalyze > 0 ? 'warn' : 'ok'}
            hint="cannot estimate or plan well"
          />
          <StatCard
            label="Worst table for wraparound"
            value={totals.worstXidPct === null ? '—' : `${totals.worstXidPct.toFixed(0)}%`}
            tone={
              (totals.worstXidPct ?? 0) >= 90
                ? 'error'
                : (totals.worstXidPct ?? 0) >= 75
                  ? 'warn'
                  : 'ok'
            }
            hint="of the limit that forces freezing"
          />
          <StatCard
            label="Autovacuum apagado"
            value={formatNumber(totals.autovacuumDisabled)}
            tone={totals.autovacuumDisabled > 0 ? 'error' : 'ok'}
            hint="tables with the option set to false"
          />
        </div>

        {totals.missingAnalyze > 0 && (
          <div className="notice">
            <strong>
              {formatNumber(totals.missingAnalyze)} tabla{totals.missingAnalyze === 1 ? '' : 's'} sin estadísticas.
            </strong>{' '}
            Without ANALYZE, the planner estimates blind and the wasted-space estimate cannot
            calcular. Es la misma causa de los planes con desvíos grandes que aparecen en Consultas.
          </div>
        )}

        {progress.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">En curso</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                fase y avance sobre el recorrido de la tabla
              </span>
            </div>
            <div className="vacuum-runs">
              {progress.map((entry) => (
                <ProgressCard key={`${entry.kind}:${entry.pid}`} entry={entry} />
              ))}
            </div>
          </section>
        )}

        <TimeseriesPanel
          title="Estimated wasted space"
          hint="window 24 h"
          data={series}
          unit="bytes"
          height={150}
          series={[{ metric: 'bloat_estimated_bytes', label: 'Estimated bloat', color: '#9a4a00' }]}
        />

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Ordenar por</span>
          {ORDERS.map((entry) => (
            <a
              key={entry.key}
              href={`/instances/${instanceId}/vacuum?orden=${entry.key}`}
              className={`tag ${entry.key === order ? 'tag--info' : 'tag--muted'}`}
            >
              {entry.label}
            </a>
          ))}
        </div>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Tables · {tables.length}</span>
            <span className="font-mono text-[10px] text-foreground-muted">
              {totals.capturedAt ? `foto de ${formatAgo(totals.capturedAt)}` : 'sin foto'}
            </span>
          </div>

          {tables.length === 0 ? (
            <div className="empty">No vacuum data yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tabla</th>
                    <th className="text-right">Dead</th>
                    <th className="text-right">% dead</th>
                    <th className="text-right">Faltan p/ disparar</th>
                    <th className="text-right">Last vacuum</th>
                    <th className="text-right">Last analyze</th>
                    <th className="text-right">Size</th>
                    <th className="text-right">Desperdicio estimado</th>
                    <th className="text-right">Medido</th>
                    <th className="text-right">Congelamiento</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map((row) => {
                    const last = lastPass(row);
                    const analyze = row.lastAutoanalyze ?? row.lastAnalyze;
                    return (
                      <tr key={`${row.schema}.${row.table}`}>
                        <td className="font-mono text-[11.5px]">
                          <span className="text-foreground-muted">{row.schema}.</span>
                          {row.table}
                          {!row.autovacuumEnabled && (
                            <span className="tag tag--error ml-1.5">autovacuum apagado</span>
                          )}
                        </td>
                        <td className="num">{formatNumber(row.deadTuples)}</td>
                        <td className="num">
                          <span
                            className={
                              (row.deadPct ?? 0) >= 50
                                ? 'text-[var(--error)]'
                                : (row.deadPct ?? 0) >= 20
                                  ? 'text-[var(--warning)]'
                                  : ''
                            }
                          >
                            {row.deadPct === null ? '—' : `${row.deadPct.toFixed(1)}%`}
                          </span>
                        </td>
                        <td className="num">
                          {row.remaining === null ? (
                            '—'
                          ) : row.remaining < 0 ? (
                            // Umbral superado: el autovacuum ya debería estar ahí. Si no
                            // está, o hay cola o hay un trabajador ocupado en otra tabla.
                            <span className="text-[var(--warning)]">already exceeded</span>
                          ) : (
                            formatNumber(row.remaining)
                          )}
                        </td>
                        <td className={`num font-mono text-[11px] ${last.tone}`}>{last.text}</td>
                        <td className="num font-mono text-[11px] text-foreground-muted">
                          {analyze ? formatAgo(analyze) : 'never'}
                        </td>
                        <td className="num">{formatBytes(row.sizeBytes)}</td>
                        <td className="num">
                          {row.bloatBytes === null ? (
                            <span className="text-[11px] text-foreground-muted" title={row.bloatNote ?? ''}>
                              no estimable
                            </span>
                          ) : (
                            <>
                              {formatBytes(row.bloatBytes)}
                              {row.bloatPct !== null && (
                                <span className="ml-1 text-[10px] text-foreground-muted">
                                  {row.bloatPct.toFixed(0)}% del heap
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="num">
                          <MeasureBloat
                            action={pedirMedicion}
                            instanceId={instanceId}
                            schema={row.schema}
                            table={row.table}
                            sizeBytes={row.sizeBytes}
                            estimatedPct={row.bloatPct}
                            measurement={medidas.get(`${row.schema}.${row.table}`) ?? null}
                            canMeasure={session.role === 'admin' && pgstattuple.executable}
                            blockedReason={
                              session.role !== 'admin'
                                ? 'Measuring bloat requires an administrator role.'
                                : pgstattuple.reason
                            }
                          />
                        </td>
                        <td className="num">{freezeCell(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {totals.unestimated > 0 && (
          <p className="text-[11px] text-foreground-muted">
            {formatNumber(totals.unestimated)} tabla{totals.unestimated === 1 ? '' : 's'} sin estimate de
            desperdicio. Las causas están en la columna: falta un ANALYZE, la tabla está vacía, o sus filas son
            más anchas que una página y viven en TOAST, donde esta cuenta no aplica. Para una medición exacta hace
            falta la extensión <span className="font-mono">pgstattuple</span>, que lee la tabla completa y por eso
            Búho no la corre solo.
          </p>
        )}
      </div>
    </>
  );
}
