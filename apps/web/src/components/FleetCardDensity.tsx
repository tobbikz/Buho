'use client';

export type FleetCardDensity = 'compact' | 'medium' | 'comfortable';

const OPTIONS: { value: FleetCardDensity; label: string; hint: string }[] = [
  { value: 'compact', label: 'Compact', hint: 'Smallest tiles' },
  { value: 'medium', label: 'Medium', hint: 'Dense overview' },
  { value: 'comfortable', label: 'Comfortable', hint: 'Room to read' },
];

export function FleetCardDensity({
  value,
  onChange,
}: {
  value: FleetCardDensity;
  onChange: (value: FleetCardDensity) => void;
}) {
  return (
    <div className="fleet-density" role="group" aria-label="Card density">
      <span className="fleet-density__label">Cards</span>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`fleet-density__btn ${value === option.value ? 'is-active' : ''}`}
          title={option.hint}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
