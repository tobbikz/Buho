export type StatTone = 'neutral' | 'ok' | 'warn' | 'error' | 'accent';

export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: StatTone;
}) {
  return (
    <div className={`stat ${tone === 'neutral' ? '' : `stat--${tone}`}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

/** Umbrales compartidos para que un mismo número no se pinte distinto en dos vistas. */
export function toneForPct(value: number | null, warn: number, error: number): StatTone {
  if (value === null) return 'neutral';
  if (value >= error) return 'error';
  if (value >= warn) return 'warn';
  return 'ok';
}

export function toneForMinimum(value: number | null, warn: number, error: number): StatTone {
  if (value === null) return 'neutral';
  if (value <= error) return 'error';
  if (value <= warn) return 'warn';
  return 'ok';
}

export function toneForScore(score: number | null): StatTone {
  if (score === null) return 'neutral';
  if (score < 60) return 'error';
  if (score < 85) return 'warn';
  return 'ok';
}
