import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatAgo } from '@/lib/format';
import {
  CATEGORY_LABEL,
  SEVERITY_LABEL,
  engineLabel,
  getFindings,
  getPosture,
  scoreTone,
  type Finding,
  type Posture,
  type Severity,
} from '@/lib/security';

export const dynamic = 'force-dynamic';

const ORDER: Severity[] = ['critica', 'alta', 'media', 'baja', 'no_verificable', 'ok'];

function findingClass(severity: Severity): string {
  if (severity === 'critica' || severity === 'alta') return 'finding finding--critical';
  if (severity === 'media' || severity === 'baja') return 'finding finding--warning';
  return 'finding finding--info';
}

export default async function SecurityPage() {
  let findings: Finding[];
  let posture: Posture[];
  try {
    [findings, posture] = await Promise.all([getFindings(), getPosture()]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  if (posture.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Sin auditorías todavía</span>
        </div>
        <div className="panel-body text-[12px] text-foreground-secondary">
          El colector audita la seguridad cada 6 horas y la primera lectura ocurre al arrancar. Si esto sigue
          vacío, revisar el registro del colector: la auditoría necesita conectarse a cada instancia.
        </div>
      </section>
    );
  }

  const critical = findings.filter((finding) => finding.severity === 'critica');
  const high = findings.filter((finding) => finding.severity === 'alta');
  const blind = findings.filter((finding) => finding.severity === 'no_verificable');
  const exposed = new Set(critical.map((finding) => finding.instanceId));
  const worst = posture[0];

  const grouped = ORDER.map((severity) => ({
    severity,
    items: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Hallazgos críticos"
          value={String(critical.length)}
          hint="se entra sin credencial válida"
          tone={critical.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Hallazgos altos"
          value={String(high.length)}
          hint="credenciales o datos expuestos"
          tone={high.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Instancias comprometibles"
          value={`${exposed.size}/${posture.length}`}
          hint="con al menos un hallazgo crítico"
          tone={exposed.size > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="Peor postura"
          value={String(worst.score)}
          unit="/100"
          hint={worst.alias}
          tone={scoreTone(worst.score)}
        />
        <StatCard
          label="Puntos ciegos"
          value={String(blind.length)}
          hint="comprobaciones sin permisos"
          tone={blind.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Postura por instancia</span>
          <span className="text-[11px] text-foreground-muted">
            el puntaje se calcula sólo sobre lo que se pudo verificar
          </span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Instancia</th>
              <th>Motor</th>
              <th className="text-right">Postura</th>
              <th className="text-right">Críticas</th>
              <th className="text-right">Altas</th>
              <th className="text-right">Medias</th>
              <th className="text-right">Bajas</th>
              <th className="text-right">Verificadas</th>
              <th>Última auditoría</th>
            </tr>
          </thead>
          <tbody>
            {posture.map((row) => (
              <tr key={row.instanceId}>
                <td>
                  <Link href={`/instances/${row.instanceId}`}>{row.alias}</Link>
                </td>
                <td>{engineLabel(row.engine)}</td>
                <td className="text-right">
                  <span className={`score score--${scoreTone(row.score)}`}>{row.score}</span>
                </td>
                <td className="text-right">
                  {row.critical > 0 ? <span className="tag tag--error">{row.critical}</span> : '—'}
                </td>
                <td className="text-right">
                  {row.high > 0 ? <span className="tag tag--error">{row.high}</span> : '—'}
                </td>
                <td className="text-right">
                  {row.medium > 0 ? <span className="tag tag--warn">{row.medium}</span> : '—'}
                </td>
                <td className="text-right">{row.low > 0 ? row.low : '—'}</td>
                <td className="text-right">
                  {row.verified}/{row.total}
                </td>
                <td>{formatAgo(row.capturedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {grouped.map((group) => (
        <section className="panel" key={group.severity}>
          <div className="panel-header">
            <span className="panel-title">{SEVERITY_LABEL[group.severity]}</span>
            <span
              className={`tag ${
                group.severity === 'critica' || group.severity === 'alta'
                  ? 'tag--error'
                  : group.severity === 'ok'
                    ? 'tag--ok'
                    : group.severity === 'no_verificable'
                      ? 'tag--muted'
                      : 'tag--warn'
              }`}
            >
              {group.items.length}
            </span>
            {group.severity === 'no_verificable' && (
              <span className="text-[11px] text-foreground-muted">
                Búho no pudo mirar. No significa que esté bien
              </span>
            )}
          </div>
          <div className="panel-body p-0">
            {group.items.map((finding) => (
              <div
                key={`${finding.instanceId}-${finding.checkId}`}
                className={findingClass(finding.severity)}
              >
                <div className="flex flex-col gap-1">
                  <Link href={`/instances/${finding.instanceId}`} className="text-[11px]">
                    {finding.alias}
                  </Link>
                  <span className="tag tag--muted">{CATEGORY_LABEL[finding.category] ?? finding.category}</span>
                </div>
                <div>
                  <div className="finding__title">{finding.title}</div>
                  <div className="finding__message">{finding.detail}</div>
                  {finding.remediation && (
                    <div className="finding__remediation">{finding.remediation}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
