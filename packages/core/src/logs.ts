import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { tagged } from './tag';

/**
 * Lectura del log de PostgreSQL.
 *
 * Hay cosas que no aparecen en ninguna vista de estadísticas y sólo existen en
 * el log: el reporte completo de un deadlock —con las dos consultas y los
 * bloqueos que se cruzaron—, los errores que ve la aplicación, las esperas de
 * bloqueo con su detalle, las cancelaciones de autovacuum. `pg_stat_database`
 * dice *cuántos* deadlocks hubo; sólo el log dice *cuáles*.
 *
 * El problema es que "el log" no es un lugar. Según cómo esté instalado el
 * servidor puede estar en tres sitios distintos, y hay que soportar los tres
 * porque el más común no es el más documentado:
 *
 * - **journald**, cuando `logging_collector = off` y systemd captura la salida
 *   de error. Es lo normal en instalaciones por paquete de Linux, y es el caso
 *   en el que `pg_current_logfile()` devuelve vacío y `pg_ls_logdir()` falla.
 * - **archivos**, cuando `logging_collector = on`. Legibles por el sistema
 *   operativo o por SQL con una función envoltorio (ver `sql/monitor-user.sql`).
 * - **sql**, leyendo el log **a través de la conexión PostgreSQL** (`pg_ls_logdir`
 *   + `buho_read_log` / `pg_read_file`). Es el camino por defecto para instancias
 *   añadidas desde la consola: no hace falta SSH ni filesystem local.
 * - **ninguno alcanzable**, que también es un resultado y hay que decirlo en
 *   lugar de mostrar una pantalla vacía.
 *
 * Y el formato tampoco es uno. `jsonlog` (PG 15+) trae los campos separados;
 * `csvlog` también; `stderr` obliga a deducir la estructura desde
 * `log_line_prefix`. Se soportan los tres, con lo que se pierde declarado.
 */

const run = promisify(execFile);

export type LogSourceKind = 'none' | 'journal' | 'file' | 'sql';
export type LogAccess = 'local' | 'ssh';

export interface LogConfig {
  source?: LogSourceKind;
  /** Cómo se llega al servidor. Igual que las métricas de host. */
  access?: LogAccess;
  /** usuario@servidor para SSH. */
  target?: string;
  identityFile?: string;
  /** Unidad de systemd, cuando el origen es journald. */
  unit?: string;
  /** Directorio de log, si no se quiere deducir de `log_directory`. */
  directory?: string;
  /** Cuánto mirar atrás la primera vez, para no arrastrar meses de historia. */
  backfillMinutes?: number;
  maxLines?: number;
}

/**
 * Clasificación de la entrada.
 *
 * No es cosmética: es lo que permite contestar "¿cuántos deadlocks tuvimos esta
 * semana y entre qué consultas?" sin leer el log a mano.
 */
export type LogKind =
  | 'deadlock'
  | 'lock_wait'
  | 'error'
  | 'fatal'
  | 'connection'
  | 'checkpoint'
  | 'autovacuum'
  | 'temp_file'
  | 'cancelled'
  | 'other';

export interface LogEntry {
  at: Date;
  level: string;
  kind: LogKind;
  sqlstate: string | null;
  message: string;
  detail: string | null;
  hint: string | null;
  /** La sentencia que provocó la entrada (`STATEMENT:` en el log). */
  query: string | null;
  context: string | null;
  pid: number | null;
  username: string | null;
  database: string | null;
  application: string | null;
  /** Mensaje normalizado, para agrupar repeticiones del mismo problema. */
  fingerprint: string;
  raw: string;
}

export interface LogReadResult {
  entries: LogEntry[];
  /** Desde dónde seguir la próxima vez. */
  cursor: string | null;
  /** Qué se leyó y de dónde, para poder explicarlo en la consola. */
  source: LogSourceKind;
  detail: string;
  /** Problemas que impidieron leer, en lenguaje del operador. */
  warnings: string[];
}

/** Niveles de PostgreSQL que abren una entrada nueva. */
const PRIMARY_LEVELS = [
  'PANIC',
  'FATAL',
  'ERROR',
  'WARNING',
  'NOTICE',
  'INFO',
  'LOG',
  'DEBUG1',
  'DEBUG2',
  'DEBUG3',
  'DEBUG4',
  'DEBUG5',
];

