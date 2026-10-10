import { tagged } from './tag';
import type { Pool } from 'pg';
import type { Capabilities } from './types';

/**
 * Un intervalo de actividad de una consulta normalizada. Son **deltas**, no
 * acumulados: `pg_stat_statements` cuenta desde el último reset, así que el
 * valor crudo no dice nada sobre "la última hora".
 */
export interface StatementDelta {
  queryid: string;
  database: string | null;
  username: string | null;
  toplevel: boolean;
  query: string;
  /** El texto se guardó cortado, así que no sirve para explicar la consulta. */
  truncated: boolean;
  calls: number;
  execMs: number;
  rows: number;
  sharedHit: number;
  sharedRead: number;
  tempRead: number;
  tempWritten: number;
  walBytes: number;
}

interface StatementState {
  calls: number;
  execMs: number;
  rows: number;
  sharedHit: number;
  sharedRead: number;
  tempRead: number;
  tempWritten: number;
  walBytes: number;
  statsSince: string | null;
  at: number;
}

/**
 * `queryid` es int64: llega como string desde pg y se queda como string. Si se
 * convierte a number, los ids grandes pierden precisión y dos consultas
 * distintas terminan mezcladas.
 *
 * El filtro por `dbid` es la misma lección que en la captura de bloqueos:
 * pg_stat_statements es del clúster completo, y sin acotar a la base conectada
 * dos entradas del config sobre el mismo servidor duplican todo.
 */
function statementsSql(caps: Capabilities): string {
  const statsSince = caps.versionNum >= 170_000 ? 's.stats_since' : 'null::timestamptz';
  return `
    select s.queryid::text                as queryid,
           s.userid::text                 as userid,
           s.dbid::text                   as dbid,
           s.toplevel,
           d.datname                      as database,
           r.rolname                      as username,
           s.query,
           s.calls, s.total_exec_time     as exec_ms, s.rows,
           s.shared_blks_hit              as shared_hit,
           s.shared_blks_read             as shared_read,
           s.temp_blks_read               as temp_read,
           s.temp_blks_written            as temp_written,
           s.wal_bytes,
           ${statsSince}                  as stats_since
      from pg_stat_statements s
      left join pg_database d on d.oid = s.dbid
      left join pg_roles r on r.oid = s.userid
     where s.queryid is not null
       and s.dbid = (select oid from pg_database where datname = current_database())
     order by s.total_exec_time desc
     limit 200`;
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function marker(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Entradas que no se ven en este tiempo se olvidan: el mapa no puede crecer sin techo. */
const STATE_TTL_MS = 30 * 60_000;

export class StatementTracker {
  private readonly state = new Map<string, StatementState>();

  /**
   * Devuelve la actividad del intervalo. Descarta la primera muestra de cada
   * consulta (sin base no hay delta) y cualquier fila cuyo contador retroceda:
   * eso significa `pg_stat_statements_reset()` o expulsión de la entrada del
   * hash, no una consulta que se ejecutó menos veces.
   */
  deltas(rows: Record<string, unknown>[], now = Date.now()): { deltas: StatementDelta[]; discarded: number } {
    const deltas: StatementDelta[] = [];
    let discarded = 0;

    for (const row of rows) {
      const key = `${row['queryid']}|${row['userid']}|${row['dbid']}|${row['toplevel']}`;
      const current: StatementState = {
        calls: num(row['calls']),
        execMs: num(row['exec_ms']),
        rows: num(row['rows']),
        sharedHit: num(row['shared_hit']),
        sharedRead: num(row['shared_read']),
        tempRead: num(row['temp_read']),
        tempWritten: num(row['temp_written']),
        walBytes: num(row['wal_bytes']),
        statsSince: marker(row['stats_since']),
        at: now,
      };

      const previous = this.state.get(key);
      this.state.set(key, current);

      if (!previous) continue;
      if (previous.statsSince !== current.statsSince || current.calls < previous.calls) {
        discarded += 1;
        continue;
      }

      const calls = current.calls - previous.calls;
      if (calls <= 0) continue;

      deltas.push({
        queryid: String(row['queryid']),
        database: (row['database'] as string | null) ?? null,
        username: (row['username'] as string | null) ?? null,
        toplevel: row['toplevel'] !== false,
        query: String(row['query'] ?? '').trim(),
        truncated: false,
        calls,
        execMs: Math.max(0, current.execMs - previous.execMs),
        rows: Math.max(0, current.rows - previous.rows),
        sharedHit: Math.max(0, current.sharedHit - previous.sharedHit),
        sharedRead: Math.max(0, current.sharedRead - previous.sharedRead),
        tempRead: Math.max(0, current.tempRead - previous.tempRead),
        tempWritten: Math.max(0, current.tempWritten - previous.tempWritten),
        walBytes: Math.max(0, current.walBytes - previous.walBytes),
      });
    }

    for (const [key, entry] of this.state) {
      if (now - entry.at > STATE_TTL_MS) this.state.delete(key);
    }

    return { deltas, discarded };
  }

  reset(): void {
    this.state.clear();
  }
}

export async function sampleStatements(pool: Pool, caps: Capabilities): Promise<Record<string, unknown>[]> {
  const result = await pool.query(tagged(statementsSql(caps)));
  return result.rows as Record<string, unknown>[];
}
