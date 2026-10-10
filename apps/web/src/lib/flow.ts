import { statementObjects, type FlowWeight, type StatementOperation } from '@buho/core';
import { query } from './db';
import { buildHotTablesSankey, tableHeat } from './flow-graph';

/**
 * De dónde a dónde va el tráfico de la base.
 *
 * Tres columnas: **rol → esquema → tabla**. El ancho de cada cinta es el peso
 * elegido (filas, tiempo o llamadas), así que de un vistazo se ve dónde cae el
 * volumen y por culpa de who.
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
  /** Column index in the Sankey (0 = source, last = tables). */
  depth: number;
  /** Short label drawn on the chart. */
  label: string;
}

export interface FlowLink {
  source: number;
  target: number;
  value: number;
  kind?: 'write' | 'read';
}

export interface FlowTable {
  relation: string;
  schema: string;
  rows: number;
  calls: number;
  execMs: number;
  writeWeight: number;
  readWeight: number;
  /** Qué operaciones la tocaron y con qué peso. */
  byOperation: Partial<Record<StatementOperation, number>>;
  /** Apps or roles that touched this table. */
  roles: string[];
}

export interface FlowResult {
  nodes: FlowNode[];
  links: FlowLink[];
  tables: FlowTable[];
  /** Every attributed table — use for ORM; `tables` is capped for Sankey UI. */
  allTables: FlowTable[];
  /** Consultas consideradas y cuántas se pudieron atribuir a una tabla. */
  statements: number;
  attributed: number;
  /** Peso total atribuido y peso total observado, para poder comparar. */
  weightAttributed: number;
  weightTotal: number;
  /**
   * Del peso atribuido a tablas, cuánto además se pudo asignar a una aplicación
   * concreta. Sólo tiene sentido con el actor en 'aplicacion', y es el número
   * que dice si el sampling alcanzó a ver el trabajo o se lo perdió.
   */
  weightWithActor: number;
  writeTotal: number;
  readTotal: number;
  /**
   * When the instance catalog (`vacuum_tables`) is known, lexical hits outside
   * it are dropped so crowns never promote foreign-schema guesses.
   */
  catalogGated: boolean;
  /** Relations dropped for not being in the inventoried catalog. */
  droppedOutsideCatalog: number;
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

/** Attribute writes only, reads only, or both (default for Flow UI). */
export type FlowMode = 'both' | FlowDirection;

/**
 * Quién es el actor de la primera columna.
 *
 * El rol es exacto: `pg_stat_statements` lo guarda. La aplicación es una
 * estimate por sampling de `pg_stat_activity`, porque el nombre de aplicación
 * no vive en las estadísticas acumuladas. Se ofrecen las dos porque contestan
 * preguntas distintas: el rol dice a who quitarle permisos, la aplicación dice
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
  mode: FlowMode = 'both',
  engine = 'postgres',
  actor: FlowActor = 'aplicacion',
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
            coalesce(s.username, '(no role)') as username,
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
      group by s.queryid, coalesce(s.username, '(no role)')`,
    [instanceId, minutes],
  );

  const reparto = actor === 'aplicacion' ? await actorShares(instanceId, minutes) : null;

  // Inventoried relations for this instance — lexical attribution is a guess and
  // must not crown tables from other databases/schemas that happen to appear in SQL text.
  const catalogRows = await query<{ relation: string }>(
    `select schema_name || '.' || table_name as relation
       from buho.vacuum_tables
      where instance_id = $1
        and schema_name not in ('pg_catalog', 'information_schema', 'pg_toast', 'sys', 'mysql', 'performance_schema')`,
    [instanceId],
  ).catch(() => [] as { relation: string }[]);
  const catalog = new Set(catalogRows.map((r) => r.relation));
  const catalogGated = catalog.size > 0;
  let droppedOutsideCatalog = 0;

  /** Map a lexical hit onto an inventoried relation, or null if outside catalog. */
  const resolveCatalog = (relacion: string): string | null => {
    if (!catalogGated) return relacion;
    if (catalog.has(relacion)) return relacion;
    const bare = relacion.includes('.') ? relacion.slice(relacion.indexOf('.') + 1) : relacion;
    const matches = [...catalog].filter((known) => known === bare || known.endsWith(`.${bare}`));
    // Ambiguous bare name across schemas → drop rather than guess wrong schema.
    if (matches.length === 1) return matches[0]!;
    return null;
  };

