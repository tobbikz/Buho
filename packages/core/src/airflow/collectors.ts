import type { ForeignCollector } from '../foreign/types';

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  return [];
}

export const AIRFLOW_COLLECTORS: ForeignCollector[] = [
  {
    id: 'airflow_health',
    tier: 'fast',
    description: 'Scheduler / metadatabase health',
    sql: () => JSON.stringify({ airflow: 'health' }),
    toSamples: (rows) => {
      const doc = rows[0] ?? {};
      const ok = doc['ok'] === true || doc['status'] === 'healthy';
      // Airflow v1 health shape: { metadatabase: {status}, scheduler: {status} }
      const meta = (doc['metadatabase'] as Record<string, unknown> | undefined)?.['status'];
      const sched = (doc['scheduler'] as Record<string, unknown> | undefined)?.['status'];
      const metaOk = meta == null || String(meta).toLowerCase() === 'healthy';
      const schedOk = sched == null || String(sched).toLowerCase() === 'healthy';
      return [
        { metric: 'airflow_up', value: ok || (metaOk && schedOk) ? 1 : 0 },
        { metric: 'airflow_scheduler_up', value: schedOk ? 1 : 0 },
        { metric: 'airflow_metadb_up', value: metaOk ? 1 : 0 },
      ];
    },
  },
  {
    id: 'airflow_dags',
    tier: 'normal',
    description: 'DAG paused / active counts',
    sql: () => JSON.stringify({ airflow: 'dags', limit: 200 }),
    toSamples: (rows) => {
      const dags = asArray(rows[0]?.['dags'] ?? rows[0]?.['items']);
      let paused = 0;
      let active = 0;
      let importErr = 0;
      for (const d of dags) {
        if (d['is_paused'] === true || d['isPaused'] === true) paused += 1;
        else active += 1;
        if (d['has_import_errors'] === true || d['hasImportErrors'] === true) importErr += 1;
      }
      return [
        { metric: 'airflow_dags_total', value: dags.length },
        { metric: 'airflow_dags_paused', value: paused },
        { metric: 'airflow_dags_active', value: active },
        { metric: 'airflow_dags_import_errors', value: importErr },
      ];
    },
  },
  {
    id: 'airflow_import_errors',
    tier: 'normal',
    description: 'DAG import error count',
    sql: () => JSON.stringify({ airflow: 'importErrors' }),
    toSamples: (rows) => {
      const errs = asArray(
        rows[0]?.['import_errors'] ?? rows[0]?.['importErrors'] ?? rows[0]?.['items'],
      );
      const total = Number(rows[0]?.['total_entries'] ?? rows[0]?.['totalEntries'] ?? errs.length);
      return [{ metric: 'airflow_import_error_rows', value: total }];
    },
  },
  {
    id: 'airflow_pools',
    tier: 'normal',
    description: 'Pool open / occupied slots',
    sql: () => JSON.stringify({ airflow: 'pools' }),
    toSamples: (rows) => {
      const pools = asArray(rows[0]?.['pools'] ?? rows[0]?.['items']);
      const samples = [];
      for (const p of pools) {
        const name = String(p['name'] ?? p['pool'] ?? 'default');
        const open = Number(p['open_slots'] ?? p['openSlots'] ?? 0);
        const occupied = Number(p['occupied_slots'] ?? p['occupiedSlots'] ?? 0);
        const slots = Number(p['slots'] ?? open + occupied);
        samples.push(
          { metric: 'airflow_pool_slots', value: slots, labels: { pool: name } },
          { metric: 'airflow_pool_open', value: open, labels: { pool: name } },
          { metric: 'airflow_pool_occupied', value: occupied, labels: { pool: name } },
        );
      }
      return samples;
    },
  },
];
