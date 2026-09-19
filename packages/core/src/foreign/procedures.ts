import { createHash } from 'node:crypto';
import type { EngineClient } from '../engine';
import { digestToQueryid } from './statements';
import type { ForeignCaps } from './types';
import { num, str } from './types';

/** Id estable por SP: hash del nombre completo (no truncar el literal — colisiona). */
function procedureObjectId(database: string, schema: string, name: string): string {
  const hex = createHash('sha256')
    .update(`${database}.${schema}.${name}`)
    .digest('hex')
    .slice(0, 16);
  return digestToQueryid(hex);
}

/**
 * Procedimientos almacenados (SQL Server) — paridad con el zip Superset.
 *
 * `dm_exec_procedure_stats` es el catálogo de SP a nivel de objeto (no el
 * statement suelto de `dm_exec_query_stats`). Mismos deltas que statements:
 * el acumulado desde el arranque no contesta "qué pasó en la última hora".
 */

export interface ProcedureDelta {
  objectId: string;
  database: string;
  schema: string;
  name: string;
  calls: number;
  execMs: number;
  workerMs: number;
  logicalReads: number;
  avgDurationSec: number;
  lastElapsedSec: number;
  lastExecutionAt: Date | null;
}

interface Estado {
  calls: number;
  execMs: number;
  workerMs: number;
  logicalReads: number;
  at: number;
}

const ESTADO_TTL_MS = 30 * 60_000;
const SLOW_SP_SEC = 1;

const PROCEDURES_SQL = `
  select top 100
         db_name(ps.database_id) as db,
         object_schema_name(ps.object_id, ps.database_id) as sch,
         object_name(ps.object_id, ps.database_id) as proc_name,
         ps.object_id as object_id,
         ps.database_id as database_id,
         ps.execution_count as calls,
         ps.total_elapsed_time / 1000.0 as exec_ms,
         ps.total_worker_time / 1000.0 as worker_ms,
         ps.total_logical_reads as logical_reads,
         case when ps.execution_count > 0
              then (ps.total_elapsed_time / 1000000.0) / ps.execution_count
              else 0 end as avg_duration_sec,
         ps.last_elapsed_time / 1000000.0 as last_elapsed_sec,
         ps.last_execution_time as last_execution_time
    from sys.dm_exec_procedure_stats ps
   where ps.database_id > 4
     and object_name(ps.object_id, ps.database_id) is not null
   order by ps.total_elapsed_time desc`;

export class ForeignProcedureTracker {
  private readonly state = new Map<string, Estado>();

  deltas(
    rows: ProcedureSnapshotRow[],
    now = Date.now(),
  ): { deltas: ProcedureDelta[]; slow: ProcedureDelta[]; discarded: number } {
    const deltas: ProcedureDelta[] = [];
    const slow: ProcedureDelta[] = [];
    let discarded = 0;

    for (const [key, estado] of this.state) {
      if (now - estado.at > ESTADO_TTL_MS) this.state.delete(key);
    }

    for (const row of rows) {
      const key = `${row.database}.${row.schema}.${row.name}`;
      const previous = this.state.get(key);
      this.state.set(key, {
        calls: row.calls,
        execMs: row.execMs,
        workerMs: row.workerMs,
        logicalReads: row.logicalReads,
        at: now,
      });

      const base: ProcedureDelta = {
        objectId: row.objectId,
        database: row.database,
        schema: row.schema,
        name: row.name,
        calls: 0,
        execMs: 0,
        workerMs: 0,
        logicalReads: 0,
        avgDurationSec: row.avgDurationSec,
        lastElapsedSec: row.lastElapsedSec,
        lastExecutionAt: row.lastExecutionAt,
      };

      if (row.lastElapsedSec >= SLOW_SP_SEC) {
        slow.push({ ...base, calls: 1, execMs: row.lastElapsedSec * 1000 });
      }

      if (!previous) continue;
      if (row.calls < previous.calls) {
        discarded += 1;
        continue;
      }
      const dCalls = row.calls - previous.calls;
      if (dCalls <= 0) continue;
      deltas.push({
        ...base,
        calls: dCalls,
        execMs: Math.max(0, row.execMs - previous.execMs),
        workerMs: Math.max(0, row.workerMs - previous.workerMs),
        logicalReads: Math.max(0, row.logicalReads - previous.logicalReads),
      });
    }

    return { deltas, slow, discarded };
  }
}

export interface ProcedureSnapshotRow {
  objectId: string;
  database: string;
  schema: string;
  name: string;
  calls: number;
  execMs: number;
  workerMs: number;
  logicalReads: number;
  avgDurationSec: number;
  lastElapsedSec: number;
  lastExecutionAt: Date | null;
}