  const pesoDe = (fila: { calls: number; exec_ms: number; rows: number }): number => {
    if (weight === 'calls') return Number(fila.calls);
    if (weight === 'time') return Number(fila.exec_ms);
    return Number(fila.rows);
  };

  // Se acumula por (rol, tabla) y por tabla. Un mapa intermedio en vez de SQL
  // porque la tabla sale de analizar el texto en JavaScript, no del store.
  const porTabla = new Map<string, FlowTable>();
  let atribuidas = 0;
  let pesoAtribuido = 0;
  let pesoTotal = 0;
  let pesoConActor = 0;
  let writeTotal = 0;
  let readTotal = 0;

  const includeWrites = mode === 'both' || mode === 'escritura';
  const includeReads = mode === 'both' || mode === 'lectura';

  for (const fila of rows) {
    const peso = pesoDe(fila);
    pesoTotal += peso;
    if (!fila.query || peso <= 0) continue;

    const objetos = statementObjects(fila.query, defaultSchemaFor(engine, fila.database));
    const writeTargets =
      includeWrites && WRITES.includes(objetos.operation) && objetos.target ? [objetos.target] : [];
    const readTargets =
      includeReads && (objetos.operation === 'select' || objetos.operation === 'copy')
        ? objetos.sources
        : [];

    const resolveList = (rels: string[]): string[] => {
      const out: string[] = [];
      for (const relacion of rels) {
        if (SYSTEM_SCHEMAS.has(relacion.split('.')[0] ?? '')) continue;
        const resolved = resolveCatalog(relacion);
        if (resolved === null) {
          droppedOutsideCatalog += 1;
          continue;
        }
        out.push(resolved);
      }
      return out;
    };

    const writeResolved = resolveList(writeTargets);
    const readResolved = resolveList(readTargets);
    if (writeResolved.length === 0 && readResolved.length === 0) continue;

    atribuidas += 1;
    if (actor === 'rol' || reparto?.has(fila.queryid)) pesoConActor += peso;

    const actores: { nombre: string; peso: number }[] =
      actor === 'aplicacion'
        ? (reparto?.get(fila.queryid)?.map((entrada) => ({
            nombre: entrada.application,
            peso: entrada.share,
          })) ?? [{ nombre: '(not observed)', peso: 1 }])
        : [{ nombre: fila.username ?? '(no role)', peso: 1 }];

    const writeSet = new Set(writeResolved);
    const readSet = new Set(readResolved);
    const writeCount = writeSet.size;
    const readCount = readSet.size;
    if (writeCount === 0 && readCount === 0) continue;

    const writePorcion = writeCount > 0 ? peso / writeCount : 0;
    const readPorcion = readCount > 0 ? peso / readCount : 0;
    pesoAtribuido += writePorcion * writeCount + readPorcion * readCount;
    writeTotal += writePorcion * writeCount;
    readTotal += readPorcion * readCount;

    const touch = (relacion: string, porcion: number, kind: 'write' | 'read') => {
      const esquema = relacion.split('.')[0] ?? 'public';
      const existente = porTabla.get(relacion) ?? {
        relation: relacion,
        schema: esquema,
        rows: 0,
        calls: 0,
        execMs: 0,
        writeWeight: 0,
        readWeight: 0,
        byOperation: {},
        roles: [],
      };
      existente.rows += Number(fila.rows) * (porcion / peso);
      existente.calls += Number(fila.calls) * (porcion / peso);
      existente.execMs += Number(fila.exec_ms) * (porcion / peso);
      if (kind === 'write') existente.writeWeight += porcion;
      else existente.readWeight += porcion;
      existente.byOperation[objetos.operation] =
        (existente.byOperation[objetos.operation] ?? 0) + porcion;
      for (const quien of actores) {
        if (!existente.roles.includes(quien.nombre)) existente.roles.push(quien.nombre);
      }
      porTabla.set(relacion, existente);
    };

    for (const relacion of writeSet) touch(relacion, writePorcion, 'write');
    for (const relacion of readSet) touch(relacion, readPorcion, 'read');
  }

