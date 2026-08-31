import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PollWhilePending } from '@/components/PollWhilePending';
import { InstanceTabs } from '@/components/InstanceTabs';
import { PlanTree } from '@/components/PlanTree';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { getInstance } from '@/lib/queries';
import { currentSession } from '@/lib/session';
import { statementKind } from '@buho/core';
import {
  getLatestPlan,
  getPlanHistory,
  getPlanRequest,
  getStatementSummary,
  getStatementText,
  isParameterized,
  requestPlan,
  supportsGenericPlan,
  MODE_HINT,
  MODE_LABEL,
  type PlanMode,
  type PlanRequest,
} from '@/lib/plans';

export const dynamic = 'force-dynamic';

const SEVERITY_LABEL = {
  critica: 'Crítica',
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
} as const;

function findingClass(severity: keyof typeof SEVERITY_LABEL): string {
  if (severity === 'critica' || severity === 'alta') return 'finding finding--critical';
  if (severity === 'media') return 'finding finding--warning';
  return 'finding finding--info';
}

/**
 * Pide un plan y deja el identificador del encargo en la URL.
 *
 * Va en la URL y no en estado de sesión para que la pantalla se pueda recargar,
 * compartir y volver a abrir mostrando el mismo plan.
 */
async function explain(formData: FormData) {
  'use server';

  const session = await currentSession();
  const instanceId = Number(formData.get('instanceId'));
  const queryid = String(formData.get('queryid'));
  const sql = String(formData.get('sql') ?? '');
  const mode = String(formData.get('mode')) as PlanMode;

  const back = (message: string) =>
    redirect(`/instances/${instanceId}/queries/${queryid}?error=${encodeURIComponent(message)}`);

  // Un viewer puede pedir un plan pero no ejecutar la consulta. La diferencia no
  // es de confianza: EXPLAIN sin ANALYZE no toca los datos, y con ANALYZE corre
  // la consulta de verdad contra la base del cliente.
  if (mode === 'analyze' && session.role !== 'admin') {
    back('Ejecutar la consulta con ANALYZE requiere rol de administrador.');
  }

  // Las mismas reglas que deciden qué botones se dibujan, comprobadas acá: la
  // interfaz puede quedar desfasada tras un cambio de texto, y encolar un
  // encargo imposible sólo produce un error en pantalla un segundo después.
  const kind = statementKind(sql);
  if (kind === 'utilitaria') {
    back('PostgreSQL no puede explicar sentencias utilitarias como ALTER TABLE, VACUUM o SET.');
  }
  if (kind === 'escritura' && mode === 'analyze') {
    back('No se ejecuta con ANALYZE una sentencia que escribe. El plan estimado muestra la misma estructura.');
  }

  const requestId = await requestPlan(instanceId, sql, mode, session.username, queryid);
  redirect(`/instances/${instanceId}/queries/${queryid}?plan=${requestId}`);
}

