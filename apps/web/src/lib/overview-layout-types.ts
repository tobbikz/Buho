import {
  OVERVIEW_DEFAULT_H,
  OVERVIEW_DEFAULT_W,
  OVERVIEW_GRID_COLS,
  PG_OVERVIEW_BUILTIN_IDS,
  defaultBuiltinGrid,
  isPgOverviewBuiltinId,
  type PgOverviewBuiltinId,
} from './overview-builtins';

/** Engines that get a metric-board Overview (Edit layout), not only Postgres. */
export type OverviewEngine = 'postgres' | 'mariadb' | 'mssql';

export type OverviewWidgetKind = 'builtin' | 'metric' | 'sql';
/** @deprecated Migrated to w (4/8/12). */
export type OverviewWidgetSpan = 1 | 2 | 3;
export type OverviewSqlMode = 'timeseries' | 'table' | 'big_number' | 'bar';
export type OverviewMetricUnit = 'count' | 'rate' | 'pct' | 'bytes';

export interface OverviewWidget {
  id: string;
  kind: OverviewWidgetKind;
  /** Grid column start (0 … cols-1). */
  x: number;
  /** Grid row start. */
  y: number;
  /** Width in columns (1–12). */
  w: number;
  /** Height in row units. */
  h: number;
  hidden?: boolean;
  title?: string;
  metrics?: string[];
  unit?: OverviewMetricUnit;
  sql?: string;
  sqlMode?: OverviewSqlMode;
  /** Legacy field — normalized into w. */
  span?: OverviewWidgetSpan;
}

export interface OverviewLayout {
  version: 1;
  widgets: OverviewWidget[];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function spanToW(span: unknown): number {
  const n = Number(span);
  if (n === 3) return 12;
  if (n === 2) return 8;
  if (n === 1) return 4;
  return OVERVIEW_DEFAULT_W;
}

function metricDefaults(
  defs: Array<{ id: string; title: string; metrics: string[]; unit: OverviewMetricUnit }>,
): OverviewLayout {
  return {
    version: 1,
    widgets: defs.map((def, index) => ({
      id: def.id,
      kind: 'metric' as const,
      title: def.title,
      metrics: def.metrics,
      unit: def.unit,
      x: (index % 3) * OVERVIEW_DEFAULT_W,
      y: Math.floor(index / 3) * OVERVIEW_DEFAULT_H,
      w: OVERVIEW_DEFAULT_W,
      h: OVERVIEW_DEFAULT_H,
    })),
  };
}

function defaultMariaOverviewLayout(): OverviewLayout {
  return metricDefaults([
    {
      id: 'fm_conn',
      title: 'Connections',
      metrics: ['connections_total', 'connections_active'],
      unit: 'count',
    },
    { id: 'fm_qps', title: 'Queries / s', metrics: ['queries_total_per_sec'], unit: 'rate' },
    {
      id: 'fm_dml',
      title: 'DML / s',
      metrics: ['db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec'],
      unit: 'rate',
    },
    { id: 'fm_cache', title: 'Buffer pool hit', metrics: ['db_cache_hit_pct'], unit: 'pct' },
    {
      id: 'fm_locks',
      title: 'Row lock waits / s',
      metrics: ['innodb_row_lock_waits_per_sec'],
      unit: 'rate',
    },
    { id: 'fm_threads', title: 'Threads running', metrics: ['threads_running'], unit: 'count' },
    { id: 'fm_blocked', title: 'Blocked sessions', metrics: ['blocked_sessions'], unit: 'count' },
    { id: 'fm_slow', title: 'Slow queries / s', metrics: ['slow_queries_per_sec'], unit: 'rate' },
    {
      id: 'fm_abort',
      title: 'Aborted connects / s',
      metrics: ['aborted_connects_per_sec'],
      unit: 'rate',
    },
  ]);
}

function defaultMssqlOverviewLayout(): OverviewLayout {
  return metricDefaults([
    {
      id: 'fs_conn',
      title: 'Connections',
      metrics: ['connections_total', 'connections_active'],
      unit: 'count',
    },
    {
      id: 'fs_dml',
      title: 'DML / s',
      metrics: ['db_tup_inserted_per_sec', 'db_tup_updated_per_sec', 'db_tup_deleted_per_sec'],
      unit: 'rate',
    },
    { id: 'fs_cache', title: 'Cache hit', metrics: ['db_cache_hit_pct'], unit: 'pct' },
    { id: 'fs_cpu', title: 'Host CPU', metrics: ['host_cpu_pct'], unit: 'pct' },
    { id: 'fs_mem', title: 'Host memory', metrics: ['host_mem_used_pct'], unit: 'pct' },
    { id: 'fs_blocked', title: 'Blocked sessions', metrics: ['blocked_sessions'], unit: 'count' },
    { id: 'fs_ple', title: 'Page life expectancy', metrics: ['page_life_expectancy_seconds'], unit: 'count' },
    { id: 'fs_logins', title: 'Logins / s', metrics: ['logins_per_sec'], unit: 'rate' },
  ]);
}

export function defaultOverviewLayout(engine = 'postgres'): OverviewLayout {
  if (engine === 'mariadb') return defaultMariaOverviewLayout();
  if (engine === 'mssql') return defaultMssqlOverviewLayout();
  return {
    version: 1,
    widgets: defaultBuiltinGrid().map((cell) => ({
      id: cell.id,
      kind: 'builtin' as const,
      x: cell.x,
      y: cell.y,
      w: cell.w,
      h: cell.h,
    })),
  };
}

function normalizeWidget(raw: unknown): OverviewWidget | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? '');
  if (!id) return null;
  const kind = row.kind === 'metric' || row.kind === 'sql' || row.kind === 'builtin' ? row.kind : null;
  if (!kind) return null;
  if (kind === 'builtin' && !isPgOverviewBuiltinId(id)) return null;

  const hasW = Number.isFinite(Number(row.w));
  const w = hasW
    ? clamp(Math.round(Number(row.w)), 1, OVERVIEW_GRID_COLS)
    : spanToW(row.span);
  const h = Number.isFinite(Number(row.h))
    ? clamp(Math.round(Number(row.h)), 1, 24)
    : OVERVIEW_DEFAULT_H;
  const x = Number.isFinite(Number(row.x))
    ? clamp(Math.round(Number(row.x)), 0, OVERVIEW_GRID_COLS - 1)
    : 0;
  const y = Number.isFinite(Number(row.y)) ? Math.max(0, Math.round(Number(row.y))) : 0;

  const widget: OverviewWidget = {
    id,
    kind,
    x,
    y,
    w,
    h,
    hidden: Boolean(row.hidden) || undefined,
  };
  if (typeof row.title === 'string' && row.title.trim()) widget.title = row.title.trim();
  if (kind === 'metric') {
    const metrics = Array.isArray(row.metrics)
      ? row.metrics.map((m) => String(m)).filter(Boolean).slice(0, 8)
      : [];
    if (metrics.length === 0) return null;
    widget.metrics = metrics;
    if (row.unit === 'rate' || row.unit === 'pct' || row.unit === 'bytes' || row.unit === 'count') {
      widget.unit = row.unit;
    } else {
      widget.unit = 'count';
    }
  }
  if (kind === 'sql') {
    const sql = typeof row.sql === 'string' ? row.sql.trim() : '';
    if (!sql) return null;
    widget.sql = sql;
    if (
      row.sqlMode === 'table' ||
      row.sqlMode === 'big_number' ||
      row.sqlMode === 'bar' ||
      row.sqlMode === 'timeseries'
    ) {
      widget.sqlMode = row.sqlMode;
    } else {
      widget.sqlMode = 'timeseries';
    }
  }
  return widget;
}

