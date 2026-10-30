import { createHash } from 'node:crypto';
import type { EngineClient } from '../engine';
import type { LogEntry, LogKind, LogReadResult } from '../logs';
import type { ForeignCaps } from './types';
import { num, str } from './types';

/**
 * Lectura del log en MariaDB y SQL Server.
 *
 * A diferencia de PostgreSQL, acá no hace falta entrar al servidor: los dos
 * motores exponen por SQL lo que en PostgreSQL sólo está en un archivo. Es una
 * ventaja real y se aprovecha —nada de SSH, nada de permisos de archivo—, con la
 * contrapartida de que cada motor expone cosas distintas:
 *
 *  - MariaDB: el deadlock más reciente en `SHOW ENGINE INNODB STATUS` y las
 *    consultas lentas en `mysql.slow_log` cuando `log_output` incluye TABLE.
 *    El log de errores sólo está en archivo, y se dice.
 *  - SQL Server: el errorlog completo con `xp_readerrorlog`, y los grafos de
 *    deadlock de la sesión `system_health`, que viene encendida por omisión y
 *    guarda los últimos días sin configurar nada.
 *
 * Se reutiliza `LogEntry` tal cual: la pantalla de log, el agrupado por huella y
 * el informe semanal ya saben leerlo.
 */

function huella(mensaje: string): string {
  const normalizado = mensaje
    .toLowerCase()
    .replace(/'[^']*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return createHash('sha1').update(normalizado).digest('hex').slice(0, 16);
}

function vacia(entradas: LogEntry[], detalle: string, cursor: string | null, avisos: string[]): LogReadResult {
  return { entries: entradas, cursor, source: 'file', detail: detalle, warnings: avisos };
}

