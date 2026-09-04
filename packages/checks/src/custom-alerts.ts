import type { CheckResult, Finding, Severity } from './types';

/**
 * Custom SQL alerts — prod Sys_Alerts granularity inside Búho.
 *
 * Same threshold vocabulary as alerts_config.yaml: rows, no_rows, numeric,
 * freshness, text_match, numeric_per_row, numeric_max_across_rows, delta.
 * checkId becomes `custom.<name>` so rules/silences can target them.
 */

export type CustomThresholdType =
  | 'rows'
  | 'no_rows'
  | 'numeric'
  | 'freshness'
  | 'text_match'
  | 'numeric_per_row'
  | 'numeric_max_across_rows'
  | 'delta';

export interface CustomAlertDefinition {
  definitionId: number;
  name: string;
  title: string;
  enabled: boolean;
  matchInstanceId: number | null;
  matchEngine: string | null;
  severity: Severity;
  sql: string;
  thresholdType: CustomThresholdType;
  threshold: Record<string, unknown>;
  messageTemplate: string;
  remediation: string;
  recoveryMessage: string | null;
  sendRecovery: boolean;
  cooldownMinutes: number;
  displayColumns: string[];
  hysteresis: number | null;
  channelIds: number[];
}

export interface CustomAlertRunError {
  checkId: string;
  message: string;
}

export function customCheckId(name: string): string {
  return `custom.${name}`;
}

export function definitionApplies(
  def: CustomAlertDefinition,
  instanceId: number,
  engine: string,
): boolean {
  if (!def.enabled) return false;
  if (def.matchInstanceId != null && def.matchInstanceId !== instanceId) return false;
  if (def.matchEngine && def.matchEngine !== engine) return false;
  // Require at least one scope so a typo does not fan out to every instance.
  if (def.matchInstanceId == null && !def.matchEngine) return false;
  return true;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function compare(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '==':
    case '=':
      return value === threshold;
    case '!=':
      return value !== threshold;
    default:
      return value > threshold;
  }
}

function columnIndex(cols: string[], spec: unknown): number {
  if (typeof spec === 'number') return spec;
  const name = String(spec ?? '').toLowerCase();
  const idx = cols.findIndex((c) => c.toLowerCase() === name);
  return idx;
}

function parseTs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (Number.isFinite(n) && n > 1_000_000_000_000) return n;
  if (Number.isFinite(n) && n > 1_000_000_000) return n * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAllRows(
  rows: Record<string, unknown>[],
  displayColumns: string[],
  limit = 20,
): string {
  if (rows.length === 0) return '(no rows)';
  const cols =
    displayColumns.length > 0
      ? displayColumns
      : Object.keys(rows[0] ?? {}).slice(0, 4);
  const lines = rows.slice(0, limit).map((row) =>
    cols.map((col) => `${col}=${cell(row[col])}`).join(' · '),
  );
  if (rows.length > limit) lines.push(`…and ${rows.length - limit} more`);
  return lines.join('\n');
}

function renderMessage(
  template: string,
  rows: Record<string, unknown>[],
  displayColumns: string[],
  extras: Record<string, string | number> = {},
): string {
  let text = template;
  text = text.replaceAll('{rows}', String(rows.length));
  text = text.replaceAll('{all_rows}', formatAllRows(rows, displayColumns));
  for (const [key, value] of Object.entries(extras)) {
    text = text.replaceAll(`{${key}}`, String(value));
  }
  return text;
}

export interface ThresholdEval {
  fired: boolean;
  value?: number;
  /** Rows that should appear in the message / per-row findings. */
  matchedRows: Record<string, unknown>[];
}

