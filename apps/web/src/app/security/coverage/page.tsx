import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { CATEGORY_LABEL, engineLabel, getFindings, getPosture, type Finding, type Posture } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Cobertura: qué no pudo comprobar Búho y por qué.
 *
 * Es la pantalla que justifica todo el módulo. Una herramienta de seguridad que
 * muestra sólo hallazgos deja al DBA con una duda que no puede resolver: si la
 * lista está vacía, ¿está limpio el servidor o la herramienta se quedó ciega?
 * Acá esa diferencia es explícita, con el permiso exacto que falta al lado.
 */
export default async function CoveragePage() {
  let findings: Finding[];
  let posture: Posture[];
  try {
    [findings, posture] = await Promise.all([getFindings(), getPosture()]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const blind = findings.filter((finding) => finding.severity === 'no_verificable');
  const verified = posture.reduce((sum, row) => sum + row.verified, 0);
  const total = posture.reduce((sum, row) => sum + row.total, 0);
  const pct = total > 0 ? Math.round((verified / total) * 100) : 0;
  const affected = new Set(blind.map((finding) => finding.instanceId));

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Cobertura de la auditoría"
          value={String(pct)}
          unit="%"
          hint={`${verified} de ${total} comprobaciones`}
          tone={pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'error'}
        />
        <StatCard
          label="Comprobaciones ciegas"
          value={String(blind.length)}
          hint="sin permisos para ejecutarse"
          tone={blind.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Instancias afectadas"
          value={`${affected.size}/${posture.length}`}
          hint="con al menos un punto ciego"
          tone={affected.size > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Por qué la postura no lo dice todo</span>
        </div>
        <div className="panel-body flex flex-col gap-2 text-[12px] text-foreground-secondary">
          <p>
            El puntaje de cada instancia se calcula <strong>sólo sobre lo que se pudo verificar</strong>. Las
            comprobaciones de esta lista no suman ni restan: no se sabe su resultado.
          </p>
          <p>
            Contarlas como aprobadas sería la mentira cómoda —una postura alta con la mitad de las
            comprobaciones sin correr—. Contarlas como falladas sería igual de inútil: el puntaje bajaría al
            faltar un permiso y subiría al concederlo, sin que la seguridad real cambiara en nada.
          </p>
          <p>
            Búho pide permisos de lectura, nunca de escritura. Conceder lo que falta amplía lo que la
            herramienta ve, no lo que puede hacer.
          </p>
        </div>
      </section>

      {blind.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Sin puntos ciegos</span>
            <span className="tag tag--ok">cobertura completa</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            Todas las comprobaciones se pudieron ejecutar en todas las instancias.
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Comprobaciones que no se pudieron ejecutar</span>
            <span className="tag tag--muted">{blind.length}</span>
          </div>
          <div className="panel-body p-0">
            {blind.map((finding) => (
              <div key={`${finding.instanceId}-${finding.checkId}`} className="finding finding--info">
                <div className="flex flex-col gap-1">
                  <Link href={`/instances/${finding.instanceId}`} className="text-[11px]">
                    {finding.alias}
                  </Link>
                  <span className="tag tag--muted">{engineLabel(finding.engine)}</span>
                </div>
                <div>
                  <div className="finding__title">
                    {finding.title}
                    <span className="ml-2 tag tag--muted">
                      {CATEGORY_LABEL[finding.category] ?? finding.category}
                    </span>
                  </div>
                  <div className="finding__message">{finding.detail}</div>
                  {finding.remediation && <div className="finding__remediation">{finding.remediation}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
