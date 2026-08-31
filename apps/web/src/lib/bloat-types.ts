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
  exacto: 'Medición exacta',
  aproximado: 'Medición aproximada',
};

export const BLOAT_MODE_HINT: Record<BloatMode, string> = {
  exacto:
    'Lee cada página y cada tupla de la tabla. Es la verdad, y cuesta un escaneo secuencial completo: en una tabla grande son minutos de I/O sobre la instancia monitoreada.',
  aproximado:
    'Salta las páginas que el mapa de visibilidad marca como limpias, así que sólo paga por lo que cambió. Suele costar una fracción del exacto y errar por décimas de punto.',
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
