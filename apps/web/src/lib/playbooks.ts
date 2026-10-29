/**
 * Ops runbooks surfaced on the Blame tab — keyed by live DPA / posture signals.
 */

export type PlaybookKey = 'lock_waits' | 'plan_regression' | 'vacuum_risk' | 'rpo';

export type PlaybookStep = {
  label: string;
  href?: string;
  detail?: string;
};

export type PlaybookView = {
  key: PlaybookKey;
  title: string;
  reason: string;
  steps: PlaybookStep[];
};

export type BlamePlaybookSignals = {
  instanceId: number;
  alias: string;
  engine: string;
  /** Share of non-idle wait samples in Lock class (0–100). */
  lockWaitPct: number | null;
  activeLockEpisodes: number;
  blockedSessions: number;
  /** Top wait-blamed queryid with a plan shape change, if any. */
  planRegressionQueryid: string | null;
  vacuumRiskTables: number;
  rpoAtRisk: boolean;
};

const LOCK_WAIT_PCT_THRESHOLD = 12;

export function resolveBlamePlaybooks(signals: BlamePlaybookSignals): PlaybookView[] {
  const out: PlaybookView[] = [];
  const base = `/instances/${signals.instanceId}`;

  const lockHot =
    signals.blockedSessions > 0 ||
    signals.activeLockEpisodes > 0 ||
    (signals.lockWaitPct ?? 0) >= LOCK_WAIT_PCT_THRESHOLD;

  if (lockHot) {
    out.push({
      key: 'lock_waits',
      title: 'Lock waits',
      reason:
        signals.blockedSessions > 0
          ? `${signals.blockedSessions} blocked session(s) now`
          : signals.activeLockEpisodes > 0
            ? `${signals.activeLockEpisodes} active lock episode(s)`
            : `Lock wait class ≈ ${signals.lockWaitPct?.toFixed(0) ?? '?'}% of samples`,
      steps: [
        {
          label: 'Identify root blocker in Blocking chain',
          href: `${base}/blame`,
          detail: 'Use cancel/kill on live blocker pid when actions are enabled.',
        },
        {
          label: 'Cancel blocker query or kill session if safe',
          href: `${base}/locks`,
          detail: 'Prefer cancel_query on the holding pid before kill_session.',
        },
        {
          label: 'Confirm wait class Lock drops on timeline',
          href: `${base}/blame`,
        },
      ],
    });
  }

  if (signals.planRegressionQueryid) {
    const qid = signals.planRegressionQueryid;
    out.push({
      key: 'plan_regression',
      title: 'Plan regression',
      reason: `Fingerprint changed for queryid ${qid}`,
      steps: [
        {
          label: 'Compare auto-plan fingerprints (Queries diff)',
          href: `${base}/queries/${qid}`,
          detail: 'Review PlanFingerprintDiff vs prior capture; correlate with Change timeline.',
        },
        {
          label: 'Check plan_regression finding',
          href: `${base}/analysis`,
        },
        {
          label: 'Roll back deploy or add index if shape regressed',
          href: `${base}/indexes`,
        },
      ],
    });
  }

  if (signals.engine === 'postgres' && signals.vacuumRiskTables > 0) {
    out.push({
      key: 'vacuum_risk',
      title: 'Vacuum / bloat',
      reason: `${signals.vacuumRiskTables} table(s) over dead/bloat/freeze thresholds`,
      steps: [
        {
          label: 'Open Vacuum tab — sort by dead tuples or xid age',
          href: `${base}/vacuum`,
        },
        {
          label: 'Schedule VACUUM (ANALYZE) on worst tables off-peak',
          href: `${base}/vacuum?orden=muertas`,
        },
        {
          label: 'Re-check autovacuum_enabled on flagged tables',
          href: `${base}/vacuum`,
        },
      ],
    });
  }

  if (signals.rpoAtRisk) {
    out.push({
      key: 'rpo',
      title: 'RPO / prove restore',
      reason: 'Backup or replication exposure exceeds target (or unproven)',
      steps: [
        {
          label: 'Walk Prove restore checklist on this instance',
          href: `${base}/blame#prove-restore`,
        },
        {
          label: 'Confirm latest backup / archive on Backups',
          href: `${base}/backups`,
        },
        {
          label: 'Review Estate RPO posture',
          href: '/estate/rpo',
        },
      ],
    });
  }

  return out;
}

export const PLAYBOOK_KEYS: PlaybookKey[] = ['lock_waits', 'plan_regression', 'vacuum_risk', 'rpo'];
