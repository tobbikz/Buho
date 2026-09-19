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
  const limpio = digest.replace(/^0x/i, '').trim();
  // Hex digests (Maria / MSSQL / Redis fingerprint). Oracle sql_id is base-32-ish — hash it.
  const hexish = limpio.slice(0, 16).padEnd(16, '0');
  if (/^[0-9a-fA-F]{16}$/.test(hexish) && /^[0-9a-fA-F]+$/.test(limpio.replace(/0+$/, '') || '0')) {
    try {
      const sinSigno = BigInt(`0x${hexish}`);
      const conSigno = sinSigno >= 1n << 63n ? sinSigno - (1n << 64n) : sinSigno;
      return conSigno.toString();
    } catch {
      // fall through to hash
    }
  }
  let hash = 0xcbf29ce484222325n;
  const src = limpio.toLowerCase().slice(0, 64) || 'empty';
  for (let i = 0; i < src.length; i += 1) {
    hash ^= BigInt(src.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const conSigno = hash >= 1n << 63n ? hash - (1n << 64n) : hash;
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
         avg_timer_wait / 1000000000               as avg_ms,
         max_timer_wait / 1000000000               as max_ms,
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

/** Digests whose average latency crosses the server long_query_time (or 1s). */
export const MARIADB_SLOW_SQL = `
  select digest                                    as digest,
         schema_name                               as db,
         left(digest_text, 4000)                   as query,
         length(digest_text) > 4000                as truncated,
         count_star                                as calls,
         sum_timer_wait / 1000000000               as exec_ms,
         avg_timer_wait / 1000000000               as avg_ms,
         max_timer_wait / 1000000000               as max_ms,
         sum_rows_sent + sum_rows_affected         as rows_sent,
         sum_rows_examined                         as rows_examined,
         sum_created_tmp_disk_tables               as tmp_disk_tables,
         sum_no_index_used                         as no_index_used,
         sum_select_full_join                      as full_joins
    from performance_schema.events_statements_summary_by_digest
   where digest is not null
     and digest_text not like '%${QUERY_TAG_LIKE}%'
     and avg_timer_wait / 1e12 >= greatest(
           coalesce((select variable_value from information_schema.global_variables
                      where variable_name = 'LONG_QUERY_TIME'), 1),
           0.5)
   order by avg_timer_wait desc
   limit 50`;

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

/** Oracle top SQL from v$sql — sql_id as digest. */
const ORACLE_SQL = `
  select * from (
    select s.sql_id as digest,
           s.parsing_schema_name as db,
           substr(s.sql_text, 1, 4000) as query,
           case when length(s.sql_fulltext) > 4000 then 1 else 0 end as truncated,
           s.executions as calls,
           s.elapsed_time / 1000 as exec_ms,
           s.cpu_time / 1000 as cpu_ms,
           s.rows_processed as rows_sent,
           s.buffer_gets as logical_reads,
           s.disk_reads as physical_reads,
           s.sorts as spills,
           1 as planes
      from v$sql s
     where s.executions > 0
       and s.parsing_schema_name not in ('SYS', 'SYSTEM')
       and s.sql_text not like '%${QUERY_TAG_LIKE}%'
     order by s.elapsed_time desc
  ) where rownum <= 200`;

const ORACLE_SLOW_SQL = `
  select * from (
    select s.sql_id as digest,
           s.parsing_schema_name as db,
           substr(s.sql_text, 1, 4000) as query,
           case when length(s.sql_fulltext) > 4000 then 1 else 0 end as truncated,
           s.executions as calls,
           s.elapsed_time / 1000 as exec_ms,
           s.elapsed_time / nullif(s.executions, 0) / 1000 as avg_ms,
           s.cpu_time / 1000 as cpu_ms,
           s.rows_processed as rows_sent,
           s.buffer_gets as logical_reads,
           s.disk_reads as physical_reads,
           s.sorts as spills
      from v$sql s
     where s.executions > 0
       and s.elapsed_time / nullif(s.executions, 0) / 1e6 >= 1
       and s.parsing_schema_name not in ('SYS', 'SYSTEM')
     order by s.elapsed_time / nullif(s.executions, 0) desc
  ) where rownum <= 50`;

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
          caps.engine === 'mssql' || caps.engine === 'oracle'
            ? Math.max(0, num(row['logical_reads']) - num(row['physical_reads']))
            : Math.max(0, num(row['rows_examined']) - num(row['rows_sent'])),
        sharedRead:
          caps.engine === 'mssql' || caps.engine === 'oracle'
            ? num(row['physical_reads'])
            : num(row['no_index_used']),
        tempWritten:
          caps.engine === 'mssql' || caps.engine === 'oracle'
            ? num(row['spills'])
            : num(row['tmp_disk_tables']),
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
    if (caps.engine === 'mssql') return client.query(MSSQL_SQL);
    if (caps.engine === 'oracle') {
      const [top, slow] = await Promise.all([
        client.query(ORACLE_SQL),
        client.query(ORACLE_SLOW_SQL).catch(() => [] as Record<string, unknown>[]),
      ]);
      const byDigest = new Map<string, Record<string, unknown>>();
      for (const row of [...top, ...slow]) {
        const digest = str(row['digest'], '');
        if (digest) byDigest.set(digest, row);
      }
      return [...byDigest.values()];
    }
    // MariaDB digests
    const [top, slow] = await Promise.all([
      client.query(MARIADB_SQL),
      client.query(MARIADB_SLOW_SQL).catch(() => [] as Record<string, unknown>[]),
    ]);
    const byDigest = new Map<string, Record<string, unknown>>();
    for (const row of [...top, ...slow]) {
      const digest = str(row['digest'], '');
      if (digest) byDigest.set(digest, row);
    }
    return [...byDigest.values()];
  }
  // Degraded path: MariaDB without performance_schema — sample PROCESSLIST.
  if (caps.engine === 'mariadb' && tracker) {
    return tracker.sampleProcesslist(client);
  }
  if (caps.engine === 'mariadb') {
    const ephemeral = new ForeignStatementTracker();
    return ephemeral.sampleProcesslist(client);
  }
  return [];
}

/** Oracle SQL with avg elapsed ≥1s — for Slow queries tab events. */
export async function sampleOracleSlowStatements(
  client: EngineClient,
  caps: ForeignCaps,
): Promise<Record<string, unknown>[]> {
  if (caps.engine !== 'oracle' || !caps.features.statementDigests) return [];
  try {
    return await client.query(ORACLE_SLOW_SQL);
  } catch {
    return [];
  }
}

/**
 * MariaDB digests whose average latency is at/above long_query_time.
 * Empty when performance_schema is off.
 */
export async function sampleMariadbSlowStatements(
  client: EngineClient,
  caps: ForeignCaps,
): Promise<Record<string, unknown>[]> {
  if (caps.engine !== 'mariadb' || !caps.features.statementDigests) return [];
  try {
    return await client.query(MARIADB_SLOW_SQL);
  } catch {
    return [];
  }
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
