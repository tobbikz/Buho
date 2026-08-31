import { statementObjects, type FlowWeight, type StatementOperation } from '@buho/core';
import { query } from './db';

/**
 * De dónde a dónde va el tráfico de la base.
 *
 * Tres columnas: **rol → esquema → tabla**. El ancho de cada cinta es el peso
 * elegido (filas, tiempo o llamadas), así que de un vistazo se ve dónde cae el
 * volumen y por culpa de quién.
 *
 * La atribución sale de cruzar dos fuentes que ninguna sirve sola:
 * `statement_stats` sabe el rol, las llamadas, las filas y el tiempo pero no la
 * tabla; el texto de la consulta sabe la tabla pero no cuánto se ejecutó. El
 * cruce es aproximado —es análisis léxico del texto, no un parser— y la pantalla
 * lo dice con el porcentaje atribuido al lado.
 *
 * El contraste honesto está en los contadores de `table_tup_*`, que vienen del
 * propio PostgreSQL: si la suma atribuida no cuadra con ellos, la diferencia se
 * muestra en vez de esconderse. Las causas normales de que no cuadre son
 * triggers, cascadas de claves foráneas y consultas que se cayeron de
 * `pg_stat_statements` por presión de memoria.
 */

export interface FlowNode {
  name: string;
  /** En qué columna va: 0 rol, 1 esquema, 2 tabla. */
  depth: 0 | 1 | 2;
  /** Nombre corto para dibujar; el completo va en el tooltip. */
  label: string;
}

export interface FlowLink {
  source: number;
  target: number;
  value: number;
}

export interface FlowTable {
  relation: string;
  schema: string;
  rows: number;
  calls: number;
  execMs: number;
  /** Qué operaciones la tocaron y con qué peso. */
  byOperation: Partial<Record<StatementOperation, number>>;
  /** Los actores que la tocaron: roles o aplicaciones, según lo elegido. */
  roles: string[];
}

export interface FlowResult {
  nodes: FlowNode[];
  links: FlowLink[];
  tables: FlowTable[];
  /** Consultas consideradas y cuántas se pudieron atribuir a una tabla. */
  statements: number;
  attributed: number;
  /** Peso total atribuido y peso total observado, para poder comparar. */
  weightAttributed: number;
  weightTotal: number;
  /**
   * Del peso atribuido a tablas, cuánto además se pudo asignar a una aplicación
   * concreta. Sólo tiene sentido con el actor en 'aplicacion', y es el número
   * que dice si el muestreo alcanzó a ver el trabajo o se lo perdió.
   */
  weightWithActor: number;
}

/**
 * Esquemas del sistema, en los tres motores.
 *
 * El tráfico contra ellos es del propio monitoreo y de las herramientas de
 * administración, y llenaría el diagrama sin decir nada del sistema del cliente.
 * En MariaDB la exclusión hace más falta que en PostgreSQL: sus digests pierden
 * el comentario con el que Búho marca sus consultas, así que sus propias lecturas
 * de `information_schema` sí aparecen en las estadísticas.
 */
const SYSTEM_SCHEMAS = new Set([
  'pg_catalog',
  'information_schema',
  'performance_schema',
  'mysql',
  'sys',
]);

/** Qué operaciones cuentan como escritura. */
const WRITES: StatementOperation[] = ['insert', 'update', 'delete', 'copy', 'truncate'];

export type FlowDirection = 'escritura' | 'lectura';

/**
 * Quién es el actor de la primera columna.
 *
 * El rol es exacto: `pg_stat_statements` lo guarda. La aplicación es una
 * estimación por muestreo de `pg_stat_activity`, porque el nombre de aplicación
 * no vive en las estadísticas acumuladas. Se ofrecen las dos porque contestan
 * preguntas distintas: el rol dice a quién quitarle permisos, la aplicación dice
 * a qué equipo llamar.
 */
export type FlowActor = 'rol' | 'aplicacion';

/**
 * Reparto de cada consulta entre aplicaciones, según las veces que se vio a
 * cada una ejecutándola.
 *
 * Si `portal-web` se vio 30 veces y `etl-nocturno` 10 con la misma consulta, el
 * peso de esa consulta se parte 75/25. Es proporcional a las observaciones y no
 * al número de aplicaciones, porque lo que se está estimando es cuánto del
 * trabajo total le toca a cada una.
 */
