/**
 * Qué objetos toca una consulta, sacados de su texto normalizado.
 *
 * Esto existe para poder dibujar el flujo "quién escribe en qué tabla".
 * `pg_stat_statements` sabe el rol, la base, las llamadas y las filas, pero no
 * la tabla: la tabla sólo está en el texto. Y `pg_stat_user_tables` sabe la
 * tabla pero no quién la tocó. Uniendo los dos se puede atribuir el tráfico.
 *
 * **Es un análisis léxico, no un parser.** No entiende CTEs anidados, funciones
 * que escriben por dentro, triggers ni reglas. Por eso:
 *
 * - lo que devuelve viene marcado con el papel de cada objeto (destino o
 *   fuente), y quien lo use debe decir en pantalla que es una atribución
 *   aproximada;
 * - cuando no puede identificar el destino con confianza, devuelve la lista
 *   vacía en vez de adivinar. Atribuir escrituras a la tabla equivocada es peor
 *   que no atribuirlas.
 *
 * El contraste honesto está del otro lado: las tasas de `table_tup_*` vienen de
 * los contadores del propio PostgreSQL. Si la suma atribuida no cuadra con el
 * contador, la diferencia se muestra en vez de esconderse.
 */

export type StatementOperation =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  // COPY va aparte porque es la forma en que entra la carga masiva: en un
  // pipeline de datos suele ser el 99 % de las filas escritas, y meterlo en
  // 'insert' escondería de dónde viene el volumen.
  | 'copy'
  | 'truncate'
  | 'other';

export interface StatementObjects {
  operation: StatementOperation;
  /** La tabla que recibe la escritura. Sólo para insert, update y delete. */
  target: string | null;
  /** Tablas leídas: el `from` y los `join`. */
  sources: string[];
}

/** Palabras que aparecen donde debería ir un nombre de tabla y no lo son. */
const NOT_A_TABLE = new Set([
  'select',
  'values',
  'only',
  'lateral',
  'unnest',
  'generate_series',
  'json_to_record',
  'jsonb_to_record',
  'set',
  'where',
  'as',
  'dual',
  // `copy tabla from stdin`: stdin no es una tabla, es el cliente.
  'stdin',
  'stdout',
  'program',
]);

/**
 * Un identificador de tabla, con esquema opcional y comillas opcionales.
 *
 * Tres formas de citar porque son tres motores: comillas dobles en PostgreSQL,
 * acentos graves en MariaDB —sus digests citan *todo*, así que sin esto no se
 * reconocería ni una tabla— y corchetes en SQL Server. Se quitan al normalizar:
 * en el diagrama `"Orders"`, `` `Orders` `` y `[Orders]` son la misma tabla.
 */
const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[a-zA-Z_][a-zA-Z0-9_$]*)';
// Los espacios alrededor del punto son obligatorios de aceptar: los digests de
// MariaDB escriben `esquema` . `tabla`, con espacios, y sin esto el esquema se
// perdería y la tabla se atribuiría al esquema por omisión.
const QUALIFIED = new RegExp(`^(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?`);

