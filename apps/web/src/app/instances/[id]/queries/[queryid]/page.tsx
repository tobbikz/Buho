import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PollWhilePending } from '@/components/PollWhilePending';
import { InstanceTabs } from '@/components/InstanceTabs';
import { PlanFingerprintDiff } from '@/components/PlanFingerprintDiff';
import { QueryLoadTimeline } from '@/components/QueryLoadTimeline';
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
  critica: 'Critical',
  alta: 'High',
  media: 'Medium',
  baja: 'Low',
} as const;

function findingClass(severity: keyof typeof SEVERITY_LABEL): string {
  if (severity === 'critica' || severity === 'alta') return 'finding finding--critical';
  if (severity === 'media') return 'finding finding--warning';
  return 'finding finding--info';
}

const CATALOG_RELATION = /^(pg_|information_schema)/i;
const VERDICT_RANK: Record<string, number> = { critica: 0, alta: 1, media: 2, baja: 3 };

function planVerdict(
  findings: PlanRequest['findings'],
  analyzed: boolean,
  summary: { calls: number; meanMs: number; sharedRead: number } | null,
): { tone: 'ok' | 'warn' | 'error'; title: string; body: string } {
  const ranked = [...findings].sort(
    (a, b) => (VERDICT_RANK[a.severity] ?? 9) - (VERDICT_RANK[b.severity] ?? 9),
  );
  const relations = ranked
    .map((finding) => String(finding.evidence['tabla'] ?? finding.evidence['objeto'] ?? ''))
    .filter((relation) => relation.length > 0);
  const catalogOnly = ranked.length > 0 && relations.every((relation) => CATALOG_RELATION.test(relation));
  const measured = summary
    ? ` Measured in pg_stat_statements: ${formatNumber(summary.calls)} calls, ${summary.meanMs.toFixed(0)} ms mean, ${formatNumber(summary.sharedRead)} blocks read from disk.`
    : '';
  const top = ranked[0];

  if (catalogOnly) {
    const names = [...new Set(relations)].join(', ');
    return {
      tone: 'warn',
      title: 'Catalog scan, not a missing index on your tables',
      body:
        `The cost is inside PostgreSQL catalogs (${names}). information_schema is built from those scans; an index on application data would not remove them. ` +
        (analyzed
          ? 'Row counts come from execution.'
          : 'This plan was not executed, so those row counts are estimates.') +
        measured +
        ' If the totals are large, the fault is how often the statement runs.',
    };
  }
  if (top && (top.severity === 'critica' || top.severity === 'alta')) {
    return {
      tone: 'error',
      title: 'Bad plan',
      body: `${top.title}. ${top.detail}${measured}`,
    };
  }
  if (top && top.severity === 'media') {
    return {
      tone: 'warn',
      title: 'Weak plan',
      body: `${top.title}. ${top.detail}${measured}`,
    };
  }
  if (top) {
    return {
      tone: 'ok',
      title: 'Minor',
      body: `${top.title}. ${top.detail}${measured}`,
    };
  }
  return {
    tone: 'ok',
    title: analyzed ? 'No known fault' : 'No structural fault in the estimate',
    body: analyzed
      ? `Nothing in the executed plan matches a known bad pattern.${measured}`
      : `The estimate has no known bad shape. Real row counts, spills, and loop counts only appear with ANALYZE.${measured}`,
  };
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
    back('Running the query with ANALYZE requires an administrator role.');
  }

  // Las mismas reglas que deciden qué botones se dibujan, comprobadas acá: la
  // interfaz puede quedar desfasada tras un cambio de texto, y encolar un
  // encargo imposible sólo produce un error en pantalla un segundo después.
  const kind = statementKind(sql);
  if (kind === 'utilitaria') {
    back('This statement has no query plan (utility / DDL). EXPLAIN does not apply.');
  }
  if (kind === 'escritura' && mode === 'analyze') {
    back('A writing statement is not run with ANALYZE. The estimated plan shows the same structure.');
  }
  if (mode === 'generic') {
    const target = await getInstance(instanceId);
    if (!target || target.engine !== 'postgres') {
      back('Generic plan is PostgreSQL-only. Use the estimated plan for MariaDB.');
    }
    if (!(await supportsGenericPlan(instanceId))) {
      back('This server is older than PostgreSQL 16, so EXPLAIN (GENERIC_PLAN) is not available.');
    }
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
        <Topbar crumbs={[{ label: 'Fleet', href: '/' }, { label: 'Query' }]} />
        <div className="page">
          <StoreError message={storeError instanceof Error ? storeError.message : String(storeError)} />
        </div>
      </>
    );
  }

  if (!instance) notFound();
  if (instance.engine !== 'postgres' && instance.engine !== 'mariadb') {
    redirect(`/instances/${instanceId}`);
  }
  if (!statement) notFound();

  const parameterized = isParameterized(statement.query);
  const waiting = request?.state === 'pendiente' || request?.state === 'corriendo';
  const analyzed = request?.mode === 'analyze';
  const isMaria = instance.engine === 'mariadb';

  // Qué modos tienen sentido para *esta* sentencia.
  // MariaDB: estimate + analyze (no GENERIC_PLAN). Digests use ? not $1 — treat
  // as concrete enough for EXPLAIN when not truncated.
  const kind = statementKind(statement.query);
  const modes: PlanMode[] = statement.truncated
    ? []
    : kind === 'utilitaria'
      ? []
      : isMaria
        ? kind === 'lectura'
          ? ['estimate', 'analyze']
          : ['estimate']
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
          { label: 'Fleet', href: '/' },
          { label: instance.alias, href: `/instances/${instanceId}` },
          { label: 'Queries', href: `/instances/${instanceId}/queries` },
          { label: queryid },
        ]}
      />
      {/* Mientras el colector no haya contestado, la pantalla se refresca sola:
          quien pidió el plan no debería tener que apretar recargar. */}
      {waiting ? <PollWhilePending /> : null}

      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Execution plan</h1>
            <p className="page-sub">
              Query <span className="font-mono">{queryid}</span>
              {statement.database ? ` · database ${statement.database}` : ''}
              {statement.username ? ` · role ${statement.username}` : ''}
            </p>
          </div>
          <Link href={`/instances/${instanceId}/queries`} className="btn">
            Back to queries
          </Link>
        </header>

        <InstanceTabs instanceId={instanceId} engine={instance.engine} />

        <PlanFingerprintDiff instanceId={instanceId} queryid={queryid} />
        <QueryLoadTimeline instanceId={instanceId} queryid={queryid} />

        {summary ? (
          <div className="stat-grid">
            <StatCard label="Calls" value={formatNumber(summary.calls)} hint="in the retained window" />
            <StatCard
              label="Total time"
              value={formatDuration(summary.execMs / 1000)}
              hint="sum of every execution"
            />
            <StatCard
              label="Mean per call"
              value={`${summary.meanMs.toFixed(summary.meanMs < 10 ? 2 : 0)} ms`}
              tone={summary.meanMs > 1_000 ? 'warn' : 'neutral'}
            />
            <StatCard label="Rows returned" value={formatNumber(summary.rows)} />
            <StatCard
              label="Temp written"
              value={formatBytes(summary.tempWritten)}
              tone={summary.tempWritten > 0 ? 'warn' : 'ok'}
              hint={summary.tempWritten > 0 ? 'disk spills' : 'all in memory'}
            />
            <StatCard
              label="Blocks read from disk"
              value={formatNumber(summary.sharedRead)}
              hint={`${formatNumber(summary.sharedHit)} from cache`}
            />
          </div>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Query text</span>
            <span className="text-[11px] text-foreground-muted">
              {[
                statement.truncated
                  ? 'stored text was cut off'
                  : parameterized
                    ? 'normalized by pg_stat_statements'
                    : 'with concrete values',
                kind === 'utilitaria' ? 'utility statement' : kind === 'escritura' ? 'writes' : null,
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
            <span className="panel-title">{modes.length > 0 ? 'Explain' : 'Cannot explain'}</span>
            {request ? (
              <span className="text-[11px] text-foreground-muted">
                {MODE_LABEL[request.mode]} · requested by {request.requestedBy}{' '}
                {formatAgo(request.requestedAt)}
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
                  {request?.state === 'corriendo' ? 'running…' : 'queued…'}
                </span>
              ) : null}
            </div>

            {error ? <p className="text-[12px] text-error">{decodeURIComponent(error)}</p> : null}

            {statement.truncated ? (
              <p className="text-[12px] text-warning">
                This copy of the statement was stored cut off, so EXPLAIN cannot see the end of it. PostgreSQL
                statements are now kept in full; this row is replaced the next time the collector samples{' '}
                <span className="font-mono">pg_stat_statements</span>.
              </p>
            ) : kind === 'utilitaria' ? (
              <p className="text-[12px] text-foreground-secondary">
                Utility statement — no query plan. EXPLAIN does not apply. High cost usually means high call
                count, not a slow plan.
              </p>
            ) : parameterized && !generic ? (
              <p className="text-[12px] text-warning">
                The text is normalized with <span className="font-mono">$1</span> and this instance is older than
                PostgreSQL 16, so it does not support <span className="font-mono">EXPLAIN (GENERIC_PLAN)</span>.
                Explain it by hand after replacing parameters with real values.
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
                    This statement writes, so running it with <span className="font-mono">ANALYZE</span> is not
                    offered. The estimated plan shows the same structure without touching data. Rolling back the
                    transaction would undo rows, but not what an INSERT leaves behind: consumed sequences,
                    triggers with side effects, WAL, and locks on a production database.
                  </p>
                ) : null}
              </div>
            )}

            {modes.length > 0 ? (
              <p className="text-[11.5px] text-foreground-muted">
                EXPLAIN runs in the collector, not this console — that is the only process with credentials for
                monitored instances. That is why the plan takes a second to appear.
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
              <span className="panel-title">Text that was explained</span>
              <span className="tag tag--warn">different from current</span>
            </div>
            <pre className="max-h-[14rem] overflow-auto whitespace-pre-wrap border-t border-border bg-surface-muted p-3 font-mono text-[11.5px] leading-relaxed">
              {request.sql}
            </pre>
          </section>
        ) : null}

        {request?.state === 'error' ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Could not explain</span>
              <span className="tag tag--error">error</span>
            </div>
            <div className="panel-body">
              <p className="font-mono text-[11.5px] text-error">{request.error}</p>
              {/* La causa se deduce del error en vez de listar las tres siempre:
                  un catálogo de causas posibles obliga a descartarlas a mano. */}
              <p className="mt-2 text-[11.5px] text-foreground-muted">
                {/does not exist|no existe/i.test(request.error ?? '')
                  ? 'The statement names an object that no longer exists or that the collector cannot see. Common with staging or temporary tables created by the application, and with objects the monitoring role cannot reach.'
                  : /permission denied|permiso denegado/i.test(request.error ?? '')
                    ? 'The monitoring role lacks read permission on one of the objects. Planning requires reading statistics for each involved table.'
                    : /syntax error/i.test(request.error ?? '')
                      ? 'The text is not a complete statement PostgreSQL can plan. Often truncated text, or a utility statement that EXPLAIN does not accept.'
                      : 'The error comes from the instance as returned, without interpretation by Búho.'}
              </p>
            </div>
          </section>
        ) : null}

        {request?.state === 'listo' && request.plan ? (
          <>
            <div className="stat-grid">
              <StatCard
                label="Mode"
                value={analyzed ? 'ANALYZE' : request.mode === 'generic' ? 'Generic' : 'Estimated'}
                hint={analyzed ? 'real rows and timings' : 'without running the query'}
              />
              <StatCard label="Total cost" value={formatNumber(request.totalCost ?? 0)} hint="planner units" />
              <StatCard
                label="Planning"
                value={request.planningMs === null ? '—' : `${request.planningMs.toFixed(2)} ms`}
              />
              <StatCard
                label="Execution"
                value={request.executionMs === null ? '—' : `${request.executionMs.toFixed(1)} ms`}
                hint={request.executionMs === null ? 'did not run' : undefined}
              />
              <StatCard
                label="Findings"
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

            {(() => {
              const verdict = planVerdict(request.findings, analyzed, summary);
              const tag =
                verdict.tone === 'error' ? 'tag--error' : verdict.tone === 'warn' ? 'tag--warn' : 'tag--ok';
              return (
                <section className="panel">
                  <div className="panel-header">
                    <span className="panel-title">Verdict</span>
                    <span className={`tag ${tag}`}>{verdict.title}</span>
                  </div>
                  <div className="panel-body text-[12px] text-foreground-secondary">{verdict.body}</div>
                </section>
              );
            })()}

            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Where the problem is</span>
                <span className="text-[11px] text-foreground-muted">
                  {request.findings.length === 0 ? 'sin patrones conocidos' : 'de mayor a menor severidad'}
                </span>
              </div>
              {request.findings.length === 0 ? (
                <div className="empty">
                  No known problematic pattern in this plan.
                  {!analyzed
                    ? ' Several checks — real vs estimated rows, disk spills, Nested Loop loops — can only be done by executing the query.'
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
                <span className="panel-title">Plan tree</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-foreground-muted">
                    the background bar is the share of {analyzed ? 'time' : 'cost'}
                  </span>
                  <Link
                    href={`/instances/${instanceId}/queries/${queryid}?plan=${request.requestId}&texto=${texto ? '' : '1'}`}
                    className="btn"
                  >
                    {texto ? 'View tree' : 'Ver texto'}
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
              <span className="panel-title">Previous plans</span>
              <span className="text-[11px] text-foreground-muted">
                shows whether the query plan changed
              </span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Modo</th>
                  <th>Pedido por</th>
                  <th>State</th>
                  <th className="text-right">Costo</th>
                  <th className="text-right">Execution</th>
                  <th className="text-right">Findings</th>
                  <th>Root node</th>
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