async function actorShares(
  instanceId: number,
  minutes: number,
): Promise<Map<string, { application: string; share: number }[]>> {
  const rows = await query<{ queryid: string; application: string; samples: number }>(
    `select queryid::text as queryid, application, sum(samples) as samples
       from buho.query_actors
      where instance_id = $1
        and ts > now() - ($2 || ' minutes')::interval
      group by 1, 2`,
    [instanceId, minutes],
  );

  const porConsulta = new Map<string, { application: string; samples: number }[]>();
  for (const fila of rows) {
    const lista = porConsulta.get(fila.queryid) ?? [];
    lista.push({ application: fila.application, samples: Number(fila.samples) });
    porConsulta.set(fila.queryid, lista);
  }

  const reparto = new Map<string, { application: string; share: number }[]>();
  for (const [queryid, lista] of porConsulta) {
    const total = lista.reduce((suma, entrada) => suma + entrada.samples, 0);
    if (total <= 0) continue;
    reparto.set(
      queryid,
      lista.map((entrada) => ({
        application: entrada.application,
        share: entrada.samples / total,
      })),
    );
  }
  return reparto;
}

/**
 * Arma el flujo de una instancia.
 *
 * `direction` decide qué lado se mira: en escritura la tabla es el destino del
 * DML; en lectura son todas las tablas que aparecen en `from` y `join`. Las dos
 * preguntas son distintas y no conviene mezclarlas en un solo diagrama: una
 * cinta de lectura y una de escritura del mismo grosor no significan lo mismo
 * para el servidor.
 */
/**
 * Esquema por omisión de cada motor, para los nombres sin calificar.
 *
 * En MariaDB no hay esquemas dentro de la base, así que el papel lo hace el
 * nombre de la base; se resuelve por consulta, porque una misma instancia puede
 * tener varias. PostgreSQL y SQL Server sí tienen un valor fijo razonable.
 */
function defaultSchemaFor(engine: string, database: string | null): string | null {
  if (engine === 'postgres') return 'public';
  if (engine === 'mssql') return 'dbo';
  if (engine === 'mariadb') return database ?? null;
  return null;
}