function fecha(valor: unknown, porOmision = new Date()): Date {
  if (valor instanceof Date) return valor;
  if (!valor) return porOmision;
  const parsed = new Date(String(valor).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? porOmision : parsed;
}

function entrada(parcial: Partial<LogEntry> & { at: Date; level: string; kind: LogKind; message: string }): LogEntry {
  return {
    sqlstate: null,
    detail: null,
    hint: null,
    query: null,
    context: null,
    pid: null,
    username: null,
    database: null,
    application: null,
    raw: parcial.message,
    fingerprint: huella(parcial.message),
    ...parcial,
  };
}

// --------------------------------------------------------------------- MariaDB

/**
 * `SHOW ENGINE INNODB STATUS` guarda **un solo** deadlock: el último. Si hay dos
 * en un minuto, el segundo tapa al primero. Aun así vale la pena: es el reporte
 * completo con las dos transacciones y las consultas que se cruzaron, que es
 * exactamente lo que no se puede reconstruir después con contadores.
 *
 * El cursor evita guardar veinte copias del mismo deadlock: mientras InnoDB siga
 * mostrando el mismo, se ignora.
 */
function deadlockDeInnodb(texto: string, cursorPrevio: string | null): { entrada: LogEntry | null; cursor: string | null } {
  const inicio = texto.indexOf('LATEST DETECTED DEADLOCK');
  if (inicio === -1) return { entrada: null, cursor: cursorPrevio };

  const fin = texto.indexOf('------------\nTRANSACTIONS', inicio);
  const bloque = texto.slice(inicio, fin === -1 ? inicio + 8000 : fin).trim();

  // La primera línea después del encabezado es la marca de tiempo del deadlock,
  // y sirve de identidad: '2026-08-31 13:44:02 0x7f...'
  const marca = /\n(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(bloque);
  const identidad = marca?.[1] ?? huella(bloque);
  if (cursorPrevio === identidad) return { entrada: null, cursor: cursorPrevio };

  // Las consultas involucradas: InnoDB las lista tras cada transacción.
  const consultas = [...bloque.matchAll(/MySQL thread id [^\n]*\n([^\n]+)/g)]
    .map((match) => match[1]?.trim())
    .filter((linea): linea is string => Boolean(linea && !linea.startsWith('***')));

  return {
    cursor: identidad,
    entrada: entrada({
      at: marca ? fecha(marca[1]) : new Date(),
      level: 'ERROR',
      kind: 'deadlock',
      message: 'InnoDB detected a deadlock',
      detail: bloque.slice(0, 6000),
      query: consultas.join('\n') || null,
      // La huella es fija a propósito: todos los deadlocks se agrupan juntos,
      // porque la pregunta útil es "¿cuántos hubo?" y el detalle de cada uno ya
      // viaja completo en `detail`.
      fingerprint: 'innodb-deadlock',
      raw: bloque.slice(0, 6000),
    }),
  };
}

async function leerMariadb(client: EngineClient, cursor: string | null): Promise<LogReadResult> {
  const avisos: string[] = [];
  const entradas: LogEntry[] = [];
  // El cursor guarda dos cosas separadas por '|': la identidad del último
  // deadlock visto y la marca del último registro del slow log.
  const [cursorDeadlock = null, cursorLento = null] = (cursor ?? '').split('|');
  let nuevoDeadlock = cursorDeadlock;
  let nuevoLento = cursorLento;

  try {
    const filas = await client.query('show engine innodb status');
    const estado = str(filas[0]?.['Status'] ?? filas[0]?.['status'], '');
    const encontrado = deadlockDeInnodb(estado, cursorDeadlock);
    if (encontrado.entrada) entradas.push(encontrado.entrada);
    nuevoDeadlock = encontrado.cursor;
  } catch (error) {
    avisos.push(
      `could not read SHOW ENGINE INNODB STATUS (PROCESS privilege required): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // El slow log en tabla es la única fuente de consultas lentas que se puede
  // leer por SQL. Con log_output=FILE existe igual, pero en un archivo.
  try {
    const [config] = await client.query(`
      select @@log_output as salida, @@slow_query_log as encendido, @@long_query_time as umbral`);
    const salida = str(config?.['salida'], '').toUpperCase();
    const encendido = num(config?.['encendido']) === 1;

    if (!encendido) {
      avisos.push('slow_query_log is off: there is no slow-query history.');
    } else if (!salida.includes('TABLE')) {
      avisos.push(
        `slow_query_log is on but log_output is ${salida}: to read it over SQL without shell access, set log_output=TABLE (hot: SET GLOBAL log_output).`,
      );
    } else {
      const desde = cursorLento ?? new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
      const lentas = await client.query(`
        select start_time, user_host, query_time, rows_sent, rows_examined, db,
               left(convert(sql_text using utf8mb4), 4000) as sql_text
          from mysql.slow_log
         where start_time > '${desde.replace(/'/g, '')}'
         order by start_time
         limit 500`);

      for (const fila of lentas) {
        const cuando = fecha(fila['start_time']);
        const duracion = str(fila['query_time'], '0');
        entradas.push(
          entrada({
            at: cuando,
            level: 'LOG',
            kind: 'other',
            message: `slow query: ${duracion} examining ${num(fila['rows_examined'])} row(s)`,
            query: str(fila['sql_text'], '') || null,
            database: str(fila['db'], '') || null,
            username: str(fila['user_host'], '') || null,
            fingerprint: huella(str(fila['sql_text'], 'slow')),
          }),
        );
        const marca = cuando.toISOString().slice(0, 19).replace('T', ' ');
        if (!nuevoLento || marca > nuevoLento) nuevoLento = marca;
      }
    }
  } catch (error) {
    avisos.push(
      `could not read mysql.slow_log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  avisos.push(
    'The MariaDB error log only exists as a file on the server: what you see here is InnoDB deadlocks and slow queries, which are read over SQL.',
  );

  return vacia(entradas, 'InnoDB status and mysql.slow_log', `${nuevoDeadlock ?? ''}|${nuevoLento ?? ''}`, avisos);
}

// ------------------------------------------------------------------ SQL Server

function clasificarMssql(mensaje: string): LogKind {
  const bajo = mensaje.toLowerCase();
  if (bajo.includes('deadlock')) return 'deadlock';
  if (bajo.includes('lock request time out') || bajo.includes('blocked by')) return 'lock_wait';
  if (bajo.includes('severity: 2') || bajo.includes('fatal')) return 'fatal';
  if (bajo.includes('error:')) return 'error';
  if (bajo.includes('login failed') || bajo.includes('logon')) return 'connection';
  if (bajo.includes('checkpoint')) return 'checkpoint';
  if (bajo.includes('backup') || bajo.includes('restore')) return 'other';
  return 'other';
}

async function leerMssql(client: EngineClient, cursor: string | null): Promise<LogReadResult> {
  const avisos: string[] = [];
  const entradas: LogEntry[] = [];
  const desde = cursor ?? new Date(Date.now() - 30 * 60_000).toISOString();
  let nuevoCursor = cursor;

  // El errorlog. `xp_readerrorlog` no está documentado como API pública pero es
  // lo que usan todas las herramientas, incluida la de Microsoft, y es la única
  // forma de leerlo sin acceso al sistema de archivos.
  try {
    const filas = await client.query(`
      set nocount on;
      create table #errorlog (LogDate datetime, ProcessInfo nvarchar(100), Text nvarchar(max));
      insert into #errorlog exec sys.xp_readerrorlog 0, 1, null, null, '${desde.slice(0, 19).replace('T', ' ')}', null, N'desc';
      select top 500 LogDate, ProcessInfo, Text from #errorlog order by LogDate desc;
      drop table #errorlog;`);

    for (const fila of filas) {
      const cuando = fecha(fila['LogDate']);
      const mensaje = str(fila['Text'], '').trim();
      if (!mensaje) continue;
      const proceso = str(fila['ProcessInfo'], '');
      entradas.push(
        entrada({
          at: cuando,
          level: /error|severity/i.test(mensaje) ? 'ERROR' : 'LOG',
          kind: clasificarMssql(mensaje),
          message: mensaje.slice(0, 2000),
          context: proceso || null,
          raw: mensaje.slice(0, 4000),
        }),
      );
      if (!nuevoCursor || cuando.toISOString() > nuevoCursor) nuevoCursor = cuando.toISOString();
    }
  } catch (error) {
    avisos.push(
      'could not read the errorlog via xp_readerrorlog: need securityadmin (or EXECUTE on the procedure) ' +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  // Los deadlocks completos. La sesión `system_health` viene encendida de
  // fábrica y guarda el grafo entero, así que esto funciona sin configurar nada
  // en el servidor del cliente: es el equivalente de leer el log de PostgreSQL
  // con log_lock_waits encendido, pero sin tener que encenderlo.
  try {
    const filas = await client.query(`
      with objetivo as (
        select cast(t.target_data as xml) as datos
          from sys.dm_xe_session_targets t
          join sys.dm_xe_sessions s on s.address = t.event_session_address
         where s.name = 'system_health' and t.target_name = 'ring_buffer'
      )
      select top 50
             evento.value('@timestamp', 'datetime2')                    as cuando,
             cast(evento.query('.') as nvarchar(max))                   as grafo
        from objetivo
       cross apply datos.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') as x(evento)
       order by evento.value('@timestamp', 'datetime2') desc`);

    for (const fila of filas) {
      const cuando = fecha(fila['cuando']);
      if (cursor && cuando.toISOString() <= cursor) continue;
      const grafo = str(fila['grafo'], '');
      // Las consultas que se cruzaron están en los nodos <inputbuf>.
      const consultas = [...grafo.matchAll(/<inputbuf>([\s\S]*?)<\/inputbuf>/g)]
        .map((match) => match[1]?.trim())
        .filter(Boolean)
        .join('\n---\n');

      entradas.push(
        entrada({
          at: cuando,
          level: 'ERROR',
          kind: 'deadlock',
          message: 'deadlock detected (system_health graph)',
          detail: grafo.slice(0, 6000),
          query: consultas.slice(0, 4000) || null,
          fingerprint: 'mssql-deadlock',
          raw: grafo.slice(0, 6000),
        }),
      );
      if (!nuevoCursor || cuando.toISOString() > nuevoCursor) nuevoCursor = cuando.toISOString();
    }
  } catch (error) {
    avisos.push(
      `could not read deadlocks from the system_health session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return vacia(entradas, 'errorlog and system_health', nuevoCursor, avisos);
}

// ------------------------------------------------------------------------ Oracle

function clasificarOracle(mensaje: string): LogKind {
  const bajo = mensaje.toLowerCase();
  if (bajo.includes('deadlock')) return 'deadlock';
  if (bajo.includes('ora-00060')) return 'deadlock';
  if (bajo.includes('lock') && bajo.includes('wait')) return 'lock_wait';
  if (bajo.includes('ora-00600') || bajo.includes('ora-07445')) return 'fatal';
  if (bajo.includes('ora-') || bajo.includes('error')) return 'error';
  if (bajo.includes('checkpoint') || bajo.includes('log switch')) return 'checkpoint';
  if (bajo.includes('archiv')) return 'other';
  return 'other';
}

async function leerOracle(client: EngineClient, cursor: string | null): Promise<LogReadResult> {
  const avisos: string[] = [];
  const entradas: LogEntry[] = [];
  // First read: 24h. Cursor is always ISO-UTC from JS Date.toISOString().
  const desde = cursor ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  let nuevoCursor = cursor;

  // V$DIAG originating_timestamp is TIMESTAMP WITH TIME ZONE. to_timestamp() is
  // session-local and silently shifts UTC cursors (e.g. UTC-6 → empty reads).
  const desdeTz = (() => {
    const d = new Date(desde);
    if (Number.isNaN(d.getTime())) return new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  })();

  try {
    const filas = await client.query(`
      select originating_timestamp as log_date,
             message_type,
             message_level,
             message_text
        from v$diag_alert_ext
       where originating_timestamp > to_timestamp_tz('${desdeTz}', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       order by originating_timestamp desc
       fetch first 500 rows only`);

    for (const fila of filas) {
      const cuando = fecha(fila['log_date']);
      const mensaje = str(fila['message_text'], '').trim();
      if (!mensaje) continue;
      const tipo = str(fila['message_type'], '');
      const nivel = num(fila['message_level']);
      entradas.push(
        entrada({
          at: cuando,
          level: nivel <= 1 || /error|fatal|ora-/i.test(mensaje) ? 'ERROR' : 'LOG',
          kind: clasificarOracle(mensaje),
          message: mensaje.slice(0, 2000),
          context: tipo || null,
          raw: mensaje.slice(0, 4000),
        }),
      );
      if (!nuevoCursor || cuando.toISOString() > nuevoCursor) nuevoCursor = cuando.toISOString();
    }
  } catch (error) {
    avisos.push(
      `could not read V$DIAG_ALERT_EXT (alert log): need SELECT on diagnostic views ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  avisos.push(
    'Oracle alert log via V$DIAG_ALERT_EXT: deadlocks (ORA-00060) and errors appear here when privileges allow.',
  );

  return vacia(entradas, 'V$DIAG_ALERT_EXT (alert log)', nuevoCursor, avisos);
}

/**
 * Qué se puede leer del log de este motor, y qué no.
 *
 * A diferencia de PostgreSQL no hay que decidir entre journald y archivos: las
 * dos fuentes son SQL. Lo que sí varía es el permiso, y eso se descubre
 * intentando.
 */
export async function inspectForeignLogging(caps: ForeignCaps): Promise<{ limitations: string[] }> {
  const limitaciones: string[] = [];
  if (caps.engine === 'mariadb') {
    if (!caps.features.slowLog) {
      limitaciones.push('slow_query_log is off: there is no slow-query history.');
    }
  }
  return { limitations: limitaciones };
}

export async function readForeignLog(
  client: EngineClient,
  caps: ForeignCaps,
  cursor: string | null,
): Promise<LogReadResult> {
  if (caps.engine === 'mariadb') return leerMariadb(client, cursor);
  if (caps.engine === 'mssql') return leerMssql(client, cursor);
  if (caps.engine === 'oracle') return leerOracle(client, cursor);
  return { entries: [], cursor, source: 'none', detail: 'engine without log reader', warnings: [] };
}
