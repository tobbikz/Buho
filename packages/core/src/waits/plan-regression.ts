/**
 * Detect structural plan change for the same queryid (DPA-style regression signal).
 */

export interface PlanRegression {
  queryid: number;
  previousFingerprint: string;
  currentFingerprint: string;
  previousCost: number | null;
  currentCost: number | null;
  costDeltaPct: number | null;
  message: string;
}

export function detectPlanRegression(input: {
  queryid: number;
  previous: { fingerprint: string; totalCost: number | null };
  current: { fingerprint: string; totalCost: number | null };
}): PlanRegression | null {
  if (input.previous.fingerprint === input.current.fingerprint) return null;
  let costDeltaPct: number | null = null;
  if (
    input.previous.totalCost != null &&
    input.current.totalCost != null &&
    input.previous.totalCost > 0
  ) {
    costDeltaPct =
      ((input.current.totalCost - input.previous.totalCost) / input.previous.totalCost) * 100;
  }
  const costBit =
    costDeltaPct != null
      ? ` cost ${costDeltaPct >= 0 ? '+' : ''}${costDeltaPct.toFixed(0)}%`
      : '';
  return {
    queryid: input.queryid,
    previousFingerprint: input.previous.fingerprint,
    currentFingerprint: input.current.fingerprint,
    previousCost: input.previous.totalCost,
    currentCost: input.current.totalCost,
    costDeltaPct,
    message: `Plan shape changed for queryid ${input.queryid}${costBit} (${input.previous.fingerprint.slice(0, 8)} → ${input.current.fingerprint.slice(0, 8)})`,
  };
}