export async function getFlow(
  instanceId: number,
  minutes: number,
  weight: FlowWeight,
  direction: FlowDirection,
  engine = 'postgres',
  actor: FlowActor = 'rol',
  topTables = 14,
): Promise<FlowResult> {
  const rows = await query<{
    queryid: string;
    username: string | null;
    calls: number;
    exec_ms: number;
    rows: number;
    query: string | null;
    database: string | null;
  }>(
    `select s.queryid::text as queryid,
            coalesce(s.username, '(sin rol)') as username,
            max(s.database) as database,
            sum(s.calls)   as calls,
            sum(s.exec_ms) as exec_ms,
            sum(s.rows)    as rows,
            max(t.query)   as query
       from buho.statement_stats s
       left join buho.statement_texts t
              on t.instance_id = s.instance_id and t.queryid = s.queryid
      where s.instance_id = $1
        and s.ts > now() - ($2 || ' minutes')::interval
        -- Las consultas del propio Búho se excluyen siempre, no de forma
        -- opcional como en la pantalla de consultas: aquí no aportan nada y
        -- desplazan del diagrama a las tablas del cliente, que es lo único que
        -- esta pantalla existe para mostrar. La marca va al final del texto.
        and (t.query is null or t.query not like '%/* buho */%')
      group by s.queryid, coalesce(s.username, '(sin rol)')`,
    [instanceId, minutes],
  );

  const reparto = actor === 'aplicacion' ? await actorShares(instanceId, minutes) : null;

  const pesoDe = (fila: { calls: number; exec_ms: number; rows: number }): number => {
    if (weight === 'calls') return Number(fila.calls);
    if (weight === 'time') return Number(fila.exec_ms);
    return Number(fila.rows);
  };

  // Se acumula por (rol, tabla) y por tabla. Un mapa intermedio en vez de SQL
  // porque la tabla sale de analizar el texto en JavaScript, no del store.
  const porRolTabla = new Map<string, number>();
  const porTabla = new Map<string, FlowTable>();
  let atribuidas = 0;
  let pesoAtribuido = 0;
  let pesoTotal = 0;
  let pesoConActor = 0;

  for (const fila of rows) {
    const peso = pesoDe(fila);
    pesoTotal += peso;
    if (!fila.query || peso <= 0) continue;

    const objetos = statementObjects(fila.query, defaultSchemaFor(engine, fila.database));
    const relaciones =
      direction === 'escritura'
        ? WRITES.includes(objetos.operation) && objetos.target
          ? [objetos.target]
          : []
        : objetos.operation === 'select' || objetos.operation === 'copy'
          ? objetos.sources
          : objetos.sources;

    const utiles = relaciones.filter(
      (relacion) => !SYSTEM_SCHEMAS.has(relacion.split('.')[0] ?? ''),
    );
    if (utiles.length === 0) continue;

    atribuidas += 1;
    if (actor === 'rol' || reparto?.has(fila.queryid)) pesoConActor += peso;
    // Cuando una consulta lee cinco tablas, el peso se reparte: cargar el total
    // a cada una multiplicaría el tráfico por cinco y el diagrama mentiría sobre
    // el volumen absoluto.
    const porcion = peso / utiles.length;
    pesoAtribuido += peso;

    // Con atribución por aplicación una misma consulta puede repartirse entre
    // varias; sin observaciones para ella, cae en un actor explícito en vez de
    // desaparecer del diagrama, porque el trabajo existió aunque no se viera
    // quién lo pedía.
    const actores: { nombre: string; peso: number }[] =
      actor === 'aplicacion'
        ? (reparto?.get(fila.queryid)?.map((entrada) => ({
            nombre: entrada.application,
            peso: entrada.share,
          })) ?? [{ nombre: '(no observado)', peso: 1 }])
        : [{ nombre: fila.username ?? '(sin rol)', peso: 1 }];

    for (const relacion of utiles) {
      for (const quien of actores) {
        const clave = `${quien.nombre}\u0000${relacion}`;
        porRolTabla.set(clave, (porRolTabla.get(clave) ?? 0) + porcion * quien.peso);
      }
      const esquema = relacion.split('.')[0] ?? 'public';
      const existente = porTabla.get(relacion) ?? {
        relation: relacion,
        schema: esquema,
        rows: 0,
        calls: 0,
        execMs: 0,
        byOperation: {},
        roles: [],
      };
      existente.rows += Number(fila.rows) / utiles.length;
      existente.calls += Number(fila.calls) / utiles.length;
      existente.execMs += Number(fila.exec_ms) / utiles.length;
      existente.byOperation[objetos.operation] =
        (existente.byOperation[objetos.operation] ?? 0) + porcion;
      // La lista lleva los actores que se están usando, no siempre el rol: con
      // atribución por aplicación, ver «tomy.berrios» en la columna de
      // aplicaciones sería contradecir el selector que el usuario acaba de
      // mover.
      for (const quien of actores) {
        if (!existente.roles.includes(quien.nombre)) existente.roles.push(quien.nombre);
      }
      porTabla.set(relacion, existente);
    }
  }

  const pesoTabla = (tabla: FlowTable): number =>
    weight === 'calls' ? tabla.calls : weight === 'time' ? tabla.execMs : tabla.rows;

  const tablas = [...porTabla.values()].sort((a, b) => pesoTabla(b) - pesoTabla(a));
  const visibles = new Set(tablas.slice(0, topTables).map((tabla) => tabla.relation));

  // ------------------------------------------------------------- nodos y cintas
  const nodos: FlowNode[] = [];
  const indice = new Map<string, number>();
  const nodo = (clave: string, depth: 0 | 1 | 2, label: string): number => {
    const existente = indice.get(clave);
    if (existente !== undefined) return existente;
    const nuevo = nodos.length;
    nodos.push({ name: clave, depth, label });
    indice.set(clave, nuevo);
    return nuevo;
  };

  const rolEsquema = new Map<string, number>();
  const esquemaTabla = new Map<string, number>();

  for (const [clave, peso] of porRolTabla) {
    const [rol = '(sin rol)', relacion = ''] = clave.split('\u0000');
    if (!visibles.has(relacion)) continue;
    const esquema = relacion.split('.')[0] ?? 'public';

    const claveRolEsquema = `${rol}\u0000${esquema}`;
    rolEsquema.set(claveRolEsquema, (rolEsquema.get(claveRolEsquema) ?? 0) + peso);
    esquemaTabla.set(`${esquema}\u0000${relacion}`, (esquemaTabla.get(`${esquema}\u0000${relacion}`) ?? 0) + peso);
  }

  // Dos tablas con el mismo nombre en esquemas distintos son frecuentes (una
  // `customers` por cada origen, por ejemplo). Si la etiqueta fuera sólo el
  // nombre, quedarían dos nodos idénticos y el diagrama no se podría leer, así
  // que en ese caso se muestra el nombre calificado.
  const nombresRepetidos = new Set<string>();
  const vistos = new Set<string>();
  for (const relacion of visibles) {
    const corto = relacion.split('.').slice(1).join('.') || relacion;
    if (vistos.has(corto)) nombresRepetidos.add(corto);
    vistos.add(corto);
  }

  const enlaces: FlowLink[] = [];
  for (const [clave, peso] of rolEsquema) {
    const [rol = '', esquema = ''] = clave.split('\u0000');
    enlaces.push({
      source: nodo(`rol:${rol}`, 0, rol),
      target: nodo(`esquema:${esquema}`, 1, esquema),
      value: peso,
    });
  }
  for (const [clave, peso] of esquemaTabla) {
    const [esquema = '', relacion = ''] = clave.split('\u0000');
    enlaces.push({
      source: nodo(`esquema:${esquema}`, 1, esquema),
      target: nodo(
        `tabla:${relacion}`,
        2,
        (() => {
          const corto = relacion.split('.').slice(1).join('.') || relacion;
          return nombresRepetidos.has(corto) ? relacion : corto;
        })(),
      ),
      value: peso,
    });
  }

  return {
    nodes: nodos,
    links: enlaces,
    tables: tablas.slice(0, topTables),
    statements: rows.length,
    attributed: atribuidas,
    weightAttributed: pesoAtribuido,
    weightTotal: pesoTotal,
    weightWithActor: pesoConActor,
  };
}

