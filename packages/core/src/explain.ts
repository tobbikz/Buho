import type { Pool } from 'pg';
import { tagged } from './tag';

/**
 * Análisis de planes de ejecución.
 *
 * El problema real de un plan de PostgreSQL no es leerlo, es **encontrar el nodo
 * donde se rompe**. Un plan de cuarenta líneas tiene un nodo culpable y treinta
 * y nueve consecuencias suyas, y la salida de texto los presenta a todos con la
 * misma tipografía. Esto recorre el árbol, señala los nodos problemáticos con su
 * causa y su arreglo, y deja el texto crudo para quien lo quiera leer entero.
 *
 * Dos formas de obtener el plan:
 *
 * - **`GENERIC_PLAN`** (PostgreSQL 16+) planifica el texto normalizado de
 *   `pg_stat_statements`, con sus `$1` y todo, sin ejecutar nada. Es lo que hace
 *   posible explicar una consulta directamente desde el listado de las más
 *   costosas, sin pedirle a nadie que reconstruya los valores a mano. La contra:
 *   sin valores concretos el planificador no puede usar estadísticas de
 *   selectividad, así que las estimaciones son las genéricas.
 * - **`ANALYZE`** ejecuta de verdad y trae filas reales, tiempos y derrames a
 *   disco. Es la única forma de ver la diferencia entre lo estimado y lo real,
 *   que es la causa raíz de la mayoría de los planes malos. Corre dentro de una
 *   transacción que **siempre** se revierte.
 */

export type PlanSeverity = 'critica' | 'alta' | 'media' | 'baja';

export interface PlanFinding {
  /** Ruta del nodo en el árbol: "Nested Loop → Seq Scan (pedidos)". */
  path: string;
  /** Identificador estable del nodo, para resaltarlo en el árbol dibujado. */
  nodeId: string;
  severity: PlanSeverity;
  title: string;
  detail: string;
  remediation: string;
  /** Números que sostienen el hallazgo, para no pedir fe. */
  evidence: Record<string, string | number>;
}

export interface PlanNode {
  nodeId: string;
  type: string;
  /** Tabla, índice o CTE sobre el que opera, cuando aplica. */
  relation: string | null;
  label: string;
  startupCost: number;
  totalCost: number;
  planRows: number;
  planWidth: number;
  actualRows: number | null;
  actualLoops: number | null;
  actualTotalMs: number | null;
  /** Tiempo propio: el total menos lo que gastaron los hijos. */
  selfMs: number | null;
  /** Proporción del tiempo (o del costo, sin ANALYZE) que consume este nodo. */
  share: number;
  indexCond: string | null;
  filter: string | null;
  rowsRemovedByFilter: number | null;
  joinType: string | null;
  sortMethod: string | null;
  sortSpaceKb: number | null;
  sortSpaceType: string | null;
  hashBatches: number | null;
  heapBlocksLossy: number | null;
  parallelWorkers: number | null;
  children: PlanNode[];
}

export interface PlanReport {
  /** Cómo se obtuvo: cambia por completo lo que se puede afirmar. */
  mode: 'generic' | 'analyze' | 'estimate';
  planningMs: number | null;
  executionMs: number | null;
  totalCost: number;
  root: PlanNode;
  findings: PlanFinding[];
  /** Salida de texto de PostgreSQL, tal cual. */
  text: string;
  /** JSON completo, por si hace falta algo que este modelo no expone. */
  raw: unknown;
  triggers: { name: string; calls: number; ms: number }[];
}

/** Nodos que leen una tabla entera. */
const FULL_SCANS = new Set(['Seq Scan', 'Parallel Seq Scan']);

/**
 * Estimaciones que delata el planificador cuando no tiene estadísticas.
 *
 * PostgreSQL usa constantes cuando no sabe: 200 filas para un `GROUP BY` sin
 * datos, 1000 para una función sin `ROWS`. Verlas en un plan es la señal de que
 * el problema no es el plan sino la falta de información para elegirlo.
 */
