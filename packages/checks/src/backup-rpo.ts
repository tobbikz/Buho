import type { BackupEvidenceRow, RpoEvaluation } from '@buho/core';
import { evaluateRpo } from '@buho/core';
import type { CheckResult, Severity } from './types';

/** Row shape from `buho.backup_jobs` (store / agents). */
export interface BackupJobRow {
  kind: string;
  status: string;
  finishedAt: Date | null;
  startedAt?: Date | null;
}

export function backupJobsToEvidence(rows: BackupJobRow[]): BackupEvidenceRow[] {
  return rows.map((r) => ({
    kind: r.kind,
    finishedAt: r.finishedAt,
    status: r.status,
  }));
}

function severityForRpo(status: RpoEvaluation['status']): Severity {
  if (status === 'breached' || status === 'broken') return 'critical';
  if (status === 'unknown') return 'warning';
  return 'info';
}

/**
 * RPO breach findings from backup job history (W5 catalog tables).
 */
export function evaluateBackupRpoFindings(
  jobs: BackupJobRow[],
  rpoSeconds: number,
  now = new Date(),
): CheckResult[] {
  const evaluation = evaluateRpo(backupJobsToEvidence(jobs), rpoSeconds, now);
  if (evaluation.status === 'met') return [];

  return [
    {
      checkId: 'backup.rpo',
      title: 'Backup RPO',
      severity: severityForRpo(evaluation.status),
      object: evaluation.latestKind ?? 'backup',
      message: evaluation.message,
      remediation:
        'Verify backup agent schedules, storage targets, and last successful job in backup_jobs. Set instance backup.rpoSeconds to the contractual target.',
      value: evaluation.ageSeconds ?? undefined,
    },
  ];
}

export { evaluateRpo };
export type { BackupEvidenceRow, RpoEvaluation };
