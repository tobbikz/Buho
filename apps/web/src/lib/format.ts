/** pg devuelve bigint y numeric como string; never confiar en el tipo crudo. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${(bytes < 0 ? -value : value).toFixed(digits)} ${units[unit]}`;
}

export function formatNumber(value: number | null, digits = 0): string {
  if (value === null) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPct(value: number | null, digits = 1): string {
  if (value === null) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  if (total < 86_400) return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  return `${Math.floor(total / 86_400)}d ${Math.floor((total % 86_400) / 3600)}h`;
}

export function formatAgo(at: Date | string | null): string {
  if (!at) return 'never';
  const date = at instanceof Date ? at : new Date(at);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 0) return 'now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** server_version_num: 180004 → "18.4". Ojo: no es una división por 10000. */
export function formatVersion(versionNum: number | null): string {
  if (versionNum === null) return '—';
  return `${Math.floor(versionNum / 10_000)}.${versionNum % 10_000}`;
}

export function formatClock(at: Date | string | null): string {
  if (!at) return '—';
  const date = at instanceof Date ? at : new Date(at);
  return date.toLocaleTimeString('en-US', { hour12: false });
}
