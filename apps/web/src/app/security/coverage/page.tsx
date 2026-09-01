import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { CATEGORY_LABEL, engineLabel, getFindings, getPosture, type Finding, type Posture } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Cobertura: qué no pudo comprobar Búho y por qué.
 *
 * Es la pantalla que justifica todo el módulo. Una herramienta de seguridad que
 * muestra sólo findings deja al DBA con una duda que no puede resolver: si la
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
          label="Audit coverage"
          value={String(pct)}
          unit="%"
          hint={`${verified} of ${total} checks`}
          tone={pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'error'}
        />
        <StatCard
          label="Blind checks"
          value={String(blind.length)}
          hint="lacking permissions to run"
          tone={blind.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Affected instances"
          value={`${affected.size}/${posture.length}`}
          hint="con al menos un punto ciego"
          tone={affected.size > 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Why posture is not the whole story</span>
        </div>
        <div className="panel-body flex flex-col gap-2 text-[12px] text-foreground-secondary">
          <p>
            El puntaje de cada instancia se calcula <strong>only over what could be verified</strong>. Las
            checks on this list neither add nor subtract: their result is unknown.
          </p>
          <p>
            Counting them as passed would be the comfortable lie — a high posture with half the
            checks unrun. Counting them as failed would be just as useless: the score would drop when a
            permission is missing and rise when it is granted, without real security changing at all.
          </p>
          <p>
            Búho pide permisos de lectura, never de escritura. Conceder lo que falta amplía lo que la
            herramienta ve, no lo que puede hacer.
          </p>
        </div>
      </section>

      {blind.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">No blind spots</span>
            <span className="tag tag--ok">full coverage</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            Todas las comprobaciones se pudieron ejecutar en todas las instancias.
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Checks that could not run</span>
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
