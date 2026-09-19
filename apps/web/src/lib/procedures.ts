import { query } from './db';

export interface ProcedureRow {
  objectId: string;
  database: string;
  schema: string;
  name: string;
  calls: number;
  execMs: number;
  workerMs: number;
  logicalReads: number;
  avgDurationSec: number | null;
}

export interface SlowProcedureEvent {
  ts: Date;
  objectId: string;
  database: string | null;
  schema: string | null;
  name: string;
  durationSec: number;
}

export async function getTopProcedures(
  instanceId: number,
  minutes: number,
  limit = 25,
): Promise<ProcedureRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select s.object_id::text as object_id,
            coalesce(max(t.database), max(s.database), '') as database,
            coalesce(max(t.schema_name), 'dbo') as schema_name,
            coalesce(max(t.proc_name), s.object_id::text) as proc_name,
            sum(s.calls) as calls,
            sum(s.exec_ms) as exec_ms,
            sum(s.worker_ms) as worker_ms,
            sum(s.logical_reads) as logical_reads,
            avg(s.avg_duration_sec) as avg_duration_sec
       from buho.procedure_stats s
       left join buho.procedure_texts t
         on t.instance_id = s.instance_id and t.object_id = s.object_id
      where s.instance_id = $1
        and s.ts > now() - ($2::text || ' minutes')::interval
      group by s.object_id
      order by sum(s.exec_ms) desc
      limit $3`,
    [instanceId, String(minutes), limit],
  ).catch(() => []);

  return rows.map((row) => ({
    objectId: String(row['object_id']),
    database: String(row['database'] ?? ''),
    schema: String(row['schema_name'] ?? 'dbo'),
    name: String(row['proc_name'] ?? ''),
    calls: Number(row['calls'] ?? 0),
    execMs: Number(row['exec_ms'] ?? 0),
    workerMs: Number(row['worker_ms'] ?? 0),
    logicalReads: Number(row['logical_reads'] ?? 0),
    avgDurationSec: row['avg_duration_sec'] == null ? null : Number(row['avg_duration_sec']),
  }));
}

export async function getSlowProcedureEvents(
  instanceId: number,
  minutes: number,
  limit = 50,
): Promise<SlowProcedureEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `select ts, object_id::text as object_id, database, schema_name, proc_name, duration_sec
       from buho.procedure_slow_events
      where instance_id = $1
        and ts > now() - ($2::text || ' minutes')::interval
      order by ts desc
      limit $3`,
    [instanceId, String(minutes), limit],
  ).catch(() => []);

  return rows.map((row) => ({
    ts: new Date(String(row['ts'])),
    objectId: String(row['object_id']),
    database: row['database'] == null ? null : String(row['database']),
    schema: row['schema_name'] == null ? null : String(row['schema_name']),
    name: String(row['proc_name'] ?? ''),
    durationSec: Number(row['duration_sec'] ?? 0),
  }));
}
