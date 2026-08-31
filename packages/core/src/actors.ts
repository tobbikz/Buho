import type { Pool } from 'pg';
import { tagged } from './tag';

/**
 * Quién ejecuta cada consulta, por nombre de aplicación.
 *
 * `pg_stat_statements` acumula por consulta, base y rol, pero **no** guarda el
 * `application_name`, que es lo que de verdad distingue al ETL nocturno del
 * portal web cuando los dos entran con el mismo usuario. Ese dato sólo existe
 * en `pg_stat_activity`, que es una foto del instante: dice qué se está
 * ejecutando *ahora*, no cuánto se ejecutó.
 *
 * La unión de los dos es un muestreo: cada pocos segundos se mira quién está
 * activo y con qué `query_id`, y con esas observaciones se reparte después el
 * peso que `pg_stat_statements` sí midió. **Es una estimación**, y así se
 * presenta: una consulta que dura menos que el intervalo de muestreo puede no
 * aparecer nunca, y una que dura mucho aparece en varias fotos seguidas. A
 * cambio no cuesta nada —ya se consulta `pg_stat_activity` cada ciclo— y no
 * necesita ninguna extensión ni cambio en las aplicaciones.
 *
 * Requiere PostgreSQL 14 o más y `compute_query_id` encendido; con
 * `pg_stat_statements` cargado suele quedar en `auto`, que basta. Si no está,
 * la consola lo dice en vez de mostrar una atribución vacía.
 */

export interface ActorObservation {
  application: string;
  username: string;
  database: string;
  queryid: string;
  /** Cuántas veces se vio activa esta combinación. */
  samples: number;
}

/**
 * Sólo sesiones activas: una sesión `idle` no está ejecutando nada y contarla
 * atribuiría trabajo a quien está esperando. Se excluye la propia conexión del
 * monitor, y `query_id` nulo significa que la consulta no llegó a identificarse.
 */
const ACTORS_SQL = `
  select coalesce(nullif(application_name, ''), '(sin nombre)') as application,
         coalesce(usename, '(sin rol)')                         as username,
         coalesce(datname, '(sin base)')                        as database,
         query_id::text                                         as queryid,
         count(*)                                               as samples
    from pg_stat_activity
   where state = 'active'
     and query_id is not null
     and pid <> pg_backend_pid()
     and backend_type = 'client backend'
   group by 1, 2, 3, 4`;

export async function sampleActors(pool: Pool): Promise<ActorObservation[]> {
  const result = await pool.query<{
    application: string;
    username: string;
    database: string;
    queryid: string;
    samples: string;
  }>(tagged(ACTORS_SQL));

  return result.rows.map((row) => ({
    application: row.application,
    username: row.username,
    database: row.database,
    queryid: row.queryid,
    samples: Number(row.samples),
  }));
}

/**
 * Acumulador de observaciones entre escrituras al store.
 *
 * Muestrear cada cinco segundos y escribir cada vez produciría doce filas por
 * minuto y por combinación, casi todas idénticas. Se suman en memoria y se
 * vuelca una fila por minuto: la misma información con una fracción del
 * espacio, y el minuto es de sobra fino para una atribución que ya es
 * aproximada.
 */
export class ActorAccumulator {
  private readonly counts = new Map<string, ActorObservation>();

  add(observations: ActorObservation[]): void {
    for (const observation of observations) {
      const clave = `${observation.application}\u0000${observation.username}\u0000${observation.database}\u0000${observation.queryid}`;
      const existente = this.counts.get(clave);
      if (existente) existente.samples += observation.samples;
      else this.counts.set(clave, { ...observation });
    }
  }

  /** Devuelve lo acumulado y deja el acumulador vacío. */
  drain(): ActorObservation[] {
    const salida = [...this.counts.values()];
    this.counts.clear();
    return salida;
  }

  get size(): number {
    return this.counts.size;
  }
}

/**
 * Si esta instancia puede atribuir por aplicación, y si no, por qué.
 *
 * Se devuelve el motivo para poder escribirlo en la pantalla: "sin datos" y
 * "esta versión no lo soporta" llevan a acciones distintas.
 */
export interface ActorSupport {
  available: boolean;
  reason: string | null;
}

export async function inspectActors(pool: Pool, versionNum: number): Promise<ActorSupport> {
  if (versionNum < 140000) {
    return {
      available: false,
      reason: 'pg_stat_activity.query_id existe desde PostgreSQL 14',
    };
  }

  const result = await pool.query<{ compute: string; libraries: string }>(
    tagged(`select current_setting('compute_query_id')        as compute,
                   current_setting('shared_preload_libraries') as libraries`),
  );
  const compute = result.rows[0]?.compute ?? 'off';
  const libraries = result.rows[0]?.libraries ?? '';

  if (compute === 'off' || compute === 'regress') {
    return {
      available: false,
      reason: `compute_query_id está en '${compute}': sin identificador de consulta no se puede cruzar con pg_stat_statements`,
    };
  }

  // 'auto' significa "sólo si alguien lo pide", y quien lo pide es
  // pg_stat_statements. Sin él precargado, el identificador queda nulo en cada
  // fila y el muestreo no recogería nada: hay que decirlo, porque una pantalla
  // vacía se lee como "nadie usa esta base" y no como "falta configuración".
  if (compute === 'auto' && !libraries.includes('pg_stat_statements')) {
    return {
      available: false,
      reason:
        "compute_query_id está en 'auto' pero pg_stat_statements no está precargado, " +
        'así que nadie calcula el identificador de consulta',
    };
  }

  return { available: true, reason: null };
}
