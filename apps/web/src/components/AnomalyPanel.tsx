import Link from 'next/link';
import { formatNumber } from '@/lib/format';
import { describeMetric } from '@/lib/metrics';
import type { Anomaly } from '@/lib/baselines';

/**
 * Métricas fuera de lo normal para esta hora.
 *
 * El valor de esta pantalla no es el número, que ya está en los gráficos: es la
 * comparación. "1 200 conexiones" no dice nada; "1 200 cuando lo normal para un
 * martes a las 3 de la tarde son 300" es un incidente.
 */
export function AnomalyPanel({
  instanceId,
  anomalies,
  coverage,
}: {
  instanceId: number;
  anomalies: Anomaly[];
  coverage: { metrics: number; medianSamples: number } | null;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Fuera de lo normal</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          {anomalies[0]
            ? anomalies[0].scope === 'hora_semana'
              ? 'contra el mismo día y hora'
              : 'contra la misma hora'
            : 'línea base propia'}
        </span>
      </div>

      {anomalies.length === 0 ? (
        <div className="empty">
          {coverage === null
            ? 'Sin línea base todavía. Se calcula desde el histórico horario y aparece cuando hay suficientes observaciones de la misma hora.'
            : coverage.medianSamples < 5
              ? `Línea base en formación: ${coverage.metrics} métricas con ${coverage.medianSamples} observación(es) por hora. Hacen falta al menos 5 para que una banda signifique algo.`
              : 'Todas las métricas están dentro de su rango habitual para esta hora.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Métrica</th>
                <th className="text-right">Ahora</th>
                <th className="text-right">Normal</th>
                <th>Qué pasó</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((anomaly) => {
                const meta = describeMetric(anomaly.metric);
                const digits = anomaly.value < 10 ? 2 : 0;
                return (
                  <tr key={anomaly.metric}>
                    <td>
                      <Link
                        href={`/instances/${instanceId}/analysis?m=${encodeURIComponent(anomaly.metric)}&base=1`}
                        className="text-[11.5px] underline"
                      >
                        {meta.label}
                      </Link>
                    </td>
                    <td className="num font-mono text-[11.5px] font-semibold">
                      {formatNumber(anomaly.value, digits)}
                    </td>
                    <td className="num font-mono text-[11px] text-foreground-muted">
                      {formatNumber(anomaly.p10, digits)}–{formatNumber(anomaly.p90, digits)}
                    </td>
                    <td className="text-[11.5px]">
                      <span
                        className={`tag ${anomaly.direction === 'arriba' ? 'tag--warn' : 'tag--info'}`}
                      >
                        {anomaly.direction === 'arriba' ? 'por encima' : 'por debajo'}
                      </span>{' '}
                      <span className="text-foreground-secondary">
                        {/* El exceso se expresa en anchos de banda: es lo que
                            permite comparar una métrica estable con una
                            volátil sin confundir escala con gravedad. */}
                        {anomaly.excess >= 1
                          ? `${formatNumber(anomaly.excess, 1)}× el rango habitual`
                          : 'apenas fuera del rango'}
                        <span className="ml-1 text-foreground-muted">
                          · mediana {formatNumber(anomaly.p50, digits)}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
