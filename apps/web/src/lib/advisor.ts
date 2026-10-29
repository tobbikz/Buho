import { mergeSuggestions, suggestIndexes, type IndexSuggestion, type PlanNode } from '@buho/core';
import { query } from './db';

/**
 * Sugerencias de indexes a partir de los planes que ya están guardados.
 *
 * No se conecta a la instancia ni pide nada nuevo: lee `plan_requests`. Eso
 * limita el alcance a las consultas cuyo plan alguien pidió, y es una limitación
 * a propósito. Un sugeridor que opina sobre consultas que never vio produce
 * indexes imaginarios; uno que sólo habla de planes reales produce menos ideas y
 * todas verificables.
 */

export interface SuggestionsResult {
  suggestions: IndexSuggestion[];
  /** Cuántos planes se leyeron, para poder decir sobre qué se opina. */
  plansConsidered: number;
  /** Cuántos de ellos tenían filas reales (ANALYZE). */
  plansWithActuals: number;
  newestPlanAt: Date | null;
}

export async function getIndexSuggestions(
  instanceId: number,
  limit = 200,
): Promise<SuggestionsResult> {
  const rows = await query<{
    queryid: string | null;
    mode: string;
    plan: PlanNode | null;
    requested_at: Date;
  }>(
    `select queryid, mode, plan, requested_at
       from buho.plan_requests
      where instance_id = $1 and state = 'listo' and plan is not null
      order by requested_at desc
      limit $2`,
    [instanceId, limit],
  );

  const todas: IndexSuggestion[] = [];
  let conRowsReales = 0;

  for (const row of rows) {
    if (!row.plan) continue;
    // ANALYZE = strong evidence. estimate/generic (auto-plans) still yield
    // weaker Seq Scan+filter suggestions — labeled as such in the advisor.
    if (row.mode === 'analyze') {
      conRowsReales += 1;
      todas.push(...suggestIndexes(row.plan, row.queryid));
    } else if (row.mode === 'estimate' || row.mode === 'generic') {
      todas.push(...suggestIndexes(row.plan, row.queryid));
    }
  }

  return {
    suggestions: mergeSuggestions(todas),
    plansConsidered: rows.length,
    plansWithActuals: conRowsReales,
    newestPlanAt: rows[0]?.requested_at ?? null,
  };
}

/**
 * Findings de los chequeos que hablan de indexes de esta instancia.
 *
 * Es el contragolpe necesario a cualquier sugerencia: si los chequeos ya dicen
 * que hay indexes sin usar o duplicados, proponer uno más sin mencionarlo sería
 * dar la mitad del consejo.
 */
export async function getIndexFindings(
  instanceId: number,
): Promise<{ checkId: string; object: string; message: string }[]> {
  const rows = await query<{ check_id: string; object: string; message: string }>(
    `select distinct on (check_id, object) check_id, object, message
       from buho.check_results
      where instance_id = $1
        and check_id in (
          'unused_indexes', 'redundant_index_prefix',
          'mariadb_unused_indexes', 'mariadb_duplicate_indexes'
        )
        and ts > now() - interval '1 day'
      order by check_id, object, ts desc`,
    [instanceId],
  );
  return rows.map((row) => ({ checkId: row.check_id, object: row.object, message: row.message }));
}
