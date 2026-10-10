/**
 * Panel con la explicación automática del incidente.
 *
 * Es un párrafo, no un dashboard: el valor es poder leerlo en voz alta a las
 * 3am y saber por dónde empezar.
 */
export function IncidentPanel({
  headline,
  body,
  tone,
  at,
  href,
}: {
  headline: string;
  body: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  at?: Date | null;
  href?: string;
}) {
  const border =
    tone === 'error'
      ? 'var(--error)'
      : tone === 'warn'
        ? 'var(--warning)'
        : tone === 'ok'
          ? 'var(--success)'
          : 'var(--border)';

  return (
    <section className="panel" style={{ borderLeft: `3px solid ${border}` }}>
      <div className="panel-header">
        <span className="panel-title">{headline}</span>
        {at ? (
          <span className="font-mono text-[10px] text-foreground-muted">
            at {at.toLocaleString('en')}
          </span>
        ) : null}
      </div>
      <div className="panel-body text-[13px] leading-relaxed text-foreground-secondary">
        {body}
        {href ? (
          <>
            {' '}
            <a href={href} className="text-[var(--accent)] underline-offset-2 hover:underline">
              View sessions
            </a>
          </>
        ) : null}
      </div>
    </section>
  );
}
