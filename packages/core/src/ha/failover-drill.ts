/**
 * Failover readiness drill — probes streaming standbys / recovery state.
 * Does not promote; safe for production (read-only catalog queries).
 */
import type { Pool } from 'pg';
import { tagged } from '../tag';

export interface FailoverDrillResult {
  ok: boolean;
  inRecovery: boolean;
  streamingStandbys: number;
  replayLagSeconds: number | null;
  message: string;
  checkSeverity: 'critical' | 'warning' | 'info' | null;
}

/**
 * Primary: require ≥1 streaming client in pg_stat_replication.
 * Standby: require replay not paused and lag under threshold.
 */
export async function runFailoverDrill(
  pool: Pool,
  opts: { maxReplayLagSeconds?: number } = {},
): Promise<FailoverDrillResult> {
  const maxLag = opts.maxReplayLagSeconds ?? 120;
  const role = await pool.query<{ in_recovery: boolean }>(
    tagged(`select pg_is_in_recovery() as in_recovery`),
  );
  const inRecovery = Boolean(role.rows[0]?.in_recovery);

  if (!inRecovery) {
    const reps = await pool.query<{ n: string; streaming: string }>(
      tagged(`
        select count(*)::text as n,
               count(*) filter (where state = 'streaming')::text as streaming
          from pg_stat_replication`),
    );
    const total = Number(reps.rows[0]?.n ?? 0);
    const streaming = Number(reps.rows[0]?.streaming ?? 0);
    if (streaming >= 1) {
      return {
        ok: true,
        inRecovery: false,
        streamingStandbys: streaming,
        replayLagSeconds: null,
        message: `Failover drill OK: primary has ${streaming} streaming standby(s) (${total} total).`,
        checkSeverity: null,
      };
    }
    return {
      ok: false,
      inRecovery: false,
      streamingStandbys: 0,
      replayLagSeconds: null,
      message:
        total > 0
          ? `Failover drill FAILED: ${total} replica connection(s) but none in state=streaming.`
          : 'Failover drill FAILED: no streaming standbys (single-node / no HA).',
      checkSeverity: 'warning',
    };
  }

  const lag = await pool.query<{
    paused: boolean;
    lag_seconds: number | null;
  }>(
    tagged(`
      select pg_is_wal_replay_paused() as paused,
             extract(epoch from (now() - pg_last_xact_replay_timestamp()))::float as lag_seconds`),
  );
  const paused = Boolean(lag.rows[0]?.paused);
  const lagSeconds =
    lag.rows[0]?.lag_seconds != null && Number.isFinite(Number(lag.rows[0].lag_seconds))
      ? Number(lag.rows[0].lag_seconds)
      : null;

  if (paused) {
    return {
      ok: false,
      inRecovery: true,
      streamingStandbys: 0,
      replayLagSeconds: lagSeconds,
      message: 'Failover drill FAILED: WAL replay is paused on this standby.',
      checkSeverity: 'critical',
    };
  }
  if (lagSeconds != null && lagSeconds > maxLag) {
    return {
      ok: false,
      inRecovery: true,
      streamingStandbys: 0,
      replayLagSeconds: lagSeconds,
      message: `Failover drill FAILED: replay lag ${Math.round(lagSeconds)}s > ${maxLag}s.`,
      checkSeverity: 'warning',
    };
  }
  return {
    ok: true,
    inRecovery: true,
    streamingStandbys: 0,
    replayLagSeconds: lagSeconds,
    message: `Failover drill OK: standby replaying` +
      (lagSeconds != null ? ` (lag ${Math.round(lagSeconds)}s)` : '') +
      '.',
    checkSeverity: null,
  };
}
