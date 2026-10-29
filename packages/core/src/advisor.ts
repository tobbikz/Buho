/**
 * Sugeridor de índices apoyado en los planes ya recogidos.
 *
 * Hay dos formas de sugerir índices y sólo una es honesta.
 *
 * La deshonesta es la que hace `pg_stat_user_tables`: ve muchos escaneos
 * secuenciales sobre una tabla grande y dice "falta un índice". No sabe sobre
 * qué columna, ni si la consulta lee media tabla —donde el secuencial es la
 * decisión correcta—, ni si el índice ya existe y el planificador lo descartó
 * por estadísticas viejas.
 *
 * La honesta es la que parte del plan: ahí está la condición exacta que se
 * evaluó, cuántas filas descartó, cuántas veces se repitió y cuánto tiempo
 * costó. Eso es lo que hace este módulo, y por eso sólo opina de las consultas
 * cuyo plan alguien pidió. Se prefiere no decir nada a inventar un índice.
 *
 * Lo que sale de aquí es una hipótesis con su evidencia al lado, no una orden.
 * Un índice de más cuesta escrituras, espacio y tiempo de vacuum, así que la
 * decisión la sigue tomando el DBA; el trabajo de Búho es ponerle los números
 * delante.
 */
import type { PlanNode } from './explain';

export interface IndexEvidence {
  /** De qué consulta y de qué nodo salió. */
  queryid: string | null;
  nodeType: string;
  /** La condición tal como la escribió PostgreSQL, sin interpretar. */
  predicate: string;
  rowsRemoved: number | null;
  rowsReturned: number | null;
  loops: number | null;
  selfMs: number | null;
}

export type SuggestionKind =
  | 'seq_scan_filtrado'
  | 'indice_no_selectivo'
  | 'orden_sin_indice'
  | 'join_sin_indice';

export interface IndexSuggestion {
  kind: SuggestionKind;
  /** `esquema.tabla`, tal como aparece en el plan. */
  relation: string;
  /** Columnas candidatas, en el orden en que conviene ponerlas. */
  columns: string[];
  /** El DDL propuesto. `concurrently` porque en producción no hay otra opción. */
  ddl: string;
  reason: string;
  /** Lo que puede salir mal si se aplica sin pensar. Nunca vacío. */
  caveat: string;
  /**
   * Cuánto trabajo desperdiciado explica esta sugerencia, en filas descartadas
   * por ejecución multiplicadas por las veces que se ejecutó. No es un ahorro
   * prometido: es el tamaño del problema observado.
   */
  wastedRows: number;
  /** Milisegundos observados en los nodos que la motivan. */
  observedMs: number;
  evidence: IndexEvidence[];
}

/**
 * Saca nombres de columna de una condición.
 *
 * Deliberadamente conservador: se queda con los identificadores simples que
 * están a la izquierda de un comparador, y descarta funciones, casts y
 * expresiones. Un índice sobre una expresión puede ser la respuesta correcta,
 * pero adivinar cuál a partir del texto del plan produce DDL que no compila, y
 * un DDL que no compila destruye la confianza en toda la pantalla.
 */
