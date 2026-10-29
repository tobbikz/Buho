import type { Finding } from '../types';
import type { ComplianceRunResult } from './types';

export const CIS_DRIFT_CHECK_ID = 'cis_drift';
export const CIS_DRIFT_TITLE = 'CIS compliance drift';

export interface ComplianceRunSnapshot {
  pack: string;
  score: number;
  ranAt: Date;
  controls?: ComplianceRunResult['controls'];
}

export interface CisDriftOptions {
  /** Minimum score drop (points) before emitting a finding. */
  scoreDropThreshold?: number;
  /** Score drop treated as critical. */
  scoreDropCritical?: number;
}

/**
 * Compare the latest compliance run to the previous one for the same pack.
 * Emits `cis_drift` findings when the score falls or individual controls regress.
 */
export function evaluateCisDrift(
  latest: ComplianceRunSnapshot,
  previous: ComplianceRunSnapshot | null | undefined,
  options: CisDriftOptions = {},
): Finding[] {
  if (!previous || latest.pack !== previous.pack) return [];

  const threshold = options.scoreDropThreshold ?? 5;
  const criticalAt = options.scoreDropCritical ?? 15;
  const findings: Finding[] = [];
  const delta = previous.score - latest.score;

  if (delta >= threshold) {
    findings.push({
      severity: delta >= criticalAt ? 'critical' : 'warning',
      object: latest.pack,
      message: `CIS score dropped ${delta} points (${previous.score} → ${latest.score}) since the prior run.`,
      remediation:
        'Open Platform → Compliance, diff failed controls against the previous run, and revert configuration drift on the instance.',
      value: delta,
    });
  }

  const prevById = new Map((previous.controls ?? []).map((control) => [control.id, control]));
  for (const control of latest.controls ?? []) {
    const before = prevById.get(control.id);
    if (before?.verdict === 'pass' && control.verdict === 'fail') {
      findings.push({
        severity: control.severity === 'critical' ? 'critical' : 'warning',
        object: `${latest.pack}:${control.id}`,
        message: `Control regressed to fail: ${control.title}. ${control.evidence}`,
        remediation: control.remediation ?? 'Restore settings required by the CIS benchmark for this control.',
      });
    }
  }

  return findings;
}

export function cisDriftCheckResults(
  latest: ComplianceRunSnapshot,
  previous: ComplianceRunSnapshot | null | undefined,
  options?: CisDriftOptions,
) {
  return evaluateCisDrift(latest, previous, options).map((finding) => ({
    ...finding,
    checkId: CIS_DRIFT_CHECK_ID,
    title: CIS_DRIFT_TITLE,
  }));
}