/** Niveles que continúan la entrada anterior en vez de abrir una nueva. */
const CONTINUATION_LEVELS = ['DETAIL', 'HINT', 'CONTEXT', 'STATEMENT', 'QUERY', 'LOCATION'];

// `\s{0,2}` y no `\s{1,2}`: journald parte los mensajes largos, y el registro de
// una sentencia llega como `… STATEMENT:` **sin nada detrás**, con el SQL en los
// registros siguientes. Exigiendo un espacio, esa línea no se reconocía y el SQL
// terminaba pegado al mensaje del error en lugar de en su campo.
const LEVEL_RE = new RegExp(
  `\\b(${[...PRIMARY_LEVELS, ...CONTINUATION_LEVELS].join('|')}):\\s{0,2}([\\s\\S]*)$`,
);

// El nivel vive en el prefijo, que es corto. Sin este tope, un `ERROR:` dentro de
// una cadena de una consulta abriría una entrada nueva a media sentencia.
const MAX_PREFIX_LENGTH = 220;

// Igual que en host.ts: la ruta y el destino van dentro de un comando de shell,
// así que se validan en vez de escaparse.
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_TARGET = /^[A-Za-z0-9._@-]+$/;
const SAFE_UNIT = /^[A-Za-z0-9._@-]+$/;

function classify(message: string, level: string): LogKind {
  const m = message.toLowerCase();

  if (m.includes('deadlock detected')) return 'deadlock';
  if (m.startsWith('process ') && m.includes('still waiting for')) return 'lock_wait';
  if (m.includes('acquired') && m.includes('lock on')) return 'lock_wait';
  if (m.startsWith('checkpoint') || m.includes('checkpoints are occurring')) return 'checkpoint';
  if (m.startsWith('automatic vacuum') || m.startsWith('automatic analyze')) return 'autovacuum';
  if (m.startsWith('temporary file')) return 'temp_file';
  if (m.includes('canceling statement due to')) return 'cancelled';
  if (
    m.includes('connection authorized') ||
    m.includes('connection received') ||
    m.includes('disconnection') ||
    m.includes('password authentication failed') ||
    m.includes('no pg_hba.conf entry')
  ) {
    return 'connection';
  }
  if (level === 'FATAL' || level === 'PANIC') return 'fatal';
  if (level === 'ERROR') return 'error';
  return 'other';
}

/**
 * Normaliza el mensaje para agrupar repeticiones.
 *
 * Sin esto, mil errores del mismo `insert` con mil identificadores distintos son
 * mil filas en la pantalla y ninguna conclusión. Se reemplazan números,
 * literales y nombres de relaciones temporales, que es lo que varía entre
 * ocurrencias del mismo problema.
 */
