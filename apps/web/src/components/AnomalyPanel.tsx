import Link from 'next/link';
import { formatNumber } from '@/lib/format';
import { describeMetric } from '@/lib/metrics';
import type { Anomaly } from '@/lib/baselines';

/**
 * Métricas fuera de lo normal para esta hora.
 *
 * El valor de esta pantalla no es el número, que ya está en los gráficos: es la
 * comparación. "1 200 connections" no dice nada; "1 200 cuando lo normal para un
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
        <span className="panel-title">Out of range</span>
        <span className="font-mono text-[10px] text-foreground-muted">
          {anomalies[0]
            ? anomalies[0].scope === 'hora_semana'
              ? 'vs same weekday and hour'
              : 'vs same hour of day'
            : 'own baseline'}
        </span>
      </div>

      {anomalies.length === 0 ? (
        <div className="empty">
          {coverage === null
            ? 'No baseline yet. It is computed from hourly history and appears once there are enough observations for the same hour.'
            : coverage.medianSamples < 5
              ? `Baseline forming: ${coverage.metrics} metrics with ${coverage.medianSamples} observation(s) per hour. At least 5 are needed for a band to mean anything.`
              : 'All metrics are within their usual range for this hour.'}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="text-right">Now</th>
                <th className="text-right">Normal</th>
                <th>What happened</th>
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
                        {anomaly.direction === 'arriba' ? 'above' : 'below'}
                      </span>{' '}
                      <span className="text-foreground-secondary">
                        {/* El exceso se expresa en anchos de banda: es lo que
                            permite comparar una métrica estable con una
                            volátil sin confundir escala con gravedad. */}
                        {anomaly.excess >= 1
                          ? `${formatNumber(anomaly.excess, 1)}× the usual range`
                          : 'just outside the range'}
                        <span className="ml-1 text-foreground-muted">
                          · median {formatNumber(anomaly.p50, digits)}
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
