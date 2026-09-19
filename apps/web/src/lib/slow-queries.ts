import { query } from './db';

export interface SlowStatementAgg {
  queryid: string;
  database: string | null;
  username: string | null;
  query: string;
  events: number;
  maxDurationSec: number;
  avgDurationSec: number;
  sources: string[];
}

export interface SlowStatementEvent {
  ts: Date;
  queryid: string;
  database: string | null;
  username: string | null;
  query: string;
  durationSec: number;
  rowsSent: number | null;
  rowsExamined: number | null;
  source: string;
}

export async function getSlowStatementAggs(
  instanceId: number,
  minutes: number,
  limit = 25,
): Promise<SlowStatementAgg[]> {
  const rows = await query<Record<string, unknown>>(
    `select e.queryid::text as queryid,
            max(e.database) as database,
            max(e.username) as username,
            coalesce(max(t.query), '(no text)') as query,
            count(*)::int as events,
            max(e.duration_sec) as max_duration_sec,
            avg(e.duration_sec) as avg_duration_sec,
            array_agg(distinct e.source) as sources
       from buho.statement_slow_events e
       left join buho.statement_texts t
         on t.instance_id = e.instance_id and t.queryid = e.queryid
      where e.instance_id = $1
        and e.ts > now() - ($2::text || ' minutes')::interval
      group by e.queryid
      order by max(e.duration_sec) desc
      limit $3`,
    [instanceId, String(minutes), limit],
  ).catch(() => []);

  return rows.map((row) => ({
    queryid: String(row['queryid']),
    database: row['database'] == null ? null : String(row['database']),
    username: row['username'] == null ? null : String(row['username']),
    query: String(row['query'] ?? ''),
    events: Number(row['events'] ?? 0),
    maxDurationSec: Number(row['max_duration_sec'] ?? 0),
    avgDurationSec: Number(row['avg_duration_sec'] ?? 0),
    sources: Array.isArray(row['sources']) ? row['sources'].map(String) : [],
  }));
}

export async function getSlowStatementEvents(
  instanceId: number,
  minutes: number,
  limit = 50,
): Promise<SlowStatementEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `select e.ts,
            e.queryid::text as queryid,
            e.database,
            e.username,
            coalesce(t.query, '(no text)') as query,
            e.duration_sec,
            e.rows_sent,
            e.rows_examined,
            e.source
       from buho.statement_slow_events e
       left join buho.statement_texts t
         on t.instance_id = e.instance_id and t.queryid = e.queryid
      where e.instance_id = $1
        and e.ts > now() - ($2::text || ' minutes')::interval
      order by e.ts desc
      limit $3`,
    [instanceId, String(minutes), limit],
  ).catch(() => []);

  return rows.map((row) => ({
    ts: new Date(String(row['ts'])),
    queryid: String(row['queryid']),
    database: row['database'] == null ? null : String(row['database']),
    username: row['username'] == null ? null : String(row['username']),
    query: String(row['query'] ?? ''),
    durationSec: Number(row['duration_sec'] ?? 0),
    rowsSent: row['rows_sent'] == null ? null : Number(row['rows_sent']),
    rowsExamined: row['rows_examined'] == null ? null : Number(row['rows_examined']),
    source: String(row['source'] ?? 'digest'),
  }));
}