export default async function QueryPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; queryid: string }>;
  searchParams: Promise<{ plan?: string; error?: string; texto?: string }>;
}) {
  const { id, queryid } = await params;
  const { plan: planParam, error, texto } = await searchParams;
  const instanceId = Number(id);
  if (!Number.isFinite(instanceId)) notFound();

  const session = await currentSession();

  let instance: Awaited<ReturnType<typeof getInstance>>;
  let statement: Awaited<ReturnType<typeof getStatementText>>;
  let summary: Awaited<ReturnType<typeof getStatementSummary>>;
  let request: PlanRequest | null;
  let history: PlanRequest[];
  let generic: boolean;

  try {
    [instance, statement, summary, generic] = await Promise.all([
      getInstance(instanceId),
      getStatementText(instanceId, queryid),
      getStatementSummary(instanceId, queryid),
      supportsGenericPlan(instanceId),
    ]);
    request = planParam
      ? await getPlanRequest(Number(planParam))
      : await getLatestPlan(instanceId, queryid);
    history = await getPlanHistory(instanceId, queryid);
  } catch (storeError) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: 'Consulta' }]} />
        <div className="page">
          <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />
        </div>
      </>
    );
  }

  if (!instance) notFound();
  if (instance.engine !== 'postgres') redirect(`/instances/${instanceId}`);
  if (!statement) notFound();

  const parameterized = isParameterized(statement.query);
  const waiting = request?.state === 'pendiente' || request?.state === 'corriendo';
  const analyzed = request?.mode === 'analyze';

  // Qué modos tienen sentido para *esta* sentencia. Un botón que no puede
  // funcionar es peor que ningún botón: se aprieta, falla, y el error habla de
  // otra cosa.
  //
  // - Texto cortado a 4000 caracteres: no es una sentencia válida.
  // - Utilitaria (ALTER, VACUUM, SET…): PostgreSQL no la puede explicar.
  // - Normalizada con $1: sólo el plan genérico, que no necesita valores.
  // - Escritura: se planifica, pero ejecutarla escribiría.
  const kind = statementKind(statement.query);
  const modes: PlanMode[] = statement.truncated
    ? []
    : kind === 'utilitaria'
      ? []
      : parameterized
        ? generic
          ? ['generic']
          : []
        : kind === 'lectura'
          ? ['estimate', 'analyze']
          : ['estimate'];

  return (
    <>
      <Topbar
        crumbs={[
          { label: 'Flota', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Consultas', href: `/instances/${instanceId}/queries` },
          { label: queryid },
        ]}
      />
      {/* Mientras el colector no haya contestado, la pantalla se refresca sola:
          quien pidió el plan no debería tener que apretar recargar. */}
      {waiting ? <PollWhilePending /> : null}

      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Plan de ejecución</h1>
            <p className="page-sub">
              Consulta <span className="font-mono">{queryid}</span>
              {statement.database ? ` · base ${statement.database}` : ''}
              {statement.username ? ` · rol ${statement.username}` : ''}
            </p>
          </div>
          <Link href={`/instances/${instanceId}/queries`} className="btn">
            Volver a consultas
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine={instance.engine} />

        {summary ? (
          <div className="stat-grid">
            <StatCard label="Llamadas" value={formatNumber(summary.calls)} hint="en la ventana retenida" />
            <StatCard
              label="Tiempo total"
              value={formatDuration(summary.execMs / 1000)}
              hint="suma de todas las ejecuciones"
            />
            <StatCard
              label="Media por llamada"
              value={`${summary.meanMs.toFixed(summary.meanMs < 10 ? 2 : 0)} ms`}
              tone={summary.meanMs > 1_000 ? 'warn' : 'neutral'}
            />
            <StatCard label="Filas devueltas" value={formatNumber(summary.rows)} />
            <StatCard
              label="Temporales escritos"
              value={formatBytes(summary.tempWritten)}
              tone={summary.tempWritten > 0 ? 'warn' : 'ok'}
              hint={summary.tempWritten > 0 ? 'derrames a disco' : 'todo en memoria'}
            />
            <StatCard
              label="Bloques leídos de disco"
              value={formatNumber(summary.sharedRead)}
              hint={`${formatNumber(summary.sharedHit)} desde caché`}
            />
          </div>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Texto de la consulta</span>
            <span className="text-[11px] text-foreground-muted">
              {[
                statement.truncated
                  ? 'cortada a 4000 caracteres'
                  : parameterized
                    ? 'normalizada por pg_stat_statements'
                    : 'con valores concretos',
                kind === 'utilitaria' ? 'sentencia utilitaria' : kind === 'escritura' ? 'escribe' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <pre className="max-h-[18rem] overflow-auto whitespace-pre-wrap border-t border-border bg-surface-muted p-3 font-mono text-[11.5px] leading-relaxed">
            {statement.query}
          </pre>
        </section>

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">{modes.length > 0 ? 'Explicar' : 'No se puede explicar'}</span>
            {request ? (
              <span className="text-[11px] text-foreground-muted">
                {MODE_LABEL[request.mode]} · pedido por {request.requestedBy} {formatAgo(request.requestedAt)}
              </span>
            ) : null}
          </div>
          <div className="panel-body flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {modes.map((mode) => (
                <form key={mode} action={explain}>
                  <input type="hidden" name="instanceId" value={instanceId} />
                  <input type="hidden" name="queryid" value={queryid} />
                  <input type="hidden" name="sql" value={statement.query} />
                  <input type="hidden" name="mode" value={mode} />
                  <button
                    type="submit"
                    className={`btn ${mode === 'analyze' ? '' : 'btn--primary'}`}
                    disabled={mode === 'analyze' && session.role !== 'admin'}
                    title={MODE_HINT[mode]}
                  >
                    {MODE_LABEL[mode]}
                  </button>
                </form>
              ))}
              {waiting ? (
                <span className="tag tag--info">
                  {request?.state === 'corriendo' ? 'ejecutando…' : 'en cola…'}
                </span>
              ) : null}
            </div>

            {error ? <p className="text-[12px] text-error">{decodeURIComponent(error)}</p> : null}

            {statement.truncated ? (
              <p className="text-[12px] text-warning">
                Búho guarda hasta 4000 caracteres del texto de cada consulta, y esta llegaba más lejos. No se
                puede explicar un fragmento: al planificador le falta el final de la sentencia. Para verla, hay
                que tomar el texto completo de{' '}
                <span className="font-mono">pg_stat_statements</span> en la instancia y explicarla a mano.
              </p>
            ) : kind === 'utilitaria' ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-[12px] text-warning">
                  PostgreSQL no puede explicar esta sentencia. No es una limitación de Búho ni un problema de
                  permisos: la gramática de <span className="font-mono">EXPLAIN</span> sólo acepta sentencias que
                  tienen plan —SELECT, INSERT, UPDATE, DELETE, MERGE, VALUES, EXECUTE, DECLARE y CREATE TABLE AS—.
                  Un <span className="font-mono">EXPLAIN ALTER TABLE</span> es un error de sintaxis, y{' '}
                  <span className="font-mono">REFRESH MATERIALIZED VIEW</span> contesta que las sentencias
                  utilitarias no tienen estructura de plan.
                </p>
                <p className="text-[11.5px] text-foreground-muted">
                  Aparece igual en el listado porque <span className="font-mono">pg_stat_statements</span> la
                  registra como cualquier otra. Cuando una sentencia así sale entre las más costosas, el hallazgo
                  no está en su plan sino en el número de llamadas: DDL idempotente que se repite en cada ciclo,
                  un <span className="font-mono">SET</span> por conexión, o un{' '}
                  <span className="font-mono">VACUUM</span> manual más seguido de lo necesario.
                </p>
              </div>
            ) : parameterized && !generic ? (
              <p className="text-[12px] text-warning">
                El texto viene normalizado con <span className="font-mono">$1</span> y esta instancia es anterior a
                PostgreSQL 16, así que no soporta <span className="font-mono">EXPLAIN (GENERIC_PLAN)</span>. Hay que
                explicarla a mano reemplazando los parámetros por valores reales.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {/* Sólo se describe lo que se ofrece: juntar las explicaciones de
                    los tres modos hacía un párrafo que se contradecía. */}
                {modes.map((mode) => (
                  <p key={mode} className="text-[11.5px] text-foreground-muted">
                    <span className="font-semibold text-foreground-secondary">{MODE_LABEL[mode]}.</span>{' '}
                    {MODE_HINT[mode]}
                  </p>
                ))}
                {kind === 'escritura' ? (
                  <p className="text-[11.5px] text-warning">
                    Esta sentencia escribe, así que no se ofrece ejecutarla con{' '}
                    <span className="font-mono">ANALYZE</span>. El plan estimado muestra la misma estructura sin
                    tocar los datos. Revertir la transacción alcanzaría para las filas, pero no para lo que un
                    INSERT deja detrás: valores de secuencia consumidos, disparadores con efectos externos, WAL y
                    bloqueos sobre una base de producción.
                  </p>
                ) : null}
              </div>
            )}

            {/* Sólo tiene sentido explicar la espera cuando hay algo que pedir. */}
            {modes.length > 0 ? (
              <p className="text-[11.5px] text-foreground-muted">
                El EXPLAIN lo corre el colector, no esta consola: es el único proceso con credenciales de las
                instancias monitoreadas. Por eso el plan tarda un segundo en aparecer.
              </p>
            ) : null}
          </div>
        </section>

        {/* El encargo guarda el SQL con el que se explicó. Si el texto actual ya
            no es ése —pg_stat_statements reasignó el identificador, o el texto
            se recortó— mostrar sólo el de arriba haría creer que el plan
            corresponde a una consulta que no es. */}
        {request && request.sql !== statement.query ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Texto con el que se explicó</span>
              <span className="tag tag--warn">distinto del actual</span>
            </div>
            <pre className="max-h-[14rem] overflow-auto whitespace-pre-wrap border-t border-border bg-surface-muted p-3 font-mono text-[11.5px] leading-relaxed">
              {request.sql}
            </pre>
          </section>
        ) : null}

        {request?.state === 'error' ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">No se pudo explicar</span>
              <span className="tag tag--error">error</span>
            </div>
            <div className="panel-body">
              <p className="font-mono text-[11.5px] text-error">{request.error}</p>
              {/* La causa se deduce del error en vez de listar las tres siempre:
                  un catálogo de causas posibles obliga a descartarlas a mano. */}
              <p className="mt-2 text-[11.5px] text-foreground-muted">
                {/does not exist|no existe/i.test(request.error ?? '')
                  ? 'La sentencia nombra un objeto que ya no está o que el colector no ve. Pasa con tablas de staging o temporales creadas por la aplicación, y con nombres sin esquema: el colector se conecta con su propio search_path.'
                  : /permission denied|permiso denegado/i.test(request.error ?? '')
                    ? 'Al rol de monitoreo le falta permiso de lectura sobre alguno de los objetos. Planificar requiere leer las estadísticas de cada tabla involucrada.'
                    : /syntax error/i.test(request.error ?? '')
                      ? 'El texto no es una sentencia completa que PostgreSQL pueda planificar. Suele ser un texto recortado, o una sentencia utilitaria que EXPLAIN no acepta.'
                      : 'El error viene de la instancia tal cual lo devolvió, sin interpretación de Búho.'}
              </p>
            </div>
          </section>
        ) : null}

        {request?.state === 'listo' && request.plan ? (
          <>
            <div className="stat-grid">
              <StatCard
                label="Modo"
                value={analyzed ? 'ANALYZE' : request.mode === 'generic' ? 'Genérico' : 'Estimado'}
                hint={analyzed ? 'filas y tiempos reales' : 'sin ejecutar la consulta'}
              />
              <StatCard label="Costo total" value={formatNumber(request.totalCost ?? 0)} hint="unidades del planificador" />
              <StatCard
                label="Planificación"
                value={request.planningMs === null ? '—' : `${request.planningMs.toFixed(2)} ms`}
              />
              <StatCard
                label="Ejecución"
                value={request.executionMs === null ? '—' : `${request.executionMs.toFixed(1)} ms`}
                hint={request.executionMs === null ? 'no se ejecutó' : undefined}
              />
              <StatCard
                label="Hallazgos"
                value={String(request.findings.length)}
                tone={
                  request.findings.some((finding) => finding.severity === 'critica' || finding.severity === 'alta')
                    ? 'error'
                    : request.findings.length > 0
                      ? 'warn'
                      : 'ok'
                }
              />
            </div>

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Dónde está el problema</span>
                <span className="text-[11px] text-foreground-muted">
                  {request.findings.length === 0 ? 'sin patrones conocidos' : 'de mayor a menor severidad'}
                </span>
              </div>
              {request.findings.length === 0 ? (
                <div className="empty">
                  Ningún patrón problemático conocido en este plan.
                  {!analyzed
                    ? ' Varias comprobaciones —filas reales contra estimadas, derrames a disco, vueltas de un Nested Loop— sólo se pueden hacer ejecutando la consulta con ANALYZE.'
                    : ''}
                </div>
              ) : (
                <div>
                  {request.findings.map((finding, index) => (
                    <article key={`${finding.nodeId}-${index}`} className={findingClass(finding.severity)}>
                      <div>
                        <span
                          className={`tag ${
                            finding.severity === 'critica' || finding.severity === 'alta'
                              ? 'tag--error'
                              : finding.severity === 'media'
                                ? 'tag--warn'
                                : 'tag--muted'
                          }`}
                        >
                          {SEVERITY_LABEL[finding.severity]}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="finding__title">{finding.title}</span>
                          {/* Ancla al nodo del árbol: el punto del plan donde
                              está el problema, que es lo que cuesta encontrar. */}
                          <a href={`#nodo-${finding.nodeId}`} className="finding__object hover:underline">
                            {finding.path}
                          </a>
                        </div>
                        <p className="finding__message">{finding.detail}</p>
                        <p className="finding__remediation">{finding.remediation}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {Object.entries(finding.evidence).map(([key, value]) => (
                            <span key={key} className="tag tag--muted">
                              {key.replace(/_/g, ' ')}: {String(value)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Árbol del plan</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-foreground-muted">
                    la barra de fondo es la proporción del {analyzed ? 'tiempo' : 'costo'}
                  </span>
                  <Link
                    href={`/instances/${instanceId}/queries/${queryid}?plan=${request.requestId}&texto=${texto ? '' : '1'}`}
                    className="btn"
                  >
                    {texto ? 'Ver árbol' : 'Ver texto'}
                  </Link>
                </div>
              </div>
              {texto ? (
                <pre className="overflow-auto whitespace-pre border-t border-border bg-surface-muted p-3 font-mono text-[11px] leading-relaxed">
                  {request.planText}
                </pre>
              ) : (
                <PlanTree root={request.plan} findings={request.findings} analyzed={analyzed} />
              )}
            </section>
          </>
        ) : null}

        {history.length > 1 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Planes anteriores</span>
              <span className="text-[11px] text-foreground-muted">
                sirve para ver si a la consulta le cambió el plan
              </span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Modo</th>
                  <th>Pedido por</th>
                  <th>Estado</th>
                  <th className="text-right">Costo</th>
                  <th className="text-right">Ejecución</th>
                  <th className="text-right">Hallazgos</th>
                  <th>Nodo raíz</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.requestId}>
                    <td>
                      <Link
                        href={`/instances/${instanceId}/queries/${queryid}?plan=${entry.requestId}`}
                        className="text-accent hover:underline"
                      >
                        {formatAgo(entry.requestedAt)}
                      </Link>
                    </td>
                    <td className="text-[11.5px]">{MODE_LABEL[entry.mode]}</td>
                    <td className="font-mono text-[11px]">{entry.requestedBy}</td>
                    <td>
                      <span
                        className={`tag ${
                          entry.state === 'listo'
                            ? 'tag--ok'
                            : entry.state === 'error'
                              ? 'tag--error'
                              : 'tag--info'
                        }`}
                      >
                        {entry.state}
                      </span>
                    </td>
                    <td className="num">{entry.totalCost === null ? '—' : formatNumber(entry.totalCost)}</td>
                    <td className="num">
                      {entry.executionMs === null ? '—' : `${entry.executionMs.toFixed(1)} ms`}
                    </td>
                    <td className="num">{entry.findings.length || '·'}</td>
                    <td className="font-mono text-[11px] text-foreground-secondary">
                      {entry.plan?.label ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </>
  );
}
