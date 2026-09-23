/**
 * Bloat medido, no estimado.
 *
 * La pantalla de vacuum estima el espacio desperdiciado a partir del ancho
 * promedio de tupla que guarda `pg_stats`. Es honesto y gratis, pero se
 * equivoca en los dos sentidos: con filas de tamaño muy variable el promedio no
 * representa a nadie, y con TOAST el ancho que ve el planificador no es el que
 * ocupa el heap.
 *
 * `pgstattuple` no estima: cuenta. El precio es leer la tabla entera, así que
 * esto no puede correr solo cada cinco minutos —sería un escaneo secuencial
 * periódico sobre las tablas más grandes del cliente, exactamente lo que un DBA
 * no quiere que le haga su monitor—. Corre cuando alguien lo pide, sobre la
 * tabla que pide, y de a una.
 *
 * Hay dos modos:
 *
 * - `exacto` usa `pgstattuple()`: lee cada página y cada tupla. Es la verdad.
 * - `aproximado` usa `pgstattuple_approx()`: salta las páginas que el mapa de
 *   visibilidad marca como todas visibles, así que sólo paga por lo sucio.
 *   Suele costar una fracción y el error queda en décimas de punto.
 */
import type { Pool } from 'pg';

import { tagged } from './tag';

export type BloatMode = 'exacto' | 'aproximado';

export interface BloatMeasurement {
  tableBytes: number;
  tupleCount: number;
  tupleBytes: number;
  deadCount: number;
  deadBytes: number;
  freeBytes: number;
  freePct: number;
  deadPct: number;
}

/** Si la extensión está instalada, y si el rol la puede ejecutar. */
export interface PgstattupleState {
  installed: boolean;
  /**
   * `pgstattuple` es `SECURITY INVOKER` y exige ser dueño de la tabla o miembro
   * de `pg_stat_scan_tables`. Un rol con sólo `pg_monitor` no lo hereda, y ese
   * es el caso normal del usuario de monitoreo que documentamos.
   */
  executable: boolean;
  schema: string | null;
  reason: string | null;
}

export async function inspectPgstattuple(pool: Pool): Promise<PgstattupleState> {
  const { rows } = await pool.query<{ nspname: string | null }>(
    tagged(`select n.nspname
              from pg_extension e
              join pg_namespace n on n.oid = e.extnamespace
             where e.extname = 'pgstattuple'`),
  );

  const schema = rows[0]?.nspname ?? null;
  if (!schema) {
    return {
      installed: false,
      executable: false,
      schema: null,
      reason:
        'la extensión pgstattuple no está instalada. Se instala con ' +
        'CREATE EXTENSION pgstattuple; viene en contrib y no requiere reiniciar.',
    };
  }

  // Se pregunta por el permiso en vez de deducirlo de los roles: la respuesta
  // depende de la tabla concreta, pero si ni la función se puede ejecutar no
  // hace falta llegar tan lejos.
  const permiso = await pool.query<{ ok: boolean }>(
    tagged(`select has_function_privilege(
              current_user, format('%I.pgstattuple(regclass)', $1::text), 'execute') as ok`),
    [schema],
  );

  const ok = permiso.rows[0]?.ok === true;
  return {
    installed: true,
    executable: ok,
    schema,
    reason: ok
      ? null
      : 'el rol de monitoreo no puede ejecutar pgstattuple. Se arregla con ' +
        'GRANT pg_stat_scan_tables TO buho_monitor; da lectura de estadísticas, no de datos.',
  };
}

/**
 * Mide una tabla. `schema` y `table` se pasan por parámetro y se resuelven con
 * `%I.%I`, así que un nombre con comillas o un punto no puede convertirse en
 * otra consulta.
 */
export async function measureBloat(
  pool: Pool,
  schema: string,
  table: string,
  mode: BloatMode,
  timeoutMs: number,
): Promise<BloatMeasurement> {
  const client = await pool.connect();
  try {
    // Sin timeout, un `exacto` sobre una tabla enorme deja el colector clavado
    // en una sola instancia. Con timeout el error dice qué pasó y se puede
    // reintentar en modo aproximado. SET LOCAL requires an open transaction.
    await client.query('begin');
    await client.query(tagged(`set local statement_timeout = ${Math.max(1000, Math.trunc(timeoutMs))}`));

    const funcion = mode === 'exacto' ? 'pgstattuple' : 'pgstattuple_approx';
    const { rows } = await client.query<Record<string, string | number>>(
      tagged(`select * from ${funcion}(format('%I.%I', $1::text, $2::text)::regclass)`),
      [schema, table],
    );

    const row = rows[0];
    if (!row) throw new Error(`${funcion} no devolvió filas para ${schema}.${table}`);

    const n = (key: string): number => {
      const value = row[key];
      return value === undefined || value === null ? 0 : Number(value);
    };

    // Las dos funciones no traen las mismas columnas: la aproximada llama
    // `approx_tuple_count` a lo que la exacta llama `tuple_count`, y no reporta
    // `dead_tuple_percent`. Se normaliza acá para que la cola guarde una sola
    // forma y la consola no tenga que saber en qué modo se midió.
    const tableBytes = n('table_len');
    const tupleCount = mode === 'exacto' ? n('tuple_count') : n('approx_tuple_count');
    const tupleBytes = mode === 'exacto' ? n('tuple_len') : n('approx_tuple_len');
    const deadCount = n('dead_tuple_count');
    const deadBytes = n('dead_tuple_len');
    const freeBytes = mode === 'exacto' ? n('free_space') : n('approx_free_space');
    const freePct = mode === 'exacto' ? n('free_percent') : n('approx_free_percent');
    const deadPct = tableBytes > 0 ? (deadBytes / tableBytes) * 100 : 0;

    await client.query('rollback');
    return { tableBytes, tupleCount, tupleBytes, deadCount, deadBytes, freeBytes, freePct, deadPct };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
