/** Stable builtin widget ids for Postgres instance Overview charts. */

export const PG_OVERVIEW_BUILTIN_IDS = [
  'host',
  'connections',
  'wait_classes',
  'tps',
  'dml',
  'wal',
  'blocked',
  'io',
  'cache',
  'checkpoints',
  'temp',
  'timeouts',
] as const;

export type PgOverviewBuiltinId = (typeof PG_OVERVIEW_BUILTIN_IDS)[number];

export const PG_OVERVIEW_BUILTIN_LABEL: Record<PgOverviewBuiltinId, string> = {
  host: 'Host CPU and memory',
  connections: 'Connections',
  wait_classes: 'Active sessions by wait class',
  tps: 'Transactions / s',
  dml: 'DML tuples / s',
  wal: 'WAL / s',
  blocked: 'Blocked sessions',
  io: 'I/O / s',
  cache: 'Cache hit',
  checkpoints: 'Checkpoints',
  temp: 'Temp spill',
  timeouts: 'Timeouts',
};

/** @deprecated Prefer DEFAULT_GRID; kept for migrating old span layouts. */
export const PG_OVERVIEW_DEFAULT_SPANS: Record<PgOverviewBuiltinId, 1 | 2 | 3> = {
  host: 1,
  connections: 1,
  wait_classes: 1,
  tps: 1,
  dml: 1,
  wal: 1,
  blocked: 1,
  io: 1,
  cache: 1,
  checkpoints: 1,
  temp: 1,
  timeouts: 1,
};

export const OVERVIEW_GRID_COLS = 12;
export const OVERVIEW_ROW_HEIGHT = 56;
export const OVERVIEW_DEFAULT_W = 4;
export const OVERVIEW_DEFAULT_H = 4;

export function isPgOverviewBuiltinId(id: string): id is PgOverviewBuiltinId {
  return (PG_OVERVIEW_BUILTIN_IDS as readonly string[]).includes(id);
}

/** Pack builtins 3-across on a 12-col board. */
export function defaultBuiltinGrid(): Array<{
  id: PgOverviewBuiltinId;
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  return PG_OVERVIEW_BUILTIN_IDS.map((id, index) => ({
    id,
    x: (index % 3) * OVERVIEW_DEFAULT_W,
    y: Math.floor(index / 3) * OVERVIEW_DEFAULT_H,
    w: OVERVIEW_DEFAULT_W,
    h: OVERVIEW_DEFAULT_H,
  }));
}
