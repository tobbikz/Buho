import type { EngineClient } from '../engine';
import type { StatementDelta } from '../statements';
import { QUERY_TAG } from '../tag';
import type { ForeignCaps } from './types';
import { num, str } from './types';

/**
 * Analítica de consultas para MariaDB y SQL Server.
 *
 * Las tres fuentes son distintas pero contestan lo mismo: qué consulta
 * normalizada consume el tiempo. Se traducen al mismo `StatementDelta` que
 * produce `pg_stat_statements` para que el store, la tabla de consultas, los
 * sparklines y el informe semanal funcionen sin saber de qué motor vinieron.
 *
 * Lo que **no** se unifica es la explicación del plan: el EXPLAIN de cada motor
 * es otro mundo, y forzarlo a un árbol común daría un dibujo bonito y falso.
 */

/**
 * `queryid` en el store es bigint, y los tres motores identifican la consulta
 * distinto: PostgreSQL con un int64, SQL Server con `query_hash` de 8 bytes y
 * MariaDB con un digest de 32 hex (128 bits).
 *
 * Se doblan los 128 bits de MariaDB a 64 tomando la mitad alta. Es estable
 * —el mismo digest da siempre el mismo id— y el riesgo de colisión con 64 bits
 * sobre unos miles de consultas distintas es despreciable. La alternativa sería
 * cambiar el tipo de la columna en las tres tablas y todos los índices para
 * acomodar un motor.
 */
export function digestToQueryid(digest: string): string {
  const limpio = digest.replace(/^0x/i, '').padEnd(16, '0').slice(0, 16);
  const sinSigno = BigInt(`0x${limpio}`);
  // El bigint de PostgreSQL tiene signo: se envuelve en vez de desbordar.
  const conSigno = sinSigno >= 1n << 63n ? sinSigno - (1n << 64n) : sinSigno;
  return conSigno.toString();
}

const QUERY_TAG_LIKE = QUERY_TAG.replace('/*', '').replace('*/', '').trim();

const MARIADB_SQL = `
  select digest                                    as digest,
         schema_name                               as db,
         left(digest_text, 4000)                   as query,
         length(digest_text) > 4000                as truncated,
         count_star                                as calls,
         sum_timer_wait / 1000000000               as exec_ms,
         -- Las filas de una consulta son las que devuelve *o* las que modifica,
         -- según de qué consulta se trate. Con sólo rows_sent todo el DML valdría
         -- cero y el tráfico de escritura sería invisible.
         sum_rows_sent + sum_rows_affected         as rows_sent,
         sum_rows_examined                         as rows_examined,
         sum_created_tmp_disk_tables               as tmp_disk_tables,
         sum_no_index_used                         as no_index_used,
         sum_select_full_join                      as full_joins
    from performance_schema.events_statements_summary_by_digest
   where digest is not null
     -- Las consultas del propio Búho llevan la marca al final; sin este filtro
     -- el ranking por llamadas lo domina el monitor y no la aplicación.
     and digest_text not like '%${QUERY_TAG_LIKE}%'
   order by sum_timer_wait desc
   limit 200`;

/**
 * SQL Server acumula por plan, no por consulta: la misma consulta con dos planes
 * aparece dos veces. Se agrupa por `query_hash`, que es lo que identifica el
 * texto normalizado, y se suma. Sin esto, un cambio de plan parece una consulta
 * nueva y el histórico se corta.
 *
 * El texto sale de `sys.dm_exec_sql_text` con el offset del statement: sin
 * recortar, un procedimiento de 300 líneas se muestra completo para cada una de
 * sus consultas.
 */
const MSSQL_SQL = `
  select top 200
         convert(varchar(20), q.query_hash, 1)                 as digest,
         min(db_name(t.dbid))                                  as db,
         left(min(substring(t.text,
                (q.statement_start_offset / 2) + 1,
                ((case q.statement_end_offset
                    when -1 then datalength(t.text)
                    else q.statement_end_offset end - q.statement_start_offset) / 2) + 1)), 4000) as query,
         cast(0 as bit)                                        as truncated,
         sum(q.execution_count)                                as calls,
         sum(q.total_elapsed_time) / 1000.0                    as exec_ms,
         sum(q.total_worker_time)  / 1000.0                    as cpu_ms,
         -- Sólo filas devueltas: SQL Server no acumula filas afectadas por
         -- consulta en esta vista, así que el DML aporta cero aquí y su volumen
         -- hay que mirarlo por tiempo o por llamadas.
         sum(q.total_rows)                                     as rows_sent,
         sum(q.total_logical_reads)                            as logical_reads,
         sum(q.total_physical_reads)                           as physical_reads,
         sum(q.total_logical_writes)                           as logical_writes,
         sum(q.total_spills)                                   as spills,
         count(*)                                              as planes
    from sys.dm_exec_query_stats q
   cross apply sys.dm_exec_sql_text(q.sql_handle) t
   where q.query_hash <> 0x0
     and t.text not like '%${QUERY_TAG_LIKE}%'
   group by q.query_hash
   order by sum(q.total_elapsed_time) desc`;

interface Estado {
  calls: number;
  execMs: number;
  rows: number;
  sharedHit: number;
  sharedRead: number;
  tempWritten: number;
  at: number;
}

const ESTADO_TTL_MS = 30 * 60_000;

/**
 * Deltas de actividad por consulta.
 *
 * Misma lógica que en PostgreSQL y por la misma razón: los tres motores
 * acumulan desde el arranque, así que el valor crudo no contesta "¿qué pasó en
 * la última hora?". Un contador que retrocede significa que el motor vació su
 * caché de planes o se reinició, no que la consulta se ejecutó menos veces, y se
 * descarta en vez de guardarse como un pico negativo.
 */