const BLIND_ESTIMATES = new Set([200, 1000]);

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maybe(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Nombre humano del nodo.
 *
 * "Seq Scan on pedidos" dice más que "Seq Scan", y en un plan con ocho scans es
 * la diferencia entre saber de qué se habla y no.
 */
function describe(raw: Record<string, unknown>): { label: string; relation: string | null } {
  const type = String(raw['Node Type'] ?? '?');
  const relation =
    text(raw['Relation Name']) ??
    text(raw['Index Name']) ??
    text(raw['CTE Name']) ??
    text(raw['Function Name']) ??
    text(raw['Subplan Name']);

  const alias = text(raw['Alias']);
  const shown = relation && alias && alias !== relation ? `${relation} ${alias}` : relation;

  return { label: shown ? `${type} · ${shown}` : type, relation: relation ?? null };
}

function parseNode(raw: Record<string, unknown>, path: number[] = []): PlanNode {
  const { label, relation } = describe(raw);
  const children = ((raw['Plans'] as Record<string, unknown>[] | undefined) ?? []).map((child, index) =>
    parseNode(child, [...path, index]),
  );

  const actualLoops = maybe(raw['Actual Loops']);
  const actualRowsPerLoop = maybe(raw['Actual Rows']);
  const actualTotalMs = maybe(raw['Actual Total Time']);

  // "Actual Rows" y "Actual Total Time" son **por vuelta**, no totales. En un
  // Nested Loop con 50 000 vueltas esa diferencia es de cinco órdenes de
  // magnitud, y confundirlas es el error clásico al leer un plan.
  const loops = actualLoops ?? 1;
  const actualRows = actualRowsPerLoop === null ? null : actualRowsPerLoop * loops;
  const totalMs = actualTotalMs === null ? null : actualTotalMs * loops;

  const childrenMs = children.reduce((sum, child) => sum + (child.actualTotalMs ?? 0), 0);

  return {
    nodeId: path.length === 0 ? 'n' : `n-${path.join('-')}`,
    type: String(raw['Node Type'] ?? '?'),
    relation,
    label,
    startupCost: num(raw['Startup Cost']),
    totalCost: num(raw['Total Cost']),
    planRows: num(raw['Plan Rows']),
    planWidth: num(raw['Plan Width']),
    actualRows,
    actualLoops,
    actualTotalMs: totalMs,
    selfMs: totalMs === null ? null : Math.max(0, totalMs - childrenMs),
    share: 0,
    indexCond: text(raw['Index Cond']),
    filter: text(raw['Filter']),
    rowsRemovedByFilter:
      maybe(raw['Rows Removed by Filter']) === null
        ? null
        : (maybe(raw['Rows Removed by Filter']) ?? 0) * loops,
    joinType: text(raw['Join Type']),
    sortMethod: text(raw['Sort Method']),
    sortSpaceKb: maybe(raw['Sort Space Used']),
    sortSpaceType: text(raw['Sort Space Type']),
    hashBatches: maybe(raw['Hash Batches']),
    heapBlocksLossy: maybe(raw['Lossy Heap Blocks']),
    parallelWorkers: maybe(raw['Workers Launched']) ?? maybe(raw['Workers Planned']),
    children,
  };
}

/**
 * Proporción del esfuerzo total que consume cada nodo por sí mismo.
 *
 * El denominador **no** es el tiempo de ejecución. En un plan paralelo, los
 * nodos bajo un `Gather` reportan una vuelta por worker y cada una dura casi lo
 * mismo que la consulta entera: tres workers sobre una tabla de 3 M de filas
 * daban 3000 ms de tiempo propio contra 1027 ms de ejecución, y las
 * proporciones salían del 299 %. Sumando el tiempo propio de todo el árbol se
 * mide reparto de trabajo, que es la pregunta real —¿dónde se va el esfuerzo?—
 * y no puede pasar del 100 %.
 */
function computeShares(node: PlanNode, totalMs: number | null, totalCost: number): void {
  const selfTimes: number[] = [];
  walk(node, (current) => {
    if (current.selfMs !== null) selfTimes.push(current.selfMs);
  });
  const totalSelf = selfTimes.reduce((sum, value) => sum + value, 0);
  const denominator = Math.max(totalMs ?? 0, totalSelf);

  const assign = (current: PlanNode) => {
    if (denominator > 0 && current.selfMs !== null) {
      current.share = Math.min(1, (current.selfMs ?? 0) / denominator);
    } else {
      const childrenCost = current.children.reduce((sum, child) => sum + child.totalCost, 0);
      current.share =
        totalCost > 0 ? Math.min(1, Math.max(0, current.totalCost - childrenCost) / totalCost) : 0;
    }
    for (const child of current.children) assign(child);
  };

  assign(node);
}

function walk(node: PlanNode, visit: (node: PlanNode, ancestors: PlanNode[]) => void, ancestors: PlanNode[] = []): void {
  visit(node, ancestors);
  for (const child of node.children) walk(child, visit, [...ancestors, node]);
}

function pathOf(node: PlanNode, ancestors: PlanNode[]): string {
  return [...ancestors.map((ancestor) => ancestor.type), node.label].join(' → ');
}

function fmt(value: number): string {
  return value.toLocaleString('es', { maximumFractionDigits: value < 10 ? 1 : 0 });
}

/**
 * Heurísticas sobre el árbol.
 *
 * Cada una responde a un patrón que aparece de verdad en producción y trae su
 * arreglo. Las que dependen de números reales sólo se evalúan con `ANALYZE`: sin
 * ejecución no hay filas reales que comparar y afirmar cualquier cosa sobre
 * ellas sería inventar.
 */
export function analyzePlan(root: PlanNode, mode: PlanReport['mode']): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const analyzed = mode === 'analyze';

  walk(root, (node, ancestors) => {
    const path = pathOf(node, ancestors);
    const add = (
      severity: PlanSeverity,
      title: string,
      detail: string,
      remediation: string,
      evidence: Record<string, string | number>,
    ) => findings.push({ path, nodeId: node.nodeId, severity, title, detail, remediation, evidence });

    // ---------------------------------------------------- lecturas completas
    if (FULL_SCANS.has(node.type) && node.relation) {
      const rows = node.actualRows ?? node.planRows;
      const removed = node.rowsRemovedByFilter;
      const kept = node.actualRows ?? node.planRows;

      if (removed !== null && removed > 1_000 && removed > kept * 4) {
        add(
          removed > 100_000 ? 'critica' : 'alta',
          'Lectura completa que descarta casi todo lo que lee',
          `Recorre ${node.relation} entera y el filtro descarta ${fmt(removed)} filas para quedarse con ` +
            `${fmt(kept)}. El trabajo útil es el ${((kept / (kept + removed)) * 100).toFixed(1)} % de lo leído.`,
          `Crear un índice que cubra la condición del filtro: ${node.filter ?? '(ver el filtro del nodo)'}. ` +
            'Un índice sobre esas columnas convierte este nodo en un Index Scan y evita leer el resto de la tabla.',
          { tabla: node.relation, filas_descartadas: removed, filas_conservadas: kept },
        );
      } else if (!analyzed && node.planRows > 50_000 && node.filter) {
        add(
          'media',
          'Lectura completa de una tabla grande con filtro',
          `El planificador estima ${fmt(node.planRows)} filas leyendo ${node.relation} completa. Con un filtro ` +
            'presente, eso suele significar que no hay índice que lo soporte.',
          `Revisar si existe un índice para: ${node.filter}. Con EXPLAIN ANALYZE se confirma cuántas filas ` +
            'descarta realmente el filtro.',
          { tabla: node.relation, filas_estimadas: node.planRows },
        );
      } else if (node.share > 0.35 && rows > 10_000) {
        add(
          'media',
          'La lectura completa domina el plan',
          `Este nodo consume el ${(node.share * 100).toFixed(0)} % del ` +
            `${analyzed ? 'tiempo' : 'costo'} y recorre ${fmt(rows)} filas de ${node.relation}.`,
          'Si la consulta se ejecuta seguido, un índice sobre las columnas de la condición cambia el plan ' +
            'entero. Si es un reporte que barre la tabla a propósito, es el plan correcto.',
          { tabla: node.relation, filas: rows, proporcion: `${(node.share * 100).toFixed(0)} %` },
        );
      }
    }

    // ------------------------------------------- estimación contra realidad
    //
    // Esta es la causa raíz de la mayoría de los planes malos: el planificador
    // eligió bien para los números que creía. Sólo se puede ver con ANALYZE.
    if (analyzed && node.actualRows !== null && node.actualLoops !== null) {
      const estimated = node.planRows * node.actualLoops;
      const actual = node.actualRows;
      const ratio = estimated > 0 ? actual / estimated : actual > 0 ? Infinity : 1;

      if (actual > 1_000 && (ratio > 10 || (ratio < 0.1 && estimated > 1_000))) {
        const under = ratio > 1;
        add(
          ratio > 100 || ratio < 0.01 ? 'critica' : 'alta',
          under ? 'El planificador subestimó las filas por mucho' : 'El planificador sobreestimó las filas por mucho',
          `Estimó ${fmt(estimated)} filas y salieron ${fmt(actual)}: se equivocó por ${
            under ? `${fmt(ratio)}×` : `${fmt(1 / ratio)}× a la baja`
          }. Con esos números eligió este plan, y para las filas reales probablemente no sea el mejor.`,
          'Correr ANALYZE sobre las tablas involucradas. Si el error persiste, suele venir de columnas ' +
            'correlacionadas: CREATE STATISTICS sobre ellas le enseña la dependencia al planificador. ' +
            'En columnas con muchos valores distintos, subir ALTER TABLE … ALTER COLUMN … SET STATISTICS.',
          { estimadas: estimated, reales: actual, desvio: under ? `${fmt(ratio)}×` : `1/${fmt(1 / ratio)}` },
        );
      }
    }

    // ------------------------------------------------------ derrames a disco
    if (node.sortSpaceType === 'Disk' && node.sortSpaceKb !== null) {
      add(
        node.sortSpaceKb > 100_000 ? 'alta' : 'media',
        'El ordenamiento se derramó a disco',
        `Necesitó ${fmt(node.sortSpaceKb / 1024)} MB y no cupo en work_mem, así que PostgreSQL escribió ` +
          `archivos temporales (${node.sortMethod ?? 'external merge'}).`,
        'Subir work_mem para esta sesión o rol hasta que el método pase a "quicksort". Se puede fijar por ' +
          'rol con ALTER ROLE … SET work_mem, sin tocar el valor global: work_mem se reserva por operación, ' +
          'no por conexión, y subirlo para todos multiplica el consumo de memoria del servidor.',
        { espacio_mb: Math.round(node.sortSpaceKb / 1024), metodo: node.sortMethod ?? '?' },
      );
    }

    if (node.hashBatches !== null && node.hashBatches > 1) {
      add(
        node.hashBatches > 8 ? 'alta' : 'media',
        'La tabla hash no cupo en memoria',
        `Se partió en ${node.hashBatches} lotes, lo que obliga a escribir y volver a leer las filas desde ` +
          'archivos temporales.',
        'Subir work_mem para esta consulta. Si la tabla del lado hash es la grande, revisar que el ' +
          'planificador tenga bien el conteo de filas: con una subestimación elige hashear la tabla ' +
          'equivocada.',
        { lotes: node.hashBatches },
      );
    }

    // ------------------------------------------------- Nested Loop caro
    if (node.type === 'Nested Loop' && analyzed) {
      const inner = node.children[1];
      if (inner?.actualLoops !== null && inner !== undefined && (inner.actualLoops ?? 0) > 5_000) {
        add(
          (inner.actualLoops ?? 0) > 100_000 ? 'alta' : 'media',
          'Nested Loop con demasiadas vueltas',
          `El lado interno se ejecuta ${fmt(inner.actualLoops ?? 0)} veces. Un Nested Loop es la mejor opción ` +
            'cuando el lado externo trae pocas filas; con esta cantidad, un Hash Join casi siempre gana.',
          'Suele ser consecuencia de una subestimación del lado externo: revisar el hallazgo de estimación ' +
            'de ese nodo. Si las filas están bien contadas, verificar que exista índice para la condición ' +
            'del join en la tabla interna.',
          { vueltas: inner.actualLoops ?? 0 },
        );
      }
    }

    // --------------------------------------- índice que filtra después de leer
    //
    // Un acceso por índice con Filter significa que el índice llevó hasta las
    // filas pero no pudo descartarlas: esas columnas no están en el índice, así
    // que hay que visitar cada fila en la tabla para tirarla.
    //
    // El Bitmap Heap Scan entra acá y es el caso más costoso de los tres: un
    // bitmap que trae 337 000 filas para devolver 0 leyó media tabla por
    // índice, que es peor que haberla leído secuencialmente.
    if (
      ['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(node.type) &&
      node.filter &&
      node.rowsRemovedByFilter !== null &&
      node.rowsRemovedByFilter > 1_000
    ) {
      const kept = node.actualRows ?? node.planRows;
      const removed = node.rowsRemovedByFilter;
      const wasteful = removed > kept * 10;

      add(
        wasteful && removed > 100_000 ? 'alta' : 'media',
        'El índice encuentra las filas pero no puede filtrarlas',
        `Descarta ${fmt(removed)} filas después de leerlas de la tabla para quedarse con ${fmt(kept)}: ` +
          'las columnas del filtro no están en el índice, así que hay que visitar cada fila para descartarla.',
        `Extender el índice para incluir las columnas de: ${node.filter}. Si sólo se usan para filtrar y no ` +
          'para ordenar ni buscar, agregarlas con INCLUDE mantiene el índice más pequeño.',
        {
          objeto: node.relation ?? '?',
          filas_descartadas: removed,
          filas_conservadas: kept,
        },
      );
    }

    // ------------------------------------------------- bitmap con pérdida
    if (node.heapBlocksLossy !== null && node.heapBlocksLossy > 0) {
      add(
        'media',
        'El bitmap perdió precisión por falta de memoria',
        `${fmt(node.heapBlocksLossy)} bloques quedaron marcados como "lossy": el bitmap no cupo en work_mem y ` +
          'PostgreSQL pasó a marcar páginas enteras en vez de filas, así que revisa filas que no hacían falta.',
        'Subir work_mem para esta consulta.',
        { bloques_lossy: node.heapBlocksLossy },
      );
    }

    // ---------------------------------------------- estimaciones a ciegas
    if (!analyzed && BLIND_ESTIMATES.has(node.planRows) && node.children.length === 0) {
      add(
        'baja',
        'El planificador está usando una estimación por omisión',
        `Estima exactamente ${node.planRows} filas, que es la constante que PostgreSQL usa cuando no tiene ` +
          'estadísticas de este objeto. El plan se eligió sin información real.',
        node.type.includes('Function')
          ? 'Declarar ROWS en la función para que el planificador sepa cuántas filas devuelve.'
          : 'Correr ANALYZE sobre la tabla o revisar si es una tabla temporal, que no tiene estadísticas ' +
            'hasta que se le corre ANALYZE explícitamente.',
        { filas_estimadas: node.planRows, nodo: node.type },
      );
    }

    // ----------------------------------------------------- CTE materializada
    if (node.type === 'CTE Scan' && (node.actualRows ?? node.planRows) > 100_000) {
      add(
        'media',
        'CTE materializada con muchas filas',
        `La CTE ${node.relation ?? ''} produce ${fmt(node.actualRows ?? node.planRows)} filas que se ` +
          'materializan completas antes de usarse; los filtros de afuera no pueden empujarse adentro.',
        'Desde PostgreSQL 12 se puede escribir WITH … AS NOT MATERIALIZED para permitir que el ' +
          'planificador la integre en la consulta, o reemplazarla por una subconsulta.',
        { filas: node.actualRows ?? node.planRows },
      );
    }
  });

  // Un solo nodo dominante es la respuesta más útil que puede dar esta
  // pantalla, así que se reporta aunque no encaje en ningún patrón anterior.
  if (findings.length === 0) {
    let worst: PlanNode | null = null;
    walk(root, (node) => {
      if (!worst || node.share > worst.share) worst = node;
    });
    const dominant = worst as PlanNode | null;
    if (dominant && dominant.share > 0.5 && dominant.children.length === 0) {
      findings.push({
        path: dominant.label,
        nodeId: dominant.nodeId,
        severity: 'baja',
        title: 'El plan se concentra en un nodo',
        detail:
          `${dominant.label} consume el ${(dominant.share * 100).toFixed(0)} % del ` +
          `${analyzed ? 'tiempo de ejecución' : 'costo estimado'} y no muestra ningún patrón problemático ` +
          'conocido. El plan parece razonable para lo que la consulta pide.',
        remediation:
          'Si igual es lento, el margen está en pedir menos: menos filas, menos columnas, o resultados ' +
          'precalculados.',
        evidence: { proporcion: `${(dominant.share * 100).toFixed(0)} %` },
      });
    }
  }

  const rank: Record<PlanSeverity, number> = { critica: 0, alta: 1, media: 2, baja: 3 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.nodeId.localeCompare(a.nodeId));
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .toLowerCase();
}

/** ¿Se puede ejecutar sin escribir? Sólo lectura pura pasa. */
export function isReadOnly(sql: string): boolean {
  const normalized = stripComments(sql);

  if (!/^(select|with|table|values)\b/.test(normalized)) return false;
  // Una CTE puede escribir: WITH x AS (INSERT … RETURNING …) es válido y no es
  // sólo lectura por más que empiece con WITH.
  return !/\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|call|do)\b/.test(normalized);
}

