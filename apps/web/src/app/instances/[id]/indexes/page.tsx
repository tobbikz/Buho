import { notFound } from 'next/navigation';
import Link from 'next/link';
import { InstanceTabs } from '@/components/InstanceTabs';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { Topbar } from '@/components/Topbar';
import { formatAgo, formatDuration, formatNumber } from '@/lib/format';
import { getInstanceEngine } from '@/lib/estate';
import { getInstance } from '@/lib/queries';
import { getIndexFindings, getIndexSuggestions } from '@/lib/advisor';
import type { SuggestionKind } from '@buho/core';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<SuggestionKind, string> = {
  seq_scan_filtrado: 'Sequential scan that discards almost everything it reads',
  indice_no_selectivo: 'The index finds rows but does not filter',
  orden_sin_indice: 'Sort that spilled to disk',
  join_sin_indice: 'Join without an index on the inner side',
};

const KIND_TAG: Record<SuggestionKind, string> = {
  seq_scan_filtrado: 'tag--warn',
  indice_no_selectivo: 'tag--warn',
  orden_sin_indice: 'tag--info',
  join_sin_indice: 'tag--warn',
};

export default async function IndexesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instanceId = Number(id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) notFound();

  const engine = (await getInstanceEngine(instanceId)) ?? 'postgres';

  let instance;
  let resultado: Awaited<ReturnType<typeof getIndexSuggestions>>;
  let findings: Awaited<ReturnType<typeof getIndexFindings>>;
  try {
    [instance, resultado, findings] = await Promise.all([
      getInstance(instanceId),
      getIndexSuggestions(instanceId),
      getIndexFindings(instanceId),
    ]);
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
    { label: 'Indexes' },
  ];

  const filasDesperdiciadas = resultado.suggestions.reduce((suma, s) => suma + s.wastedRows, 0);
  const tiempo = resultado.suggestions.reduce((suma, s) => suma + s.observedMs, 0);

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Indexes · {instance.alias}</h1>
            <p className="page-sub">
              Missing indexes according to plans already executed with ANALYZE. Each suggestion includes the
              exact condition that motivates it and how many rows were discarded: it is a{' '}
              <strong>hypothesis with evidence</strong>, not an order. An extra index is paid on every write and
              en cada vacuum.
            </p>
          </div>
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Sugerencias"
            value={formatNumber(resultado.suggestions.length)}
            tone={resultado.suggestions.length > 0 ? 'warn' : 'ok'}
            hint={`of ${formatNumber(resultado.plansWithActuals)} plans with real rows`}
          />
          <StatCard
            label="Rows discarded"
            value={formatNumber(filasDesperdiciadas)}
            hint="read then thrown away, per execution and repeats"
          />
          <StatCard
            label="Tiempo en esos nodos"
            value={formatDuration(tiempo)}
            hint="observed, not what would be saved"
          />
          <StatCard
            label="Planes analizados"
            value={formatNumber(resultado.plansConsidered)}
            hint={
              resultado.newestPlanAt ? `newest, from ${formatAgo(resultado.newestPlanAt)}` : 'none yet'
            }
          />
        </div>

        {resultado.plansWithActuals === 0 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">No plans to judge yet</span>
            </div>
            <div className="panel-body text-[12px]">
              <p>
                This screen does not guess: it starts from plans executed with ANALYZE, because those are the only ones that say
                how many rows each filter discarded. An estimated plan can be wrong by a factor of a thousand, and a
                suggestion based on that is a hunch dressed as a recommendation.
              </p>
              <p className="mt-2">
                To fill it: go to{' '}
                <Link href={`/instances/${instanceId}/queries`} className="text-accent">
                  Queries
                </Link>
                , open the most expensive ones and request their plan with ANALYZE. Only read-only queries are run, and
                always inside a transaction that is rolled back.
              </p>
            </div>
          </section>
        ) : resultado.suggestions.length === 0 ? (
          <div className="empty">
            None of the {formatNumber(resultado.plansWithActuals)} analyzed plans shows a pattern an
            index would fix. That does not mean indexes are perfect: it means the queries whose
            plan was requested are not suffering from a missing one.
          </div>
        ) : (
          <div className="flex flex-col gap-[0.875rem]">
            {resultado.suggestions.map((sugerencia, indice) => (
              <section className="panel" key={`${sugerencia.relation}-${sugerencia.columns.join('-')}-${indice}`}>
                <div className="panel-header">
                  <span className="panel-title font-mono">{sugerencia.relation}</span>
                  <span className={`tag ${KIND_TAG[sugerencia.kind]}`}>{KIND_LABEL[sugerencia.kind]}</span>
                </div>
                <div className="panel-body text-[12px]">
                  <p>{sugerencia.reason}</p>

                  <div className="query-block mt-2">{sugerencia.ddl}</div>

                  <p className="mt-2 text-foreground-muted">
                    <strong>Before applying it:</strong> {sugerencia.caveat}
                  </p>

                  <div className="table-scroll mt-3">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Query</th>
                          <th>Nodo</th>
                          <th>Condition</th>
                          <th className="text-right">Discarded</th>
                          <th className="text-right">Devueltas</th>
                          <th className="text-right">Ejecuciones</th>
                          <th className="text-right">Tiempo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sugerencia.evidence.map((prueba, fila) => (
                          <tr key={`${prueba.queryid ?? 'manual'}-${fila}`}>
                            <td className="font-mono text-[11px]">
                              {prueba.queryid ? (
                                <Link
                                  href={`/instances/${instanceId}/queries/${prueba.queryid}`}
                                  className="text-accent hover:underline"
                                >
                                  {prueba.queryid.slice(0, 12)}
                                </Link>
                              ) : (
                                'escrita a mano'
                              )}
                            </td>
                            <td className="font-mono text-[11px]">{prueba.nodeType}</td>
                            <td className="font-mono text-[11px]" style={{ maxWidth: '22rem' }}>
                              {prueba.predicate}
                            </td>
                            <td className="num">
                              {prueba.rowsRemoved === null ? '·' : formatNumber(prueba.rowsRemoved)}
                            </td>
                            <td className="num">
                              {prueba.rowsReturned === null ? '·' : formatNumber(prueba.rowsReturned)}
                            </td>
                            <td className="num">{formatNumber(prueba.loops ?? 1)}</td>
                            <td className="num">
                              {prueba.selfMs === null ? '·' : formatDuration(prueba.selfMs)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}

        {findings.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">What checks already say about indexes</span>
              <span className="font-mono text-[10px] text-foreground-muted">last day</span>
            </div>
            <div className="panel-body">
              {/* Esto va debajo a propósito: antes de agregar un index conviene
                  ver si sobra alguno. Duplicar el prefijo de un index existente
                  cuesta escrituras sin ganar lecturas. */}
              <ul className="list-disc pl-5 text-[12px]">
                {findings.map((hallazgo) => (
                  <li key={`${hallazgo.checkId}-${hallazgo.object}`}>
                    <span className="font-mono text-[11px]">{hallazgo.object}</span> · {hallazgo.message}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
