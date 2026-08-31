/**
 * Piezas de la rejilla que también necesita el navegador.
 *
 * Viven aparte de `heatmap.ts` porque ese módulo abre el store, y arrastrar el
 * cliente de PostgreSQL al paquete del navegador rompe la compilación. La
 * frontera es la misma que ya se aplicó al bloat: los tipos y las constantes de
 * presentación son compartidos, el acceso a datos no.
 */

export interface HeatCell {
  /** 0 = domingo, para coincidir con `extract(dow)` de PostgreSQL. */
  weekday: number;
  hour: number;
  value: number;
  /** Cuántas horas distintas se agregaron; con pocas, la celda no es fiable. */
  samples: number;
}

export const WEEKDAY_LABEL = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
