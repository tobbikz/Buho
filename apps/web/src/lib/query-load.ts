import { query } from './db';
import { num } from './format';

/** One bucket of statement_stats deltas (interval sums, not server counters). */
export interface QueryLoadBucket {
  bucket: number;
  execMs: number;
  calls: number;
  meanMs: number | null;
}

export interface QueryLoadWindowTotals {
  execMs: number;
  calls: number;
  meanMs: number | null;
}

export interface QueryLoadTimeline {
  buckets: QueryLoadBucket[];
  current: QueryLoadWindowTotals;
  prior: QueryLoadWindowTotals;
  /** Percent change vs the prior window; null when prior is zero or both empty. */
  deltaPct: { execMs: number | null; calls: number | null };
}

const BUCKETS_SQL = `
  select date_bin(make_interval(secs => $4::int), ts, timestamptz 'epoch') as bucket,
         sum(exec_ms) as exec_ms,
         sum(calls)   as calls
    from buho.statement_stats
   where instance_id = $1
     and queryid = $2::bigint
     and ts > now() - make_interval(hours => $3::int)
   group by 1
   order by 1`;

const WINDOW_TOTALS_SQL = `
  select
    coalesce(sum(exec_ms) filter (where ts > now() - make_interval(hours => $3::int)), 0) as cur_exec_ms,
    coalesce(sum(calls)   filter (where ts > now() - make_interval(hours => $3::int)), 0) as cur_calls,
    coalesce(sum(exec_ms) filter (
      where ts > now() - make_interval(hours => ($3::int * 2))
        and ts <= now() - make_interval(hours => $3::int)
    ), 0) as prior_exec_ms,
    coalesce(sum(calls) filter (
      where ts > now() - make_interval(hours => ($3::int * 2))
        and ts <= now() - make_interval(hours => $3::int)
    ), 0) as prior_calls
    from buho.statement_stats
   where instance_id = $1
     and queryid = $2::bigint
     and ts > now() - make_interval(hours => ($3::int * 2))`;

function meanMs(execMs: number, calls: number): number | null {
  return calls > 0 ? execMs / calls : null;
}

function deltaPct(current: number, prior: number): number | null {
  if (current <= 0 && prior <= 0) return null;
  if (prior <= 0) return null;
  return ((current - prior) / prior) * 100;
}

/**
 * Load history for one queryid from `buho.statement_stats` (collector deltas).
 * Default: last 24h in 1h buckets, compared to the previous 24h window.
 */
export async function getQueryLoadTimeline(
  instanceId: number,
  queryid: string,
  windowHours = 24,
  bucketSeconds = 3600,
): Promise<QueryLoadTimeline | null> {
  const qid = Number(queryid);
  if (!Number.isFinite(qid)) return null;

  const [bucketRows, totalRows] = await Promise.all([
    query<Record<string, unknown>>(BUCKETS_SQL, [instanceId, qid, windowHours, bucketSeconds]),
    query<Record<string, unknown>>(WINDOW_TOTALS_SQL, [instanceId, qid, windowHours]),
  ]);

  const totals = totalRows[0];
  if (!totals) return null;

  const current: QueryLoadWindowTotals = {
    execMs: num(totals['cur_exec_ms']) ?? 0,
    calls: num(totals['cur_calls']) ?? 0,
    meanMs: meanMs(num(totals['cur_exec_ms']) ?? 0, num(totals['cur_calls']) ?? 0),
  };
  const prior: QueryLoadWindowTotals = {
    execMs: num(totals['prior_exec_ms']) ?? 0,
    calls: num(totals['prior_calls']) ?? 0,
    meanMs: meanMs(num(totals['prior_exec_ms']) ?? 0, num(totals['prior_calls']) ?? 0),
  };

  const buckets: QueryLoadBucket[] = bucketRows.map((row) => {
    const execMs = num(row['exec_ms']) ?? 0;
    const calls = num(row['calls']) ?? 0;
    return {
      bucket: (row['bucket'] as Date).getTime(),
      execMs,
      calls,
      meanMs: meanMs(execMs, calls),
    };
  });

  if (buckets.length === 0 && current.execMs <= 0 && current.calls <= 0 && prior.execMs <= 0) {
    return null;
  }

  return {
    buckets,
    current,
    prior,
    deltaPct: {
      execMs: deltaPct(current.execMs, prior.execMs),
      calls: deltaPct(current.calls, prior.calls),
    },
  };
}

/** SQL strings used by the UI layer (tests / docs). */
export const queryLoadSql = {
  buckets: BUCKETS_SQL.trim(),
  windowTotals: WINDOW_TOTALS_SQL.trim(),
} as const;