export class ForeignStatementTracker {
  private readonly estado = new Map<string, Estado>();
  /** PROCESSLIST fallback totals — per tracker so multi-instance does not mix. */
  private readonly processlistTotals = new Map<
    string,
    { calls: number; execMs: number; query: string; db: string | null }
  >();

  deltas(
    rows: Record<string, unknown>[],
    caps: ForeignCaps,
    now = Date.now(),
  ): { deltas: StatementDelta[]; discarded: number } {
    const deltas: StatementDelta[] = [];
    let discarded = 0;

    for (const row of rows) {
      const digest = str(row['digest'], '');
      if (!digest) continue;

      const queryid = digestToQueryid(digest);
      const actual: Estado = {
        calls: num(row['calls']),
        execMs: num(row['exec_ms']),
        rows: num(row['rows_sent']),
        sharedHit:
          caps.engine === 'mssql'
            ? Math.max(0, num(row['logical_reads']) - num(row['physical_reads']))
            : Math.max(0, num(row['rows_examined']) - num(row['rows_sent'])),
        sharedRead: caps.engine === 'mssql' ? num(row['physical_reads']) : num(row['no_index_used']),
        tempWritten: caps.engine === 'mssql' ? num(row['spills']) : num(row['tmp_disk_tables']),
        at: now,
      };

      const previo = this.estado.get(queryid);
      this.estado.set(queryid, actual);

      if (!previo) continue;
      if (actual.calls < previo.calls) {
        discarded += 1;
        continue;
      }

      const calls = actual.calls - previo.calls;
      if (calls <= 0) continue;

      deltas.push({
        queryid,
        database: (row['db'] as string | null) ?? null,
        username: null,
        toplevel: true,
        query: str(row['query'], '').trim(),
        truncated: row['truncated'] === true || row['truncated'] === 1,
        calls,
        execMs: Math.max(0, actual.execMs - previo.execMs),
        rows: Math.max(0, actual.rows - previo.rows),
        // Las columnas del store son de PostgreSQL. En MariaDB "shared_read" se
        // usa para las ejecuciones sin índice y en SQL Server para las lecturas
        // físicas: en los dos casos es "lo que costó ir a buscar los datos", y
        // la consola rotula según el motor en vez de inventar una equivalencia.
        sharedHit: Math.max(0, actual.sharedHit - previo.sharedHit),
        sharedRead: Math.max(0, actual.sharedRead - previo.sharedRead),
        tempRead: 0,
        tempWritten: Math.max(0, actual.tempWritten - previo.tempWritten),
        walBytes: 0,
      });
    }

    for (const [clave, entrada] of this.estado) {
      if (now - entrada.at > ESTADO_TTL_MS) this.estado.delete(clave);
    }

    return { deltas, discarded };
  }

  /**
   * Sample PROCESSLIST and fold into cumulative counters owned by this tracker.
   * Used when performance_schema digests are unavailable.
   */
  async sampleProcesslist(client: EngineClient): Promise<Record<string, unknown>[]> {
    const rows = await client.query(`
      select id, user, db, command, time, state, info
        from information_schema.processlist
       where info is not null
         and info <> ''
         and command not in ('Sleep', 'Binlog Dump', 'Binlog Dump GTID', 'Daemon')
         and info not like '%${QUERY_TAG_LIKE}%'
       limit 150`);

    for (const row of rows) {
      const info = str(row['info'], '').trim();
      if (!info) continue;
      const digest = fingerprintSql(info);
      const prev = this.processlistTotals.get(digest) ?? {
        calls: 0,
        execMs: 0,
        query: info.slice(0, 4000),
        db: (row['db'] as string | null) ?? null,
      };
      prev.calls += 1;
      prev.execMs += Math.max(num(row['time']), 1) * 1000;
      prev.query = info.slice(0, 4000);
      prev.db = (row['db'] as string | null) ?? prev.db;
      this.processlistTotals.set(digest, prev);
    }

    return [...this.processlistTotals.entries()].map(([digest, value]) => ({
      digest,
      db: value.db,
      query: value.query,
      truncated: value.query.length >= 4000,
      calls: value.calls,
      exec_ms: value.execMs,
      rows_sent: 0,
      rows_examined: 0,
      tmp_disk_tables: 0,
      no_index_used: 0,
      full_joins: 0,
    }));
  }

  reset(): void {
    this.estado.clear();
    this.processlistTotals.clear();
  }
}

export async function sampleForeignStatements(
  client: EngineClient,
  caps: ForeignCaps,
  tracker?: ForeignStatementTracker,
): Promise<Record<string, unknown>[]> {
  if (caps.features.statementDigests) {
    return client.query(caps.engine === 'mariadb' ? MARIADB_SQL : MSSQL_SQL);
  }
  // Degraded path: MariaDB without performance_schema — sample PROCESSLIST.
  if (caps.engine === 'mariadb' && tracker) {
    return tracker.sampleProcesslist(client);
  }
  if (caps.engine === 'mariadb') {
    // Fallback for callers that have not wired a tracker yet.
    const ephemeral = new ForeignStatementTracker();
    return ephemeral.sampleProcesslist(client);
  }
  return [];
}

/**
 * Normalize SQL enough that "SELECT 1" and "select  1" share a fingerprint.
 * Then fold into a stable 64-bit digest string for ForeignStatementTracker.
 */
function fingerprintSql(sql: string): string {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'([^']|'')*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