/**
 * Lo que dicen los contadores del propio PostgreSQL, por tabla.
 *
 * Es el control de la atribución: estos números no dependen de haber entendido
 * el texto de ninguna consulta. Si el diagrama dice que una tabla recibe el 80 %
 * de las escrituras y el contador dice otra cosa, el contador tiene razón.
 */
export interface TableCounter {
  relation: string;
  inserted: number;
  updated: number;
  deleted: number;
  hotUpdated: number;
  seqScans: number;
  idxScans: number;
}

export async function getTableCounters(
  instanceId: number,
  minutes: number,
): Promise<TableCounter[]> {
  // Se usa el contador crudo y no la tasa derivada: sumar filas por segundo a lo
  // largo de una ventana no da filas, da una unidad que no significa nada. La
  // diferencia entre el máximo y el mínimo del acumulado sí es el total del
  // periodo. `greatest(..., 0)` cubre el caso del reset de estadísticas, donde
  // el contador vuelve a empezar y la resta saldría negativa.
  const rows = await query<{
    relation: string;
    metric: string;
    total: number;
  }>(
    `select (labels->>'schema') || '.' || (labels->>'table') as relation,
            metric,
            greatest(max(value) - min(value), 0) as total
       from buho.metric_samples
      where instance_id = $1
        and ts > now() - ($2 || ' minutes')::interval
        and metric in ('table_tup_inserted', 'table_tup_updated',
                       'table_tup_deleted', 'table_tup_hot_updated',
                       'table_seq_scans', 'table_idx_scans')
        and labels ? 'table'
      group by 1, 2`,
    [instanceId, minutes],
  );

  const mapa = new Map<string, TableCounter>();
  for (const fila of rows) {
    const actual = mapa.get(fila.relation) ?? {
      relation: fila.relation,
      inserted: 0,
      updated: 0,
      deleted: 0,
      hotUpdated: 0,
      seqScans: 0,
      idxScans: 0,
    };
    const valor = Number(fila.total);
    switch (fila.metric) {
      case 'table_tup_inserted':
        actual.inserted = valor;
        break;
      case 'table_tup_updated':
        actual.updated = valor;
        break;
      case 'table_tup_deleted':
        actual.deleted = valor;
        break;
      case 'table_tup_hot_updated':
        actual.hotUpdated = valor;
        break;
      case 'table_seq_scans':
        actual.seqScans = valor;
        break;
      case 'table_idx_scans':
        actual.idxScans = valor;
        break;
    }
    mapa.set(fila.relation, actual);
  }

  return [...mapa.values()].sort(
    (a, b) => b.inserted + b.updated + b.deleted - (a.inserted + a.updated + a.deleted),
  );
}