export async function sampleForeignProcedures(
  client: EngineClient,
  caps: ForeignCaps,
): Promise<ProcedureSnapshotRow[]> {
  if (caps.engine !== 'mssql') return [];
  const rows = await client.query(PROCEDURES_SQL);
  return rows
    .map((fila) => {
      const database = str(fila['db'], '');
      const schema = str(fila['sch'], 'dbo');
      const name = str(fila['proc_name'], '');
      if (!database || !name) return null;
      const lastRaw = fila['last_execution_time'];
      return {
        objectId: procedureObjectId(database, schema, name),
        database,
        schema,
        name,
        calls: num(fila['calls']),
        execMs: num(fila['exec_ms']),
        workerMs: num(fila['worker_ms']),
        logicalReads: num(fila['logical_reads']),
        avgDurationSec: num(fila['avg_duration_sec']),
        lastElapsedSec: num(fila['last_elapsed_sec']),
        lastExecutionAt: lastRaw ? new Date(String(lastRaw)) : null,
      } satisfies ProcedureSnapshotRow;
    })
    .filter((row): row is ProcedureSnapshotRow => row !== null);
}

/** Catálogo de tablas + FKs para ORM en MariaDB (information_schema). */
export async function sampleMariadbCatalog(client: EngineClient): Promise<{
  tables: {
    schema: string;
    table: string;
    liveTuples: number;
    sizeBytes: number;
  }[];
  fks: { fromSchema: string; fromTable: string; toSchema: string; toTable: string }[];
}> {
  const [tables, fks] = await Promise.all([
    client.query(`
      select table_schema as sch,
             table_name as tbl,
             coalesce(table_rows, 0) as live_tuples,
             coalesce(data_length, 0) + coalesce(index_length, 0) as size_bytes
        from information_schema.tables
       where table_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
         and table_type = 'BASE TABLE'
       order by size_bytes desc
       limit 200`),
    client.query(`
      select constraint_schema as from_schema,
             table_name as from_table,
             referenced_table_schema as to_schema,
             referenced_table_name as to_table
        from information_schema.key_column_usage
       where referenced_table_name is not null
         and constraint_schema not in ('information_schema', 'performance_schema', 'mysql', 'sys')
       group by 1, 2, 3, 4`),
  ]);

  return {
    tables: tables.map((row) => ({
      schema: str(row['sch']),
      table: str(row['tbl']),
      liveTuples: num(row['live_tuples']),
      sizeBytes: num(row['size_bytes']),
    })),
    fks: fks
      .map((row) => ({
        fromSchema: str(row['from_schema']),
        fromTable: str(row['from_table']),
        toSchema: str(row['to_schema']),
        toTable: str(row['to_table']),
      }))
      .filter((row) => row.fromTable && row.toTable),
  };
}

/** Catálogo de tablas + FKs para ORM en SQL Server (sin vacuum_tables). */
export async function sampleMssqlCatalog(client: EngineClient): Promise<{
  tables: {
    schema: string;
    table: string;
    liveTuples: number;
    sizeBytes: number;
  }[];
  fks: { fromSchema: string; fromTable: string; toSchema: string; toTable: string }[];
}> {
  const [tables, fks] = await Promise.all([
    client.query(`
      select top 200
             s.name as sch,
             t.name as tbl,
             isnull(sum(p.rows), 0) as live_tuples,
             isnull(sum(a.total_pages), 0) * 8 * 1024 as size_bytes
        from sys.tables t
        join sys.schemas s on s.schema_id = t.schema_id
        left join sys.partitions p on p.object_id = t.object_id and p.index_id in (0, 1)
        left join sys.allocation_units a on a.container_id = p.partition_id
       where t.is_ms_shipped = 0
       group by s.name, t.name
       order by isnull(sum(a.total_pages), 0) desc`),
    client.query(`
      select object_schema_name(fk.parent_object_id) as from_schema,
             object_name(fk.parent_object_id) as from_table,
             object_schema_name(fk.referenced_object_id) as to_schema,
             object_name(fk.referenced_object_id) as to_table
        from sys.foreign_keys fk`),
  ]);

  return {
    tables: tables.map((row) => ({
      schema: str(row['sch']),
      table: str(row['tbl']),
      liveTuples: num(row['live_tuples']),
      sizeBytes: num(row['size_bytes']),
    })),
    fks: fks
      .map((row) => ({
        fromSchema: str(row['from_schema']),
        fromTable: str(row['from_table']),
        toSchema: str(row['to_schema']),
        toTable: str(row['to_table']),
      }))
      .filter((row) => row.fromTable && row.toTable),
  };
}
