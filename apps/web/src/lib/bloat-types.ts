/**
 * Tipos y textos del bloat medido, sin acceso a la base.
 *
 * Vive aparte de `bloat.ts` porque el botón de medir es un componente de
 * cliente: si importara el módulo que abre el pool de `pg`, el empaquetador
 * arrastraría el driver de PostgreSQL al navegador.
 */

export type BloatMode = 'exacto' | 'aproximado';
export type BloatState = 'pendiente' | 'corriendo' | 'listo' | 'error';

export const BLOAT_MODE_LABEL: Record<BloatMode, string> = {
  exacto: 'Exact measurement',
  aproximado: 'Approximate measurement',
};

export const BLOAT_MODE_HINT: Record<BloatMode, string> = {
  exacto:
    'Reads every page and every tuple in the table. Ground truth, at the cost of a full sequential scan: on a large table that is minutes of I/O on the monitored instance.',
  aproximado:
    'Skips pages the visibility map marks as clean, so it only pays for what changed. Usually a fraction of the exact cost and off by tenths of a percent.',
};

export interface BloatMeasurementRow {
  requestId: number;
  schema: string;
  table: string;
  mode: BloatMode;
  state: BloatState;
  requestedBy: string;
  requestedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  tableBytes: number | null;
  tupleCount: number | null;
  tupleBytes: number | null;
  deadCount: number | null;
  deadBytes: number | null;
  freeBytes: number | null;
  freePct: number | null;
  deadPct: number | null;
  estimatedPct: number | null;
}