/**
 * Qué se puede hacer con esta sentencia.
 *
 * - `lectura`: se planifica y se puede ejecutar con ANALYZE sin tocar nada.
 * - `escritura`: se planifica, pero ejecutarla escribiría.
 * - `utilitaria`: **PostgreSQL no la puede explicar en absoluto.**
 *
 * Lo último no es una limitación de Búho ni un problema de permisos: la
 * gramática de `EXPLAIN` sólo acepta sentencias con plan. `EXPLAIN ALTER TABLE`,
 * `EXPLAIN VACUUM`, `EXPLAIN CREATE INDEX` y `EXPLAIN SET` son errores de
 * sintaxis, y `REFRESH MATERIALIZED VIEW` responde literalmente "utility
 * statements have no plan structure". Verificado contra PG 18.4.
 *
 * Importa distinguirlo porque `pg_stat_statements` registra estas sentencias
 * como cualquier otra, y salen en el listado de las más costosas. Ofrecer un
 * botón que no puede funcionar y fallar después es peor que no ofrecerlo.
 */
export type StatementKind = 'lectura' | 'escritura' | 'utilitaria';

export function statementKind(sql: string): StatementKind {
  const normalized = stripComments(sql);
  if (isReadOnly(sql)) return 'lectura';

  // Las que sí tienen plan aunque escriban. `create` sólo cuando es
  // CREATE TABLE … AS o CREATE MATERIALIZED VIEW … AS: un CREATE INDEX no se
  // puede explicar.
  const planeable =
    /^(insert|update|delete|merge|with|select|table|values|execute|declare)\b/.test(normalized) ||
    /^create\s+(temp\s+|temporary\s+|unlogged\s+)?table\b[\s\S]*\bas\b/.test(normalized) ||
    /^create\s+materialized\s+view\b[\s\S]*\bas\b/.test(normalized);

  return planeable ? 'escritura' : 'utilitaria';
}

