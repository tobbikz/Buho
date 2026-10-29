import type { Finding } from './types';
import type { ForeignCheckDefinition } from './mariadb';

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

export const AIRFLOW_CHECKS: ForeignCheckDefinition[] = [
  {
    id: 'airflow_unhealthy',
    title: 'Airflow component health',
    description: 'Scheduler / metadatabase health',
    sql: () => JSON.stringify({ airflow: 'health' }),
    evaluate: (rows) => {
      const doc = rows[0] ?? {};
      if (doc['ok'] === false) {
        return [
          {
            severity: 'critical',
            object: 'airflow',
            message: `Health check failed: ${doc['error'] ?? 'unknown'}`,
            remediation: 'Check scheduler and metadata DB; review Airflow logs.',
          } satisfies Finding,
        ];
      }
      const findings: Finding[] = [];
      const meta = (doc['metadatabase'] as Record<string, unknown> | undefined)?.['status'];
      const sched = (doc['scheduler'] as Record<string, unknown> | undefined)?.['status'];
      if (meta && String(meta).toLowerCase() !== 'healthy') {
        findings.push({
          severity: 'critical',
          object: 'metadatabase',
          message: `Metadatabase status: ${meta}`,
          remediation: 'Restore Airflow metadata DB connectivity.',
        });
      }
      if (sched && String(sched).toLowerCase() !== 'healthy') {
        findings.push({
          severity: 'critical',
          object: 'scheduler',
          message: `Scheduler status: ${sched}`,
          remediation: 'Restart scheduler; check DAG parse time and pools.',
        });
      }
      return findings;
    },
  },
  {
    id: 'airflow_import_errors',
    title: 'DAG import errors',
    description: 'Broken DAG files prevent scheduling',
    sql: () => JSON.stringify({ airflow: 'importErrors' }),
    evaluate: (rows) => {
      const errs = asArray(
        rows[0]?.['import_errors'] ?? rows[0]?.['importErrors'] ?? rows[0]?.['items'],
      );
      const total = Number(rows[0]?.['total_entries'] ?? rows[0]?.['totalEntries'] ?? errs.length);
      if (total <= 0) return [];
      return [
        {
          severity: total >= 5 ? 'critical' : 'warning',
          object: 'import_errors',
          message: `${total} DAG import error(s).`,
          remediation: 'Fix Python/import errors in DAG files; check airflow dags list-import-errors.',
          value: total,
        } satisfies Finding,
      ];
    },
  },
  {
    id: 'airflow_pool_saturation',
    title: 'Pool saturation',
    description: 'Pools with no open slots',
    sql: () => JSON.stringify({ airflow: 'pools' }),
    evaluate: (rows) => {
      const pools = asArray(rows[0]?.['pools'] ?? rows[0]?.['items']);
      const findings: Finding[] = [];
      for (const p of pools) {
        const name = String(p['name'] ?? p['pool'] ?? 'default');
        const open = Number(p['open_slots'] ?? p['openSlots'] ?? 0);
        const slots = Number(p['slots'] ?? 0);
        if (slots > 0 && open <= 0) {
          findings.push({
            severity: 'warning',
            object: name,
            message: `Pool "${name}" has 0 open slots (${slots} total).`,
            remediation: 'Raise pool slots or reduce concurrency / stuck tasks.',
            value: slots,
          });
        }
      }
      return findings;
    },
  },
];