/** When legacy layouts lack x/y, pack left-to-right like defaults. */
function ensurePositions(widgets: OverviewWidget[]): OverviewWidget[] {
  const missing = widgets.every((w) => w.x === 0 && w.y === 0) && widgets.length > 1;
  // Only auto-pack if every widget is stuck at 0,0 (legacy span-only saves).
  const allOrigin =
    widgets.length > 1 &&
    widgets.filter((w) => !w.hidden).every((w) => (w.x ?? 0) === 0 && (w.y ?? 0) === 0);
  if (!allOrigin && !missing) return widgets;

  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  return widgets.map((w) => {
    const width = clamp(w.w || OVERVIEW_DEFAULT_W, 1, OVERVIEW_GRID_COLS);
    if (cursorX + width > OVERVIEW_GRID_COLS) {
      cursorX = 0;
      cursorY += Math.max(rowH, OVERVIEW_DEFAULT_H);
      rowH = 0;
    }
    const placed = { ...w, x: cursorX, y: cursorY, w: width, h: w.h || OVERVIEW_DEFAULT_H };
    cursorX += width;
    rowH = Math.max(rowH, placed.h);
    return placed;
  });
}

/** Merge saved layout with defaults. Postgres also re-injects missing builtins. */
export function mergeWithDefaults(
  saved: OverviewLayout | null,
  engine: OverviewEngine | string = 'postgres',
): OverviewLayout {
  const defaults = defaultOverviewLayout(engine);
  if (!saved || !Array.isArray(saved.widgets)) return defaults;

  const normalized = saved.widgets
    .map(normalizeWidget)
    .filter((w): w is OverviewWidget => w !== null);
  const seenBuiltins = new Set<string>();
  const widgets: OverviewWidget[] = [];

  for (const w of normalized) {
    if (w.kind === 'builtin') {
      if (engine !== 'postgres' || !isPgOverviewBuiltinId(w.id)) continue;
      if (seenBuiltins.has(w.id)) continue;
      seenBuiltins.add(w.id);
    }
    widgets.push(w);
  }

  if (engine === 'postgres') {
    const defaultsById = new Map(defaultBuiltinGrid().map((c) => [c.id, c]));
    for (const id of PG_OVERVIEW_BUILTIN_IDS) {
      if (seenBuiltins.has(id)) continue;
      const cell = defaultsById.get(id)!;
      widgets.push({
        id,
        kind: 'builtin',
        x: cell.x,
        y: cell.y,
        w: cell.w,
        h: cell.h,
      });
    }
  } else if (widgets.length === 0) {
    return defaults;
  }

  return { version: 1, widgets: ensurePositions(widgets) };
}

export function parseOverviewLayout(
  raw: unknown,
  engine: OverviewEngine | string = 'postgres',
): OverviewLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.widgets)) return null;
  return mergeWithDefaults({ version: 1, widgets: row.widgets as OverviewWidget[] }, engine);
}

export function newCustomWidgetId(prefix: 'm' | 's'): string {
  return `c_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function nextWidgetPlacement(
  widgets: OverviewWidget[],
  w = OVERVIEW_DEFAULT_W,
  h = OVERVIEW_DEFAULT_H,
): { x: number; y: number; w: number; h: number } {
  const maxY = widgets.reduce((peak, widget) => Math.max(peak, widget.y + widget.h), 0);
  return { x: 0, y: maxY, w, h };
}

export type { PgOverviewBuiltinId };