export interface ExplainOptions {
  /** Ejecuta de verdad. Sólo se permite en consultas de sólo lectura. */
  analyze?: boolean;
  /** Planifica el texto normalizado con `$1`. Requiere PostgreSQL 16+. */
  genericPlan?: boolean;
  timeoutMs?: number;
}

/**
 * Repara el texto normalizado de `pg_stat_statements` para que GENERIC_PLAN
 * (y el parser) lo acepten.
 *
 * `interval '1 second'` se normaliza a `interval $1`, que es sintaxis inválida.
 * Lo mismo pasa con timestamp/date/time/timestamptz. El cast `$1::interval` sí
 * es válido y es lo que el planificador genérico espera.
 */
export function rewriteNormalizedPlaceholders(sql: string): string {
  return sql.replace(
    /\b(interval|timestamptz|timestamp|timetz|time|date)\s+(\$\d+)\b/gi,
    (_match, type: string, placeholder: string) => `${placeholder}::${type}`,
  );
}

/**
 * Corre EXPLAIN y devuelve el árbol, los hallazgos y el texto.
 *
 * Con `analyze` todo pasa dentro de una transacción que se revierte siempre.
 * Aunque sólo se aceptan consultas de sólo lectura, el rollback es la red que
 * sostiene el caso que no se previó: una función marcada como estable que en
 * realidad escribe, por ejemplo.
 */