export function evaluateThreshold(
  type: CustomThresholdType,
  threshold: Record<string, unknown>,
  rows: Record<string, unknown>[],
): ThresholdEval {
  const cols = rows[0] ? Object.keys(rows[0]) : [];

  switch (type) {
    case 'rows': {
      const minRows = Number(threshold['min_rows'] ?? 1);
      return { fired: rows.length >= minRows, value: rows.length, matchedRows: rows };
    }
    case 'no_rows':
      return { fired: rows.length === 0, value: 0, matchedRows: [] };
    case 'numeric': {
      if (rows.length === 0) return { fired: false, matchedRows: [] };
      const idx = columnIndex(cols, threshold['column'] ?? 0);
      const value = num(rows[0]?.[cols[idx] ?? cols[0] ?? '']);
      if (value === null) return { fired: false, matchedRows: [] };
      const op = String(threshold['operator'] ?? '>');
      const target = Number(threshold['value'] ?? 0);
      return {
        fired: compare(value, op, target),
        value,
        matchedRows: rows.slice(0, 1),
      };
    }
    case 'freshness': {
      if (rows.length === 0) return { fired: true, matchedRows: [] };
      const idx = columnIndex(cols, threshold['column'] ?? 0);
      const ts = parseTs(rows[0]?.[cols[idx] ?? cols[0] ?? '']);
      const maxAgeSeconds = Number(threshold['max_age_seconds'] ?? threshold['max_age'] ?? 3600);
      if (ts === null) return { fired: true, matchedRows: rows.slice(0, 1) };
      const age = (Date.now() - ts) / 1000;
      return {
        fired: age > maxAgeSeconds,
        value: age,
        matchedRows: rows.slice(0, 1),
      };
    }
    case 'text_match': {
      const idx = columnIndex(cols, threshold['column'] ?? 0);
      const needle = String(threshold['contains'] ?? threshold['equals'] ?? '');
      const mode = threshold['equals'] != null ? 'equals' : 'contains';
      const matched = rows.filter((row) => {
        const text = cell(row[cols[idx] ?? cols[0] ?? '']);
        return mode === 'equals' ? text === needle : text.includes(needle);
      });
      return { fired: matched.length > 0, value: matched.length, matchedRows: matched };
    }
    case 'numeric_per_row': {
      const idx = columnIndex(cols, threshold['column'] ?? 0);
      const op = String(threshold['operator'] ?? '>');
      const target = Number(threshold['value'] ?? 0);
      const matched = rows.filter((row) => {
        const value = num(row[cols[idx] ?? cols[0] ?? '']);
        return value !== null && compare(value, op, target);
      });
      return { fired: matched.length > 0, value: matched.length, matchedRows: matched };
    }
    case 'numeric_max_across_rows': {
      const idx = columnIndex(cols, threshold['column'] ?? 0);
      let max: number | null = null;
      for (const row of rows) {
        const value = num(row[cols[idx] ?? cols[0] ?? '']);
        if (value === null) continue;
        max = max === null ? value : Math.max(max, value);
      }
      if (max === null) return { fired: false, matchedRows: [] };
      const op = String(threshold['operator'] ?? '>');
      const target = Number(threshold['value'] ?? 0);
      return {
        fired: compare(max, op, target),
        value: max,
        matchedRows: rows,
      };
    }
    case 'delta': {
      // Expect SQL to return previous and current (or a precomputed delta column).
      if (rows.length === 0) return { fired: false, matchedRows: [] };
      const deltaCol = String(threshold['column'] ?? 'delta');
      const idx = columnIndex(cols, deltaCol);
      const value =
        idx >= 0
          ? num(rows[0]?.[cols[idx]!])
          : num(rows[0]?.['delta']) ??
            ((num(rows[0]?.['current']) ?? 0) - (num(rows[0]?.['previous']) ?? 0));
      if (value === null) return { fired: false, matchedRows: [] };
      const op = String(threshold['operator'] ?? '>');
      const target = Number(threshold['value'] ?? 0);
      return {
        fired: compare(value, op, target),
        value,
        matchedRows: rows.slice(0, 1),
      };
    }
    default:
      return { fired: false, matchedRows: [] };
  }
}

export function findingsFromDefinition(
  def: CustomAlertDefinition,
  rows: Record<string, unknown>[],
): Finding[] {
  const evalResult = evaluateThreshold(def.thresholdType, def.threshold, rows);
  if (!evalResult.fired) return [];

  const perRow = def.thresholdType === 'numeric_per_row' || def.thresholdType === 'text_match';
  if (perRow && evalResult.matchedRows.length > 0) {
    return evalResult.matchedRows.map((row) => {
      const objectCol = def.displayColumns[0];
      const object = objectCol ? cell(row[objectCol]) : undefined;
      return {
        severity: def.severity,
        object: object === '—' ? undefined : object,
        message: renderMessage(def.messageTemplate, [row], def.displayColumns, {
          value: evalResult.value ?? '',
        }),
        remediation: def.remediation,
        value: evalResult.value,
      };
    });
  }

  const objectCol = def.displayColumns[0];
  const object =
    objectCol && evalResult.matchedRows[0]
      ? cell(evalResult.matchedRows[0]![objectCol])
      : undefined;

  return [
    {
      severity: def.severity,
      object: object === '—' ? undefined : object,
      message: renderMessage(def.messageTemplate, evalResult.matchedRows, def.displayColumns, {
        value: evalResult.value ?? '',
      }),
      remediation: def.remediation || (def.recoveryMessage ?? ''),
      value: evalResult.value,
    },
  ];
}

export async function runCustomAlerts(
  definitions: CustomAlertDefinition[],
  instanceId: number,
  engine: string,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<{ results: CheckResult[]; errors: CustomAlertRunError[] }> {
  const results: CheckResult[] = [];
  const errors: CustomAlertRunError[] = [];

  for (const def of definitions) {
    if (!definitionApplies(def, instanceId, engine)) continue;
    const checkId = customCheckId(def.name);
    try {
      const rows = await query(def.sql);
      for (const finding of findingsFromDefinition(def, rows)) {
        results.push({ ...finding, checkId, title: def.title });
      }
    } catch (error) {
      errors.push({
        checkId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results, errors };
}