export function fingerprint(message: string): string {
  return message
    .replace(/'[^']*'/g, "'?'")
    .replace(/"[^"]*"/g, '"?"')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Extrae la parte de PostgreSQL de una línea, sin importar el prefijo.
 *
 * `log_line_prefix` es libre: puede traer marca de tiempo, pid, usuario, base,
 * aplicación, o casi nada. En vez de reconstruir el prefijo desde su
 * especificación —que obliga a acertar el orden y los separadores— se ancla en
 * lo único que PostgreSQL garantiza: `NIVEL:` seguido de espacios. Todo lo
 * anterior es prefijo, y de ahí se sacan los campos que se reconozcan.
 */
export function parseLine(line: string): { level: string; body: string; prefix: string } | null {
  const match = LEVEL_RE.exec(line);
  if (!match) return null;
  if (match.index > MAX_PREFIX_LENGTH) return null;
  const level = match[1] ?? '';
  const body = match[2] ?? '';
  return { level, body, prefix: line.slice(0, match.index) };
}

function pidFrom(prefix: string): number | null {
  // `%p` casi siempre va entre corchetes. Con el prefijo de journald delante
  // (`postgres[46375]:`) hay dos candidatos y el del final es el de PostgreSQL.
  const all = [...prefix.matchAll(/\[(\d+)(?::\d+)?\]/g)];
  const last = all[all.length - 1]?.[1];
  return last ? Number(last) : null;
}

function timestampFrom(prefix: string, fallback: Date): Date {
  // `%m` da `2026-08-31 12:03:42.505 CST`. Se acepta con y sin milisegundos y
  // con zona nombrada o desplazamiento.
  const match = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\s*([A-Z]{2,5}|[+-]\d{2}:?\d{2}))?/.exec(
    prefix,
  );
  if (!match?.[1]) return fallback;

  const zone = match[2];
  // Una zona nombrada como CST es ambigua entre husos; se prefiere la marca que
  // ya trae journald antes que adivinar. Con desplazamiento numérico sí es
  // inequívoca.
  const iso = `${match[1].replace(' ', 'T')}${zone && /[+-]/.test(zone) ? zone : ''}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return fallback;

  // Si no había zona, `new Date` la interpreta como local. Cuando la diferencia
  // con la marca de journald es grande, la de journald manda.
  if (!zone && Math.abs(parsed.getTime() - fallback.getTime()) > 6 * 3_600_000) return fallback;
  return parsed;
}

/**
 * Arma entradas a partir de líneas sueltas.
 *
 * Las continuaciones (`DETAIL:`, `STATEMENT:`…) pertenecen a la entrada
 * anterior, y en el reporte de un deadlock es justamente el `DETAIL` el que
 * trae las dos consultas que se cruzaron. Separarlas sería tirar la parte útil.
 */
export function parseEntries(
  lines: { text: string; at: Date }[],
): LogEntry[] {
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;

  for (const line of lines) {
    const parsed = parseLine(line.text);

    if (!parsed) {
      // Continuación cruda: PostgreSQL indenta con tabulador las líneas
      // siguientes de un mensaje multilínea. Se pegan al último campo abierto,
      // que en un reporte de deadlock es el DETAIL con las dos consultas.
      if (current && /^[\t ]/.test(line.text)) {
        const extra = line.text.trim();
        current.raw += `\n${line.text}`;
        if (current.query !== null) current.query += ` ${extra}`;
        else if (current.detail !== null) current.detail += ` ${extra}`;
        else current.message += ` ${extra}`;
      }
      continue;
    }

    const { level, body, prefix } = parsed;

    if (CONTINUATION_LEVELS.includes(level)) {
      if (!current) continue;
      current.raw += `\n${line.text}`;
      if (level === 'DETAIL') current.detail = current.detail ? `${current.detail}\n${body}` : body;
      else if (level === 'HINT') current.hint = body;
      else if (level === 'STATEMENT' || level === 'QUERY') current.query = body;
      else if (level === 'CONTEXT') current.context = body;
      continue;
    }

    const at = timestampFrom(prefix, line.at);
    current = {
      at,
      level,
      kind: classify(body, level),
      sqlstate: null,
      message: body.trim(),
      detail: null,
      hint: null,
      query: null,
      context: null,
      pid: pidFrom(prefix),
      username: null,
      database: null,
      application: null,
      fingerprint: fingerprint(body),
      raw: line.text,
    };
    entries.push(current);
  }

  // Un `STATEMENT:` sin nada detrás deja la consulta como cadena vacía; si nunca
  // llegó el SQL, es un campo vacío y no una consulta.
  for (const entry of entries) {
    if (entry.query !== null) entry.query = entry.query.trim() || null;
    if (entry.detail !== null) entry.detail = entry.detail.trim() || null;
    entry.message = entry.message.trim();
    entry.fingerprint = fingerprint(entry.message);
  }

  return entries;
}

/** Entrada de `jsonlog` (PG 15+), donde no hay nada que deducir. */
function fromJson(raw: string): LogEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = String(parsed['message'] ?? '');
  if (!message) return null;

  const level = String(parsed['error_severity'] ?? 'LOG');
  const at = parsed['timestamp'] ? new Date(String(parsed['timestamp'])) : new Date();

  return {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    level,
    kind: classify(message, level),
    sqlstate: parsed['state_code'] ? String(parsed['state_code']) : null,
    message,
    detail: parsed['detail'] ? String(parsed['detail']) : null,
    hint: parsed['hint'] ? String(parsed['hint']) : null,
    query: parsed['statement'] ? String(parsed['statement']) : null,
    context: parsed['context'] ? String(parsed['context']) : null,
    pid: parsed['pid'] ? Number(parsed['pid']) : null,
    username: parsed['user'] ? String(parsed['user']) : null,
    database: parsed['dbname'] ? String(parsed['dbname']) : null,
    application: parsed['application_name'] ? String(parsed['application_name']) : null,
    fingerprint: fingerprint(message),
    raw,
  };
}

/** Una línea de `csvlog`, con el orden de columnas documentado por PostgreSQL. */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (quoted) {
      if (char === '"') {
        if (row[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

function fromCsv(raw: string): LogEntry | null {
  const f = parseCsvRow(raw);
  // log_time, user_name, database_name, process_id, connection_from,
  // session_id, session_line_num, command_tag, session_start_time,
  // virtual_transaction_id, transaction_id, error_severity, sql_state_code,
  // message, detail, hint, internal_query, ...
  if (f.length < 14) return null;
  const message = f[13] ?? '';
  if (!message) return null;

  const level = f[11] || 'LOG';
  const at = new Date((f[0] ?? '').replace(' ', 'T'));

  return {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    level,
    kind: classify(message, level),
    sqlstate: f[12] || null,
    message,
    detail: f[14] || null,
    hint: f[15] || null,
    query: f[19] || null,
    context: f[18] || null,
    pid: f[3] ? Number(f[3]) : null,
    username: f[1] || null,
    database: f[2] || null,
    application: f[22] || null,
    fingerprint: fingerprint(message),
    raw,
  };
}

async function shell(config: LogConfig, script: string, timeoutMs: number): Promise<string> {
  if (config.access === 'ssh') {
    const target = config.target ?? '';
    if (!SAFE_TARGET.test(target)) {
      throw new Error(`Destino SSH no permitido: ${target}`);
    }
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=accept-new',
      ...(config.identityFile ? ['-i', config.identityFile] : []),
      target,
      script,
    ];
    // El log puede traer megabytes: el buffer de 64 kB de las métricas de host
    // no alcanza y truncar el log en medio de una línea corrompe el parseo.
    const { stdout } = await run('ssh', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  const { stdout } = await run('sh', ['-c', script], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Lee de journald.
 *
 * El cursor de journald es la forma exacta de continuar donde se quedó: sin él
 * habría que filtrar por marca de tiempo y decidir qué hacer con las entradas
 * del mismo segundo. `-o json` además evita tener que deshacer el prefijo de
 * syslog.
 */
async function readJournal(
  config: LogConfig,
  cursor: string | null,
  timeoutMs: number,
): Promise<LogReadResult> {
  const unit = config.unit ?? 'postgresql';
  if (!SAFE_UNIT.test(unit)) throw new Error(`Unidad de systemd no permitida: ${unit}`);

  const maxLines = config.maxLines ?? 5_000;
  const since = config.backfillMinutes ?? 60;
  const selector = cursor
    ? `--after-cursor ${JSON.stringify(cursor)}`
    : `--since "-${since}min"`;

  const script =
    `journalctl -u ${unit} ${selector} -o json --no-pager -n ${maxLines} 2>&1 || true`;

  const stdout = await shell(config, script, timeoutMs);
  const warnings: string[] = [];
  const lines: { text: string; at: Date }[] = [];
  let last: string | null = cursor;

  for (const row of stdout.split('\n')) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) {
      // journalctl escribe sus propios avisos en texto plano.
      if (/no entries|failed|permission denied/i.test(trimmed)) warnings.push(trimmed);
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = parsed['MESSAGE'];
    if (typeof message !== 'string') continue;

    const micros = Number(parsed['__REALTIME_TIMESTAMP'] ?? 0);
    const at = micros > 0 ? new Date(micros / 1000) : new Date();

    // Un registro de journald puede traer varias líneas de PostgreSQL dentro del
    // mismo MESSAGE: el `ERROR:` y su `STATEMENT:` viajan juntos. Sin separarlas,
    // la sentencia termina pegada al final del mensaje y no en su campo.
    for (const text of message.split('\n')) {
      if (text.trim() || /^[\t ]/.test(text)) lines.push({ text, at });
    }
    if (typeof parsed['__CURSOR'] === 'string') last = parsed['__CURSOR'];
  }

  return {
    entries: parseEntries(lines),
    cursor: last,
    source: 'journal',
    detail: `journalctl -u ${unit}`,
    warnings,
  };
}

/**
 * Lee archivos de log.
 *
 * El cursor guarda archivo y desplazamiento en bytes. Cuando el archivo rota, el
 * nombre cambia y se empieza de cero en el nuevo; cuando se trunca, el
 * desplazamiento guardado queda más allá del final y `tail -c +N` no devuelve
 * nada, que es el comportamiento correcto —no reprocesar— hasta que el archivo
 * vuelva a crecer.
 */
async function readFiles(
  config: LogConfig,
  directory: string,
  cursor: string | null,
  timeoutMs: number,
): Promise<LogReadResult> {
  if (!SAFE_PATH.test(directory)) throw new Error(`Directorio de log no permitido: ${directory}`);

  const previous = cursor ? (JSON.parse(cursor) as { file?: string; offset?: number }) : {};
  const maxBytes = 4 * 1024 * 1024;

  // El archivo más reciente por fecha de modificación. Leer sólo el último es
  // deliberado: el histórico ya se leyó en su momento y reprocesarlo duplicaría.
  const script = `
set -e
cd ${directory} 2>/dev/null || { echo "##err directorio ilegible"; exit 0; }
archivo=$(ls -1t *.json *.csv *.log 2>/dev/null | head -1)
if [ -z "$archivo" ]; then echo "##err sin archivos de log"; exit 0; fi
tamano=$(wc -c < "$archivo")
echo "##file $archivo"
echo "##size $tamano"
desde=1
if [ "$archivo" = "${(previous.file ?? '').replace(/"/g, '')}" ]; then
  desde=$(( ${Math.max(0, previous.offset ?? 0)} + 1 ))
  if [ "$desde" -gt "$tamano" ]; then desde=1; fi