export function columnsFromPredicate(predicate: string): string[] {
  const columnas: string[] = [];

  // Las condiciones vienen envueltas en paréntesis y unidas por AND/OR. Se
  // parten por AND: cada rama es una oportunidad de índice. Las de OR se dejan
  // pasar porque un índice compuesto no las resuelve.
  if (/\bor\b/i.test(predicate)) return [];

  for (const rama of predicate.split(/\bAND\b/i)) {
    // Igualdad primero: es la que manda al frente del índice compuesto.
    const igualdad = rama.match(/\(?\s*([a-z_][a-z0-9_]*)\s*=\s*/i);
    const rango = rama.match(/\(?\s*([a-z_][a-z0-9_]*)\s*(?:>=|<=|>|<|~~|between)/i);
    const candidata = igualdad?.[1] ?? rango?.[1];
    if (!candidata) continue;
    // `length(x)`, `x::text`, `lower(x)`: si el identificador viene pegado a un
    // paréntesis o a un cast, no es una columna desnuda.
    if (new RegExp(`${candidata}\\s*(\\(|::)`, 'i').test(rama)) continue;
    if (columnas.includes(candidata)) continue;
    // Las de igualdad van al principio; las de rango, al final. Es la regla que
    // más rinde en un índice compuesto y la que más se olvida.
    if (igualdad?.[1] === candidata) columnas.unshift(candidata);
    else columnas.push(candidata);
  }

  return columnas;
}

/** Nombre estable y legible, para que dos ejecuciones propongan el mismo DDL. */
function indexName(relation: string, columns: string[]): string {
  const tabla = relation.includes('.') ? (relation.split('.')[1] ?? relation) : relation;
  const base = `${tabla}_${columns.join('_')}_idx`;
  // 63 bytes es el límite de un identificador en PostgreSQL; si se pasa, se
  // recorta en vez de generar un DDL que el servidor va a truncar en silencio.
  return base.length <= 63 ? base : base.slice(0, 60) + 'idx';
}

function ddlFor(relation: string, columns: string[]): string {
  const cols = columns.map((columna) => `"${columna}"`).join(', ');
  return `create index concurrently ${indexName(relation, columns)}\n  on ${relation} (${cols});`;
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Umbrales. Están juntos y con nombre para poder discutirlos sin leer código. */
const MIN_ROWS_REMOVED = 1_000;
/** Debajo de esta proporción de descarte, el escaneo secuencial es lo correcto. */
const MIN_DISCARD_RATIO = 0.9;
const MIN_SORT_KB = 4 * 1024;

/**
 * Analiza un plan y propone índices.
 *
 * Sólo mira nodos con `ANALYZE`: sin filas reales no se sabe cuántas descartó
 * el filtro, y sin eso cualquier sugerencia es una corazonada.
 */
export function suggestIndexes(root: PlanNode, queryid: string | null): IndexSuggestion[] {
  const sugerencias: IndexSuggestion[] = [];

  walk(root, (node) => {
    const removidas = node.rowsRemovedByFilter;
    const loops = node.actualLoops ?? 1;
    const devueltas = node.actualRows;

    // Estimate-only Seq Scan with filter (no ANALYZE actuals): weaker signal.
    if (
      (node.type === 'Seq Scan' || node.type === 'Parallel Seq Scan') &&
      node.filter &&
      node.relation &&
      removidas === null &&
      (node.planRows ?? 0) >= MIN_ROWS_REMOVED
    ) {
      const columnas = columnsFromPredicate(node.filter);
      if (columnas.length > 0) {
        sugerencias.push({
          kind: 'seq_scan_filtrado',
          relation: node.relation,
          columns: columnas,
          ddl: ddlFor(node.relation, columnas),
          reason:
            `Estimated plan shows a sequential scan on ${node.relation} with a filter ` +
            `(~${(node.planRows ?? 0).toLocaleString('en-US')} plan rows). ` +
            'Run EXPLAIN ANALYZE to confirm discarded rows before creating an index.',
          caveat:
            'This suggestion comes from an estimated plan (auto-plans / GENERIC_PLAN). ' +
            'Confirm with ANALYZE and check existing indexes / stale statistics first.',
          wastedRows: node.planRows ?? 0,
          observedMs: 0,
          evidence: [
            {
              queryid,
              nodeType: node.type,
              predicate: node.filter,
              rowsRemoved: null,
              rowsReturned: null,
              loops: null,
              selfMs: null,
            },
          ],
        });
      }
    }

    // ---------------------------------------------------- secuencial filtrado
    if (
      (node.type === 'Seq Scan' || node.type === 'Parallel Seq Scan') &&
      node.filter &&
      node.relation &&
      removidas !== null &&
      removidas >= MIN_ROWS_REMOVED
    ) {
      const leidas = removidas + (devueltas ?? 0);
      const proporcion = leidas > 0 ? removidas / leidas : 0;
      const columnas = columnsFromPredicate(node.filter);

      // Descartar el 30 % no justifica un índice: el planificador ya eligió bien.
      if (proporcion >= MIN_DISCARD_RATIO && columnas.length > 0) {
        sugerencias.push({
          kind: 'seq_scan_filtrado',
          relation: node.relation,
          columns: columnas,
          ddl: ddlFor(node.relation, columnas),
          reason:
            `The sequential scan read ${leidas.toLocaleString('en-US')} rows to return ` +
            `${(devueltas ?? 0).toLocaleString('en-US')}: it discarded ${(proporcion * 100).toFixed(1)}% ` +
            `after reading them${loops > 1 ? `, and repeated ${loops.toLocaleString('en-US')} times` : ''}. ` +
            'An index on the filter condition would avoid that read.',
          caveat:
            'Confirm there is not already an equivalent index the planner is ignoring: ' +
            'if statistics are stale, the fix is ANALYZE rather than a new index. ' +
            'On write-heavy tables, every extra index is paid on every INSERT and every vacuum.',
          wastedRows: removidas * loops,
          observedMs: node.selfMs ?? 0,
          evidence: [
            {
              queryid,
              nodeType: node.type,
              predicate: node.filter,
              rowsRemoved: removidas,
              rowsReturned: devueltas,
              loops,
              selfMs: node.selfMs,
            },
          ],
        });
      }
    }

    // ------------------------------------------- índice que no filtra bastante
    // El índice existe y se usa, pero deja el trabajo a medias: encuentra las
    // filas y después descarta la mayoría con un filtro. Es el caso donde
    // agregar una columna al índice existente rinde más que crear otro.
    if (
      (node.type === 'Index Scan' ||
        node.type === 'Index Only Scan' ||
        node.type === 'Bitmap Heap Scan') &&
      node.filter &&
      node.relation &&
      removidas !== null &&
      removidas >= MIN_ROWS_REMOVED
    ) {
      const columnas = columnsFromPredicate(node.filter);
      if (columnas.length > 0) {
        sugerencias.push({
          kind: 'indice_no_selectivo',
          relation: node.relation,
          columns: columnas,
          ddl: ddlFor(node.relation, columnas),
          reason:
            `The index found rows but the filter discarded ${removidas.toLocaleString('en-US')} ` +
            `after fetching them from the table${loops > 1 ? ` (${loops.toLocaleString('en-US')} executions)` : ''}. ` +
            'The condition that filters is not in the index.',
          caveat:
            'Here it usually pays to extend the index already in use — append these columns — ' +
            'instead of creating a new one: two indexes with the same prefix compete and duplicate write cost. ' +
            `See which index the plan chose (${node.indexCond ? 'condition: ' + node.indexCond : 'no index condition'}) before deciding.`,
          wastedRows: removidas * loops,
          observedMs: node.selfMs ?? 0,
          evidence: [
            {
              queryid,
              nodeType: node.type,
              predicate: node.filter,
              rowsRemoved: removidas,
              rowsReturned: devueltas,
              loops,
              selfMs: node.selfMs,
            },
          ],
        });
      }
    }

    // --------------------------------------------------- ordenamiento en disco
    if (
      node.type === 'Sort' &&
      node.sortSpaceType === 'Disk' &&
      (node.sortSpaceKb ?? 0) >= MIN_SORT_KB
    ) {
      const columnas = columnsFromPredicate(node.label.replace(/^Sort Key:\s*/i, ''));
      sugerencias.push({
        kind: 'orden_sin_indice',
        relation: node.relation ?? '(output of the previous node)',
        columns: columnas,
        ddl:
          node.relation && columnas.length > 0
            ? ddlFor(node.relation, columnas)
            : '-- no DDL: the sort key is not simple columns on one table',
        reason:
          `The sort spilled to disk and used ${Math.round((node.sortSpaceKb ?? 0) / 1024).toLocaleString('en-US')} MB. ` +
          'An index in the requested order removes it; raising work_mem only moves it to memory.',
        caveat:
          'Before adding an index, check whether raising work_mem is enough: that change is reversible and has no write cost. ' +
          'An index only wins if this query repeats and the sort order is always the same.',
        wastedRows: 0,
        observedMs: node.selfMs ?? 0,
        evidence: [
          {
            queryid,
            nodeType: node.type,
            predicate: node.label,
            rowsRemoved: null,
            rowsReturned: devueltas,
            loops,
            selfMs: node.selfMs,
          },
        ],
      });
    }
  });

  return sugerencias;
}

/**
 * Junta las sugerencias de varios planes.
 *
 * Se agrupan por tabla y columnas: la misma falta de índice aparece en muchas
 * consultas, y "este índice le sirve a seis consultas" es un argumento mucho más
 * fuerte que seis sugerencias iguales en una lista.
 */
export function mergeSuggestions(todas: IndexSuggestion[]): IndexSuggestion[] {
  const grupos = new Map<string, IndexSuggestion>();

  for (const sugerencia of todas) {
    const clave = `${sugerencia.kind}|${sugerencia.relation}|${sugerencia.columns.join(',')}`;
    const existente = grupos.get(clave);
    if (!existente) {
      grupos.set(clave, { ...sugerencia, evidence: [...sugerencia.evidence] });
      continue;
    }
    existente.wastedRows += sugerencia.wastedRows;
    existente.observedMs += sugerencia.observedMs;
    for (const prueba of sugerencia.evidence) {
      // Una misma consulta puede aportar el mismo nodo dos veces si se pidió su
      // plan varias veces; contarla dos veces exageraría el caso.
      const repetida = existente.evidence.some(
        (previa) => previa.queryid === prueba.queryid && previa.predicate === prueba.predicate,
      );
      if (!repetida) existente.evidence.push(prueba);
    }
  }

  return [...grupos.values()].sort(
    (a, b) => b.evidence.length - a.evidence.length || b.wastedRows - a.wastedRows,
  );
}