  const tablas = [...porTabla.values()].sort((a, b) => tableHeat(b, weight) - tableHeat(a, weight));
  const graph =
    mode === 'both'
      ? buildHotTablesSankey(tablas, topTables, weight)
      : buildHotTablesSankey(
          tablas,
          topTables,
          weight,
        );

  return {
    nodes: graph.nodes,
    links: graph.links,
    tables: tablas.slice(0, topTables),
    allTables: tablas,
    statements: rows.length,
    attributed: atribuidas,
    weightAttributed: pesoAtribuido,
    weightTotal: pesoTotal,
    weightWithActor: pesoConActor,
    writeTotal,
    readTotal,
    catalogGated,
    droppedOutsideCatalog,
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
  // Se usa el contador crudo y no la tasa derivada: sumar filas per second a lo
  // largo de una window no da filas, da una unidad que no significa nada. La
  // diferencia entre el max y el min del acumulado sí es el total del
  // periodo. `greatest(..., 0)` cubre el caso del reset de estadísticas, donde
  // el contador vuelve a empezar y la resta saldría negativa.
  //
  // When vacuum_tables is known for this instance, only show those relations —
  // metric_samples can retain cross-DB label noise from earlier collector bugs.
  const catalogRows = await query<{ relation: string }>(
    `select schema_name || '.' || table_name as relation
       from buho.vacuum_tables
      where instance_id = $1
        and schema_name not in ('pg_catalog', 'information_schema', 'pg_toast', 'sys', 'mysql', 'performance_schema')`,
    [instanceId],
  ).catch(() => [] as { relation: string }[]);
  const catalog = new Set(catalogRows.map((r) => r.relation));

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
    if (catalog.size > 0 && !catalog.has(fila.relation)) continue;
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

/**
 * Contra qué se compara "mucho tráfico" en el lienzo vivo.
 *
 * Un lienzo que se normaliza contra sí mismo no informa: cualquier tráfico
 * estable llega al max de brillo y duplicar la carga no cambia nada. La
 * referencia tiene que venir de fuera del instante, y lo honesto es la propia
 * historia de la instancia: el percentil 90 de las tasas de los últimos días.
 *
 * Se usa p90 y no el max porque un pico único —una carga masiva, una
 * migración— dejaría el lienzo apagado para siempre; y se usa la historia de la
 * instancia y no un número fijo porque cincuenta filas per second son mucho en
 * una base pequeña y nada en un datalake.
 */
export async function referenceRate(
  instanceId: number,
  weight: FlowWeight,
  days = 7,
): Promise<number> {
  const columna = weight === 'calls' ? 'calls' : weight === 'time' ? 'exec_ms' : 'rows';

  const filas = await query<{ referencia: number | null }>(
    `with por_minuto as (
       select date_trunc('minute', s.ts) as minuto,
              sum(s.${columna})          as peso
         from buho.statement_stats s
         left join buho.statement_texts t
                on t.instance_id = s.instance_id and t.queryid = s.queryid
        where s.instance_id = $1
          and s.ts > now() - ($2 || ' days')::interval
          and (t.query is null or t.query not like '%/* buho */%')
        group by 1
     )
     select percentile_cont(0.9) within group (order by peso / 60.0) as referencia
       from por_minuto
      where peso > 0`,
    [instanceId, days],
  );

  const referencia = Number(filas[0]?.referencia ?? 0);
  // Un suelo min: sin historia, o con una historia de casi nada, dividir por
  // un número diminuto haría que el primer hilo de tráfico se viera como una
  // tormenta.
  return referencia > 0.05 ? referencia : 1;
}
