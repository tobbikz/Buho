export const APM_WINDOWS = [
  { key: '15m', minutes: 15 as number | null },
  { key: '1h', minutes: 60 as number | null },
  { key: '6h', minutes: 360 as number | null },
  { key: '24h', minutes: 1440 as number | null },
  { key: 'all', minutes: null as number | null },
] as const;

export type ApmWindowKey = (typeof APM_WINDOWS)[number]['key'];

export function resolveApmWindow(key: string | undefined) {
  return APM_WINDOWS.find((w) => w.key === key) ?? APM_WINDOWS[1];
}

/** Absolute Discover range (Kibana-style). Prefer over presets when `from`/`to` are set. */
export type ApmAbsoluteRange = {
  kind: 'absolute';
  key: 'custom';
  from: Date;
  to: Date;
  minutes: null;
};

export type ApmPresetRange = {
  kind: 'preset';
  key: ApmWindowKey;
  from: null;
  to: null;
  minutes: number | null;
};

export type ApmTimeRange = ApmAbsoluteRange | ApmPresetRange;

export function parseApmInstant(raw: string | undefined | null): Date | null {
  if (!raw?.trim()) return null;
  const d = new Date(raw.trim());
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Resolve Trace Discover time scope.
 * Absolute `from`/`to` (ISO) wins; otherwise relative preset via `w`.
 */
export function resolveApmTimeRange(sp: {
  w?: string;
  from?: string;
  to?: string;
}): ApmTimeRange {
  const from = parseApmInstant(sp.from);
  const to = parseApmInstant(sp.to);
  if (from || to) {
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 60 * 60 * 1000);
    const [a, b] = start.getTime() <= end.getTime() ? [start, end] : [end, start];
    return { kind: 'absolute', key: 'custom', from: a, to: b, minutes: null };
  }
  const preset = resolveApmWindow(sp.w);
  return {
    kind: 'preset',
    key: preset.key,
    from: null,
    to: null,
    minutes: preset.minutes,
  };
}

/** datetime-local value in the browser's local zone. */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse datetime-local → ISO UTC for URL params. */
export function fromDatetimeLocalValue(local: string): string | null {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function formatApmRangeLabel(from: Date, to: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleString('es-MX', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return `${fmt(from)} → ${fmt(to)}`;
}