fi
echo "##from $desde"
echo "##body"
tail -c +$desde "$archivo" | head -c ${maxBytes}
`;

  const stdout = await shell(config, script, timeoutMs);
  const warnings: string[] = [];

  const bodyAt = stdout.indexOf('##body\n');
  const head = bodyAt >= 0 ? stdout.slice(0, bodyAt) : stdout;
  const body = bodyAt >= 0 ? stdout.slice(bodyAt + 7) : '';

  for (const line of head.split('\n')) {
    if (line.startsWith('##err ')) warnings.push(line.slice(6));
  }

  const file = /##file (.+)/.exec(head)?.[1]?.trim() ?? previous.file ?? null;
  const from = Number(/##from (\d+)/.exec(head)?.[1] ?? 1);
  const consumed = Buffer.byteLength(body, 'utf8');
  const offset = from - 1 + consumed;

  // La última línea puede venir cortada por el tope de bytes; se descarta para
  // no parsear media entrada, y el desplazamiento la deja para la próxima vuelta.
  // Siempre se descarta el último elemento del split: si el cuerpo termina en
  // salto de línea es la cadena vacía, y si no, es una línea cortada por el tope
  // de bytes. En el segundo caso su longitud se resta del desplazamiento para
  // volver a leerla completa en la próxima vuelta.
  const rows = body.split('\n');
  const complete = rows.slice(0, -1);
  const partial = body.endsWith('\n') ? 0 : Buffer.byteLength(rows[rows.length - 1] ?? '', 'utf8');

  const entries: LogEntry[] = [];
  const plain: { text: string; at: Date }[] = [];
  const now = new Date();

  for (const row of complete) {
    if (!row.trim()) continue;
    if (row.trimStart().startsWith('{')) {
      const parsed = fromJson(row);
      if (parsed) entries.push(parsed);
      continue;
    }
    if (file?.endsWith('.csv')) {
      const parsed = fromCsv(row);
      if (parsed) entries.push(parsed);
      continue;
    }
    plain.push({ text: row, at: now });
  }

  entries.push(...parseEntries(plain));
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    entries,
    cursor: file ? JSON.stringify({ file, offset: offset - partial }) : cursor,
    source: 'file',
    detail: `${directory}/${file ?? '?'}`,
    warnings,
  };
}

export interface LogSourceInfo {
  /** Qué se puede leer de verdad, no qué se configuró. */
  usable: LogSourceKind;
  loggingCollector: boolean;
  destination: string;
  directory: string | null;
  linePrefix: string;
  /** Lo que se pierde con la configuración actual, en términos del operador. */
  limitations: string[];
}

/**
 * Averigua qué se puede leer y qué se pierde.
 *
 * Esto es la mitad del valor de la función: un operador que abre la pantalla de
 * log y la ve vacía no sabe si no hay errores o si Búho no puede leer. Acá se
 * decide cuál de las dos es, y se dice.
 */
export async function inspectLogging(pool: Pool, config: LogConfig): Promise<LogSourceInfo> {
  const { rows } = await pool.query<{ name: string; setting: string }>(
    tagged(`select name, setting from pg_settings
             where name in ('logging_collector', 'log_destination', 'log_directory',
                            'data_directory', 'log_line_prefix', 'log_lock_waits',
                            'log_checkpoints', 'log_min_duration_statement',
                            'log_autovacuum_min_duration')`),
  );
  const setting = (name: string) => rows.find((row) => row.name === name)?.setting ?? '';

  const collector = setting('logging_collector') === 'on';
  const destination = setting('log_destination') || 'stderr';
  const rawDirectory = config.directory ?? setting('log_directory');
  const directory = rawDirectory
    ? rawDirectory.startsWith('/')
      ? rawDirectory
      : `${setting('data_directory')}/${rawDirectory}`
    : null;

  const declared = config.source ?? 'none';
  // Lo declarado manda. Sin declarar nada: SQL si el colector escribe archivos
  // (camino por defecto vía la conexión), si no none.
  let usable: LogSourceKind =
    declared !== 'none' ? declared : collector ? 'sql' : 'none';

  const limitations: string[] = [];
  if (usable === 'sql' && !collector) {
    usable = 'none';
    limitations.push(
      'logs.source=sql necesita logging_collector=on. Con el colector apagado el log va a stderr/journald: usa logs.source=journal.',
    );
  }
  if (usable === 'none') {
    limitations.push(
      collector
        ? 'El servidor escribe archivos de log, pero no se configuró un origen (sql / file / journal).'
        : 'logging_collector está apagado: el log va a la salida de error, que en Linux suele capturar systemd. Declarar `logs.source = "journal"` en config.json para leerlo.',
    );
  }
  if (!destination.includes('jsonlog') && !destination.includes('csvlog')) {
    limitations.push(
      `log_destination es "${destination}": los campos se deducen del texto. Con jsonlog (PG 15+) o csvlog vienen separados, incluido el SQLSTATE y el usuario de cada error.`,
    );
  }
  if (setting('log_lock_waits') !== 'on') {
    limitations.push('log_lock_waits está apagado: las esperas de bloqueo no dejan rastro en el log.');
  }
  if (setting('log_min_duration_statement') === '-1') {
    limitations.push('log_min_duration_statement es -1: las consultas lentas no se registran.');
  }

  return {
    usable,
    loggingCollector: collector,
    destination,
    directory,
    linePrefix: setting('log_line_prefix'),
    limitations,
  };
}

export async function readLog(
  config: LogConfig,
  info: LogSourceInfo,
  cursor: string | null,
  timeoutMs = 20_000,
  pool?: Pool,
): Promise<LogReadResult> {
  if (info.usable === 'journal') return readJournal(config, cursor, timeoutMs);
  if (info.usable === 'file') {
    if (!info.directory) {
      return {
        entries: [],
        cursor,
        source: 'none',
        detail: 'sin directorio',
        warnings: ['No se pudo determinar el directorio de log.'],
      };
    }
    return readFiles(config, info.directory, cursor, timeoutMs);
  }
  if (info.usable === 'sql') {
    if (!pool) {
      return {
        entries: [],
        cursor,
        source: 'sql',
        detail: 'sin conexión',
        warnings: ['SQL log reading needs a live PostgreSQL pool.'],
      };
    }
    return readViaSql(pool, cursor, timeoutMs);
  }
  return {
    entries: [],
    cursor,
    source: 'none',
    detail: 'sin origen',
    warnings: info.limitations,
  };
}

/**
 * Lee el log a través de SQL: lista con pg_ls_logdir y lee bytes con
 * buho_read_log (recomendado) o pg_read_file.
 *
 * Es el mismo truco que suelen usar scripts de DBA: la DB expone el logdir a
 * roles con pg_monitor; la función SECURITY DEFINER evita dar pg_read_server_files.
 */
async function readViaSql(
  pool: Pool,
  cursor: string | null,
  timeoutMs: number,
): Promise<LogReadResult> {
  const warnings: string[] = [];
  const previous = cursor ? (JSON.parse(cursor) as { file?: string; offset?: number }) : {};
  const maxBytes = 4 * 1024 * 1024;

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(tagged(`set local statement_timeout = ${Math.max(5_000, Math.trunc(timeoutMs))}`));

    const listed = await client.query<{ name: string; size: string | number; modification: Date | null }>(
      tagged(`select name, size, modification
                from pg_ls_logdir()
               where name ~ '\\.(log|csv|json)$'
               order by modification desc nulls last, name desc
               limit 5`),
    );

    if (listed.rows.length === 0) {
      await client.query('rollback');
      return {
        entries: [],
        cursor,
        source: 'sql',
        detail: 'pg_ls_logdir vacío',
        warnings: [
          'pg_ls_logdir() no devolvió archivos. Comprueba logging_collector=on y que el rol tenga pg_monitor.',
        ],
      };
    }

    const file =
      previous.file && listed.rows.some((row) => row.name === previous.file)
        ? previous.file
        : listed.rows[0]!.name;
    const meta = listed.rows.find((row) => row.name === file) ?? listed.rows[0]!;
    const size = Number(meta.size ?? 0);
    let offset = previous.file === file ? Math.max(0, previous.offset ?? 0) : 0;
    if (offset > size) offset = 0;
    const length = Math.min(maxBytes, Math.max(0, size - offset));
    if (length === 0) {
      await client.query('rollback');
      return {
        entries: [],
        cursor: JSON.stringify({ file, offset }),
        source: 'sql',
        detail: `sql:${file}`,
        warnings,
      };
    }

    // Prefer the SECURITY DEFINER wrapper from sql/monitor-user.sql.
    let body = '';
    const hasWrapper = await client.query<{ ok: boolean }>(
      tagged(`select exists(
                select 1 from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where p.proname = 'buho_read_log'
                   and pg_get_function_identity_arguments(p.oid) = 'text, bigint, integer'
              ) as ok`),
    );

    if (hasWrapper.rows[0]?.ok) {
      const { rows } = await client.query<{ chunk: string | null }>(
        tagged(`select buho_read_log($1, $2::bigint, $3::integer) as chunk`),
        [file, offset, length],
      );
      body = rows[0]?.chunk ?? '';
    } else {
      try {
        const { rows } = await client.query<{ chunk: string | null }>(
          tagged(`select convert_from(
                    pg_read_binary_file(
                      (select case when left(setting, 1) = '/' then setting
                                   else (select setting from pg_settings where name = 'data_directory') || '/' || setting
                              end
                         from pg_settings where name = 'log_directory') || '/' || $1,
                      $2::bigint,
                      $3::integer,
                      true
                    ),
                    'UTF8'
                  ) as chunk`),
          [file, offset, length],
        );
        body = rows[0]?.chunk ?? '';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await client.query('rollback').catch(() => {});
        return {
          entries: [],
          cursor,
          source: 'sql',
          detail: `sql:${file}`,
          warnings: [
            `No se pudo leer el log por SQL (${message}). Crea la función buho_read_log de sql/monitor-user.sql y GRANT EXECUTE al rol de monitoreo.`,
          ],
        };
      }
    }

    const rows = body.split('\n');
    const complete = rows.slice(0, -1);
    const partial = body.endsWith('\n') ? 0 : Buffer.byteLength(rows[rows.length - 1] ?? '', 'utf8');
    const consumed = Buffer.byteLength(body, 'utf8');
    const nextOffset = offset + consumed - partial;

    const entries: LogEntry[] = [];
    const plain: { text: string; at: Date }[] = [];
    const now = new Date();
    for (const row of complete) {
      if (!row.trim()) continue;
      if (row.trimStart().startsWith('{')) {
        const parsed = fromJson(row);
        if (parsed) entries.push(parsed);
        continue;
      }
      if (file.endsWith('.csv')) {
        const parsed = fromCsv(row);
        if (parsed) entries.push(parsed);
        continue;
      }
      plain.push({ text: row, at: now });
    }
    entries.push(...parseEntries(plain));
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());

    await client.query('rollback');
    return {
      entries,
      cursor: JSON.stringify({ file, offset: nextOffset }),
      source: 'sql',
      detail: `sql:${file}`,
      warnings,
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
