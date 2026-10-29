import { createHash } from 'node:crypto';
import type { PlanNode } from '../explain';

/**
 * Stable structural fingerprint of a plan tree (node types + relations + join keys).
 * Ignores costs/timings so regressions of *shape* are visible across captures.
 */
export function fingerprintPlan(root: PlanNode): string {
  const parts: string[] = [];
  const walk = (node: PlanNode) => {
    parts.push(
      [
        node.type,
        node.relation ?? '',
        node.joinType ?? '',
        node.indexCond ?? '',
        node.sortMethod ?? '',
      ].join('|'),
    );
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

/** Cheap hash when only plan text is available (foreign EXPLAIN). */
export function fingerprintPlanText(text: string): string {
  const normalized = text
    .replace(/\bcost=[\d.]+\.\.[\d.]+\b/gi, 'cost=?')
    .replace(/\brows=[\d]+\b/gi, 'rows=?')
    .replace(/\bwidth=[\d]+\b/gi, 'width=?')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
