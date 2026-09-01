import { query } from './db';
import { logConsoleEvent } from './users';
import type { BloatMeasurementRow, BloatMode, BloatState } from './bloat-types';

export type { BloatMeasurementRow, BloatMode, BloatState } from './bloat-types';
export { BLOAT_MODE_LABEL, BLOAT_MODE_HINT } from './bloat-types';

/**
 * Bloat medido con pgstattuple, visto desde la consola.
 *
 * Igual que con el EXPLAIN: la consola encarga la medición y espera; el único
 * proceso con credenciales de las instancias monitoreadas es el colector. Y
 * aquí importa más que allá, porque una medición exacta es un escaneo completo
 * de la tabla y no algo que convenga lanzar por accidente desde un navegador.
 */

const COLUMNS = `request_id, schema_name, table_name, mode, state, requested_by, requested_at,
                 finished_at, error, table_bytes, tuple_count, tuple_bytes, dead_count,
                 dead_bytes, free_bytes, free_pct, dead_pct, estimated_pct`;

function toRow(row: Record<string, unknown>): BloatMeasurementRow {
  const n = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return {
    requestId: Number(row['request_id']),
    schema: String(row['schema_name']),
    table: String(row['table_name']),
    mode: String(row['mode']) as BloatMode,
    state: String(row['state']) as BloatState,
    requestedBy: String(row['requested_by']),
    requestedAt: new Date(row['requested_at'] as string),
    finishedAt: row['finished_at'] ? new Date(row['finished_at'] as string) : null,
    error: row['error'] ? String(row['error']) : null,
    tableBytes: n('table_bytes'),
    tupleCount: n('tuple_count'),
    tupleBytes: n('tuple_bytes'),
    deadCount: n('dead_count'),
    deadBytes: n('dead_bytes'),
    freeBytes: n('free_bytes'),
    freePct: n('free_pct'),
    deadPct: n('dead_pct'),
    estimatedPct: n('estimated_pct'),
  };
}

/**
 * Encola una medición.
 *
 * Se reutiliza un encargo idéntico reciente por la misma razón que en los
 * planes, sólo que con más motivo: apretar dos veces el botón no debe provocar
 * dos escaneos secuenciales de la misma tabla.
 */
export async function requestBloat(
  instanceId: number,
  schema: string,
  table: string,
  mode: BloatMode,
  username: string,
  estimatedPct: number | null,
): Promise<number> {
  const pending = await query(
    `select request_id from buho.bloat_requests
      where instance_id = $1 and schema_name = $2 and table_name = $3
        and (state in ('pendiente', 'corriendo')
             or (state = 'listo' and finished_at > now() - interval '1 minute'))
      order by requested_at desc limit 1`,
    [instanceId, schema, table],
  );
  const existing = pending[0];
  if (existing) return Number(existing['request_id']);

  const rows = await query(
    `insert into buho.bloat_requests
            (instance_id, schema_name, table_name, mode, requested_by, estimated_pct)
          values ($1, $2, $3, $4, $5, $6)
       returning request_id`,
    [instanceId, schema, table, mode, username, estimatedPct],
  );

  await logConsoleEvent(
    username,
    `pgstattuple:${mode}`,
    `instancia ${instanceId} · ${schema}.${table}`,
  );

  return Number(rows[0]?.['request_id']);
}

export async function getBloatRequest(requestId: number): Promise<BloatMeasurementRow | null> {
  const rows = await query(`select ${COLUMNS} from buho.bloat_requests where request_id = $1`, [
    requestId,
  ]);
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * Últimas mediciones de una instancia, una por tabla.
 *
 * La pantalla de vacuum muestra la estimate de todas las tablas y, al lado, la
 * medida real de las que alguien pidió medir. Así se ve de un golpe cuánto se
 * equivocaba la estimate en ese servidor concreto, que es la única forma de
 * saber si hay que confiar en ella.
 */
export async function getLatestBloat(instanceId: number): Promise<Map<string, BloatMeasurementRow>> {
  const rows = await query(
    `select distinct on (schema_name, table_name) ${COLUMNS}
       from buho.bloat_requests
      where instance_id = $1
      order by schema_name, table_name, requested_at desc`,
    [instanceId],
  );
  const mapa = new Map<string, BloatMeasurementRow>();
  for (const row of rows) {
    const medicion = toRow(row);
    mapa.set(`${medicion.schema}.${medicion.table}`, medicion);
  }
  return mapa;
}

/** Historial completo, para la tarjeta que explica lo que ya se midió. */
export async function getBloatHistory(
  instanceId: number,
  limit = 20,
): Promise<BloatMeasurementRow[]> {
  const rows = await query(
    `select ${COLUMNS} from buho.bloat_requests
      where instance_id = $1
      order by requested_at desc limit $2`,
    [instanceId, limit],
  );
  return rows.map(toRow);
}

/**
 * ¿Se puede medir en esta instancia?
 *
 * La consola sólo sabe qué extensiones hay instaladas, porque es lo que el
 * colector guarda al sondear. El permiso de ejecutar la función depende del rol
 * y de la tabla concreta, así que no se adivina: si falta, la medición falla y
 * el error de PostgreSQL aparece en la celda, que dice más que cualquier
 * comprobación previa.
 */
export async function getPgstattupleState(
  instanceId: number,
): Promise<{ executable: boolean; reason: string | null }> {
  const rows = await query(
    `select extensions ? 'pgstattuple' as instalada
       from buho.instance_capabilities where instance_id = $1`,
    [instanceId],
  );

  if (rows[0]?.['instalada'] === true) return { executable: true, reason: null };
  return {
    executable: false,
    reason:
      'The pgstattuple extension is not installed on this instance. Install with ' +
      'CREATE EXTENSION pgstattuple; it ships in contrib and does not require a server restart.',
  };
}

export function hasPending(mediciones: Iterable<BloatMeasurementRow>): boolean {
  for (const medicion of mediciones) {
    if (medicion.state === 'pendiente' || medicion.state === 'corriendo') return true;
  }
  return false;
}
