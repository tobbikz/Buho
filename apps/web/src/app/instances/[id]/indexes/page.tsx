import { notFound } from 'next/navigation';
import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
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
  seq_scan_filtrado: 'Escaneo secuencial que descarta casi todo lo que lee',
  indice_no_selectivo: 'El índice encuentra las filas pero no filtra',
  orden_sin_indice: 'Ordenamiento que se fue a disco',
  join_sin_indice: 'Join sin índice del lado interno',
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
  let hallazgos: Awaited<ReturnType<typeof getIndexFindings>>;
  try {
    [instance, resultado, hallazgos] = await Promise.all([
      getInstance(instanceId),
      getIndexSuggestions(instanceId),
      getIndexFindings(instanceId),
    ]);
  } catch (error) {
    return (
      <>
        <Topbar crumbs={[{ label: 'Flota', href: '/' }, { label: id }]} />
        <div className="page">
          <StoreError message={error instanceof Error ? error.message : String(error)} />
        </div>
      </>
    );
  }
  if (!instance) notFound();

  const crumbs = [
    { label: 'Flota', href: '/' },
    { label: instance.alias, href: `/instances/${instanceId}` },
    { label: 'Índices' },
  ];

  const filasDesperdiciadas = resultado.suggestions.reduce((suma, s) => suma + s.wastedRows, 0);
  const tiempo = resultado.suggestions.reduce((suma, s) => suma + s.observedMs, 0);

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Índices · {instance.alias}</h1>
            <p className="page-sub">
              Índices que faltan según los planes que ya se ejecutaron con ANALYZE. Cada sugerencia trae la
              condición exacta que la motiva y cuántas filas se descartaron: es una{' '}
              <strong>hipótesis con evidencia</strong>, no una orden. Un índice de más se paga en cada escritura y
              en cada vacuum.
            </p>
          </div>
          <AutoRefresh intervalMs={60000} />
        </header>

        <InstanceTabs instanceId={instanceId} engine={engine} />

        <div className="stat-grid">
          <StatCard
            label="Sugerencias"
            value={formatNumber(resultado.suggestions.length)}
            tone={resultado.suggestions.length > 0 ? 'warn' : 'ok'}
            hint={`de ${formatNumber(resultado.plansWithActuals)} planes con filas reales`}
          />
          <StatCard
            label="Filas descartadas"
            value={formatNumber(filasDesperdiciadas)}
            hint="leídas para tirarlas, por ejecución y repeticiones"
          />
          <StatCard
            label="Tiempo en esos nodos"
            value={formatDuration(tiempo)}
            hint="lo observado, no lo que se ahorraría"
          />
          <StatCard
            label="Planes analizados"
            value={formatNumber(resultado.plansConsidered)}
            hint={
              resultado.newestPlanAt ? `el más nuevo, de ${formatAgo(resultado.newestPlanAt)}` : 'ninguno todavía'
            }
          />
        </div>

        {resultado.plansWithActuals === 0 ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Todavía no hay planes de los que opinar</span>
            </div>
            <div className="panel-body text-[12px]">
              <p>
                Esta pantalla no adivina: parte de planes ejecutados con ANALYZE, porque son los únicos que dicen
                cuántas filas descartó cada filtro. Un plan estimado puede equivocarse por un factor de mil, y una
                sugerencia basada en eso es una corazonada con formato de recomendación.
              </p>
              <p className="mt-2">
                Para llenarla: entrar a{' '}
                <Link href={`/instances/${instanceId}/queries`} className="text-accent">
                  Consultas
                </Link>
                , abrir las más caras y pedir su plan con ANALYZE. Sólo se ejecutan consultas de sólo lectura, y
                siempre dentro de una transacción que se revierte.
              </p>
            </div>
          </section>
        ) : resultado.suggestions.length === 0 ? (
          <div className="empty">
            Ningún plan de los {formatNumber(resultado.plansWithActuals)} analizados muestra un patrón que un
            índice arregle. Eso no significa que los índices estén perfectos: significa que las consultas cuyo
            plan se pidió no están sufriendo por falta de uno.
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
                    <strong>Antes de aplicarlo:</strong> {sugerencia.caveat}
                  </p>

                  <div className="table-scroll mt-3">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Consulta</th>
                          <th>Nodo</th>
                          <th>Condición</th>
                          <th className="text-right">Descartadas</th>
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

        {hallazgos.length > 0 && (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Lo que los chequeos ya dicen de los índices</span>
              <span className="font-mono text-[10px] text-foreground-muted">último día</span>
            </div>
            <div className="panel-body">
              {/* Esto va debajo a propósito: antes de agregar un índice conviene
                  ver si sobra alguno. Duplicar el prefijo de un índice existente
                  cuesta escrituras sin ganar lecturas. */}
              <ul className="list-disc pl-5 text-[12px]">
                {hallazgos.map((hallazgo) => (
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