export async function runExplain(pool: Pool, sql: string, options: ExplainOptions = {}): Promise<PlanReport> {
  const analyze = options.analyze === true;
  const generic = options.genericPlan === true;

  if (analyze && generic) {
    throw new Error('ANALYZE necesita valores concretos y GENERIC_PLAN existe justamente para no tenerlos.');
  }
  if (analyze && !isReadOnly(sql)) {
    throw new Error(
      'Sólo se ejecuta EXPLAIN ANALYZE en consultas de sólo lectura. Para el resto, el plan estimado no ' +
        'ejecuta nada y muestra la misma estructura.',
    );
  }

  const flags = [
    analyze ? 'ANALYZE, BUFFERS' : null,
    generic ? 'GENERIC_PLAN' : null,
    'VERBOSE, COSTS, SETTINGS',
  ]
    .filter(Boolean)
    .join(', ');

  // pg_stat_statements sustituye literales por $N. Eso deja sintaxis inválida
  // en constructores tipados: `interval $2`, `timestamp $1`, etc. GENERIC_PLAN
  // necesita SQL parseable, así que se reescribe a `$N::tipo`.
  const clean = rewriteNormalizedPlaceholders(sql.replace(/;\s*$/, ''));
  const client = await pool.connect();

  try {
    await client.query(tagged(`set local statement_timeout = ${options.timeoutMs ?? 15_000}`));
    // La transacción envuelve también el plan estimado: así el camino es uno
    // solo y no hay una rama sin red.
    await client.query('begin');

    const json = await client.query<{ plan: unknown[] }>(
      tagged(`explain (${flags}, FORMAT JSON) ${clean}`),
    );
    const plain = await client.query<Record<string, string>>(
      tagged(`explain (${flags}, FORMAT TEXT) ${clean}`),
    );

    await client.query('rollback');

    const first = (json.rows[0] as unknown as { 'QUERY PLAN': Record<string, unknown>[] })['QUERY PLAN'][0];
    if (!first) throw new Error('EXPLAIN no devolvió un plan.');

    const root = parseNode(first['Plan'] as Record<string, unknown>);
    const executionMs = maybe(first['Execution Time']);
    computeShares(root, executionMs, root.totalCost);

    const mode: PlanReport['mode'] = analyze ? 'analyze' : generic ? 'generic' : 'estimate';

    return {
      mode,
      planningMs: maybe(first['Planning Time']),
      executionMs,
      totalCost: root.totalCost,
      root,
      findings: analyzePlan(root, mode),
      text: plain.rows.map((row) => Object.values(row)[0]).join('\n'),
      raw: first,
      triggers: ((first['Triggers'] as Record<string, unknown>[] | undefined) ?? []).map((trigger) => ({
        name: String(trigger['Trigger Name'] ?? '?'),
        calls: num(trigger['Calls']),
        ms: num(trigger['Time']),
      })),
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