function cleanIdentifier(raw: string | undefined): string | null {
  if (!raw) return null;
  const sinComillas = raw.replace(/^["`[]|["`\]]$/g, '');
  if (sinComillas === '') return null;
  if (NOT_A_TABLE.has(sinComillas.toLowerCase())) return null;
  return sinComillas;
}

/**
 * Normaliza a `esquema.tabla`.
 *
 * El esquema por omisión lo decide quien llama, porque depende del motor:
 * `public` en PostgreSQL, `dbo` en SQL Server, y en MariaDB el nombre de la base.
 * Adivinar `public` para los tres pondría un esquema que en dos de ellos no
 * existe. Sin valor por omisión, el nombre queda sin calificar tal como venía.
 */
function qualify(text: string, defaultSchema: string | null): string | null {
  const match = QUALIFIED.exec(text.trim());
  if (!match) return null;
  const primero = cleanIdentifier(match[1]);
  if (!primero) return null;
  const segundo = cleanIdentifier(match[2]);
  if (segundo) return `${primero}.${segundo}`;
  // Los catálogos son la excepción: `pg_stat_database` no vive en el esquema por
  // omisión, y decir que sí ensuciaría el diagrama con algo que no existe.
  if (/^pg_/i.test(primero)) return `pg_catalog.${primero}`;
  return defaultSchema ? `${defaultSchema}.${primero}` : primero;
}

/** Quita comentarios y comprime espacios, para que las expresiones sean simples. */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function operationOf(sql: string): StatementOperation {
  // `with ... insert` es común en pipelines: la operación es la que escribe, no
  // el `with`. Se busca la primera palabra clave de escritura en el texto.
  const sinWith = /^with\b/i.test(sql) ? sql : sql;
  const primera = /^\s*([a-z]+)/i.exec(sinWith)?.[1]?.toLowerCase() ?? '';

  if (primera === 'insert') return 'insert';
  if (primera === 'update') return 'update';
  if (primera === 'delete') return 'delete';
  if (primera === 'select' || primera === 'table') return 'select';
  if (primera === 'copy') return 'copy';
  if (primera === 'truncate') return 'truncate';
  if (primera === 'with') {
    if (/\binsert\s+into\b/i.test(sql)) return 'insert';
    if (/\bupdate\s+\S+\s+set\b/i.test(sql)) return 'update';
    if (/\bdelete\s+from\b/i.test(sql)) return 'delete';
    return 'select';
  }
  return 'other';
}

/**
 * Nombres de los CTE de la consulta.
 *
 * Hace falta porque `from mi_cte` es sintácticamente idéntico a `from mi_tabla`,
 * y sin distinguirlos el diagrama se llena de tablas que no existen: las
 * consultas de monitoreo están hechas de CTEs, así que los nombres inventados
 * terminaban desplazando a las tablas reales del cliente. Se reconocen por su
 * definición, `nombre as (`, que sólo aparece en la cláusula `with`.
 */
function cteNames(sql: string): Set<string> {
  const nombres = new Set<string>();
  const con = /\bwith\s+(?:recursive\s+)?/i.exec(sql);
  if (!con) return nombres;

  const definiciones = sql.matchAll(new RegExp(`(?:\\bwith\\s+(?:recursive\\s+)?|,)\\s*(${IDENT})\\s*(?:\\([^)]*\\)\\s*)?as\\s*(?:materialized\\s+|not\\s+materialized\\s+)?\\(`, 'gi'));
  for (const definicion of definiciones) {
    const nombre = cleanIdentifier(definicion[1]);
    if (nombre) nombres.add(nombre.toLowerCase());
  }
  return nombres;
}

export function statementObjects(sql: string, defaultSchema: string | null = null): StatementObjects {
  const texto = normalize(sql);
  const operation = operationOf(texto);
  const ctes = cteNames(texto);

  /** Un CTE se reconoce por no llevar esquema propio y coincidir de nombre. */
  const esCte = (relacion: string): boolean => {
    const partes = relacion.split('.');
    const nombre = (partes[partes.length - 1] ?? '').toLowerCase();
    return ctes.has(nombre);
  };

  let target: string | null = null;
  if (operation === 'insert') {
    const match = /\binsert\s+into\s+(.+)$/i.exec(texto);
    target = match?.[1] ? qualify(match[1], defaultSchema) : null;
  } else if (operation === 'update') {
    const match = /\bupdate\s+(?:only\s+)?(.+)$/i.exec(texto);
    target = match?.[1] ? qualify(match[1], defaultSchema) : null;
  } else if (operation === 'delete') {
    const match = /\bdelete\s+from\s+(?:only\s+)?(.+)$/i.exec(texto);
    target = match?.[1] ? qualify(match[1], defaultSchema) : null;
  } else if (operation === 'copy') {
    // `copy t from` escribe; `copy t to` y `copy (select…) to` leen. Sólo el
    // primero cuenta como destino.
    const match = /\bcopy\s+(?!\()(.+?)\s+from\b/i.exec(texto);
    target = match?.[1] ? qualify(match[1], defaultSchema) : null;
  } else if (operation === 'truncate') {
    const match = /\btruncate\s+(?:table\s+)?(?:only\s+)?(.+)$/i.exec(texto);
    target = match?.[1] ? qualify(match[1], defaultSchema) : null;
  }

  if (target && esCte(target)) target = null;

  const sources: string[] = [];
  // `from` y `join` cubren las lecturas reales. Se recorren todas las
  // apariciones porque un join de cinco tablas son cinco lecturas, y en el
  // diagrama de flujo interesan todas.
  const lecturas = texto.matchAll(
    new RegExp(`\\b(?:from|join)\\s+(?:only\\s+)?(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`, 'gi'),
  );
  for (const lectura of lecturas) {
    const nombre = lectura[1] ? qualify(lectura[1], defaultSchema) : null;
    if (!nombre) continue;
    if (nombre === target) continue;
    if (esCte(nombre)) continue;
    if (!sources.includes(nombre)) sources.push(nombre);
  }

  return { operation, target, sources };
}

/**
 * Peso de una consulta para el diagrama, según lo que se quiera ver.
 *
 * Las tres respuestas son legítimas y responden preguntas distintas: "dónde cae
 * el volumen" (filas), "dónde se gasta el servidor" (tiempo) y "qué se llama
 * más" (llamadas). Cambiar de una a otra suele reordenar el diagrama entero, y
 * ver ese cambio es parte del diagnóstico.
 */
export type FlowWeight = 'rows' | 'time' | 'calls';
