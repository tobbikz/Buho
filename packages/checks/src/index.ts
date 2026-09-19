import type { Pool } from 'pg';
import { tagged } from '@buho/core';
import type { Capabilities } from '@buho/core';
import { CHECKS } from './definitions';
import type { CheckResult, Severity } from './types';

export { CHECKS } from './definitions';
export type { CheckDefinition, CheckResult, Finding, Severity } from './types';

export interface CheckRunError {
  checkId: string;
  message: string;
}

export interface CheckRunSummary {
  results: CheckResult[];
  errors: CheckRunError[];
  /** 0–100. Explicable a propósito: cada hallazgo resta un peso fijo. */
  healthScore: number;
}

const WEIGHT: Record<Severity, number> = {
  critical: 20,
  warning: 6,
  info: 1,
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * El puntaje penaliza **por check**, no por hallazgo: veinte índices
 * redundantes son un solo problema con veinte objetos, no veinte problemas.
 * Sin esto, una instancia sana con un patrón repetido cae a 20/100 y el
 * número deja de significar nada.
 */
export function healthScore(results: CheckResult[]): number {
  const byCheck = new Map<string, { worst: Severity; count: number }>();

  for (const result of results) {
    const current = byCheck.get(result.checkId);
    if (!current) {
      byCheck.set(result.checkId, { worst: result.severity, count: 1 });
      continue;
    }
    current.count += 1;
    if (SEVERITY_ORDER[result.severity] < SEVERITY_ORDER[current.worst]) {
      current.worst = result.severity;
    }
  }

  let penalty = 0;
  for (const { worst, count } of byCheck.values()) {
    penalty += WEIGHT[worst] * (1 + Math.min(count - 1, 4) * 0.25);
  }

  return Math.max(0, Math.round(100 - penalty));
}

/**
 * Corre el catálogo completo. Un check que falla no interrumpe a los demás, y
 * un check sin hallazgos simplemente no dice nada: la ausencia de standby o de
 * slots no debe verse como problema.
 */
export async function runChecks(pool: Pool, caps: Capabilities): Promise<CheckRunSummary> {
  const results: CheckResult[] = [];
  const errors: CheckRunError[] = [];

  for (const check of CHECKS) {
    if (check.appliesTo && !check.appliesTo(caps)) continue;
    try {
      const sql = check.sql(caps);
      const rows = sql ? ((await pool.query(tagged(sql))).rows as Record<string, unknown>[]) : [];
      for (const finding of check.evaluate(rows, caps)) {
        results.push({ ...finding, checkId: check.id, title: check.title });
      }
    } catch (error) {
      errors.push({
        checkId: check.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Se ordena por la severidad peor de cada check y se mantienen juntos sus
  // hallazgos: el informe no debe partir un mismo check en dos secciones.
  const worstByCheck = new Map<string, number>();
  for (const result of results) {
    const rank = SEVERITY_ORDER[result.severity];
    const current = worstByCheck.get(result.checkId);
    if (current === undefined || rank < current) worstByCheck.set(result.checkId, rank);
  }

  results.sort(
    (a, b) =>
      (worstByCheck.get(a.checkId) ?? 9) - (worstByCheck.get(b.checkId) ?? 9) ||
      a.checkId.localeCompare(b.checkId) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (b.value ?? 0) - (a.value ?? 0),
  );

  return { results, errors, healthScore: healthScore(results) };
}

// --------------------------------------------------- chequeos de otros motores

import type { EngineClient, ForeignCaps } from '@buho/core';
import { MARIADB_CHECKS } from './mariadb';
import { MSSQL_CHECKS } from './mssql';
import { MONGODB_CHECKS } from './mongodb';
import { REDIS_CHECKS } from './redis';
import { ORACLE_CHECKS } from './oracle';
import { CASSANDRA_CHECKS } from './cassandra';
import { ELASTICSEARCH_CHECKS } from './elasticsearch';
import type { ForeignCheckDefinition } from './mariadb';

export { MARIADB_CHECKS } from './mariadb';
export { MSSQL_CHECKS, MSSQL_PARITY_CHECKS, MSSQL_PARITY_MAP, assertMssqlParity } from './mssql';
export { MONGODB_CHECKS } from './mongodb';
export { REDIS_CHECKS } from './redis';
export { ORACLE_CHECKS } from './oracle';
export { CASSANDRA_CHECKS } from './cassandra';
export { ELASTICSEARCH_CHECKS } from './elasticsearch';
export {
  MARIADB_PARITY_CHECKS,
  MARIADB_PARITY_MAP,
  assertMariadbParity,
} from './mariadb';
export type { ForeignCheckDefinition } from './mariadb';

/**
 * Corre el catálogo del motor que corresponda.
 */
export async function runForeignChecks(client: EngineClient, caps: ForeignCaps): Promise<CheckRunSummary> {
  const catalogo: ForeignCheckDefinition[] =
    caps.engine === 'mariadb'
      ? MARIADB_CHECKS
      : caps.engine === 'mssql'
        ? MSSQL_CHECKS
        : caps.engine === 'mongodb'
          ? MONGODB_CHECKS
          : caps.engine === 'redis'
            ? REDIS_CHECKS
            : caps.engine === 'oracle'
              ? ORACLE_CHECKS
              : caps.engine === 'cassandra'
                ? CASSANDRA_CHECKS
                : caps.engine === 'elasticsearch'
                  ? ELASTICSEARCH_CHECKS
                  : [];

  const results: CheckResult[] = [];
  const errors: CheckRunError[] = [];

  for (const check of catalogo) {
    if (check.appliesTo && !check.appliesTo(caps)) continue;
    try {
      const sql = check.sql(caps);
      const rows = sql ? await client.query(sql) : [];
      for (const finding of check.evaluate(rows, caps)) {
        results.push({ ...finding, checkId: check.id, title: check.title });
      }
    } catch (error) {
      errors.push({ checkId: check.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  results.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.checkId.localeCompare(b.checkId) ||
      (b.value ?? 0) - (a.value ?? 0),
  );

  return { results, errors, healthScore: healthScore(results) };
}

export {
  customCheckId,
  definitionApplies,
  evaluateThreshold,
  findingsFromDefinition,
  runCustomAlerts,
  type CustomAlertDefinition,
  type CustomAlertRunError,
  type CustomThresholdType,
} from './custom-alerts';

export {
  ALERT_PACK_CATALOG,
  alertPackMetricNames,
  defaultAlertPack,
  evaluateAlertPack,
  mergeAlertPack,
  type AlertPackConfig,
  type PackItemMeta,
  type PackThresholds,
} from './alert-pack';
