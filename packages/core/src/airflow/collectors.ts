import type { ForeignCollector } from '../foreign/types';
import type { Sample } from '../types';

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
      const samples: Sample[] = [];
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
  {
    id: 'airflow_dag_runs',
    tier: 'normal',
    description: 'Recent DAG runs via REST (~ fleet)',
    sql: () => JSON.stringify({ airflow: 'dagRuns', dagId: '~', limit: 100 }),
    toSamples: (rows) => {
      const runs = asArray(rows[0]?.['dag_runs'] ?? rows[0]?.['dagRuns'] ?? rows[0]?.['items']);
      let failed = 0;
      let running = 0;
      let queued = 0;
      let success = 0;
      for (const r of runs) {
        const state = String(r['state'] ?? '').toLowerCase();
        if (state === 'failed') failed += 1;
        else if (state === 'running') running += 1;
        else if (state === 'queued') queued += 1;
        else if (state === 'success') success += 1;
      }
      return [
        { metric: 'airflow_runs_sampled', value: runs.length },
        { metric: 'airflow_runs_failed_sample', value: failed },
        { metric: 'airflow_runs_running', value: running },
        { metric: 'airflow_runs_queued', value: queued },
        { metric: 'airflow_runs_success_sample', value: success },
      ];
    },
  },
  {
    id: 'airflow_meta_kpis',
    tier: 'normal',
    description: 'Metadata DB KPIs (failed/open runs, tasks, DAG inventory)',
    sql: () => JSON.stringify({ airflow: 'metaKpis' }),
    toSamples: (rows) => {
      const doc = rows[0] ?? {};
      if (doc['linked'] !== true) {
        return [{ metric: 'airflow_meta_linked', value: 0 }];
      }
      const samples: Sample[] = [
        { metric: 'airflow_meta_linked', value: 1 },
        { metric: 'airflow_failed_runs_24h', value: Number(doc['failed_runs_24h'] ?? 0) },
        { metric: 'airflow_open_runs', value: Number(doc['open_runs'] ?? 0) },
        { metric: 'airflow_running_runs', value: Number(doc['running_runs'] ?? 0) },
        { metric: 'airflow_queued_runs', value: Number(doc['queued_runs'] ?? 0) },
        { metric: 'airflow_failed_tasks_24h', value: Number(doc['failed_tasks_24h'] ?? 0) },
        { metric: 'airflow_meta_dags_total', value: Number(doc['dags_total'] ?? 0) },
        { metric: 'airflow_meta_dags_active', value: Number(doc['dags_active'] ?? 0) },
        { metric: 'airflow_meta_dags_paused', value: Number(doc['dags_paused'] ?? 0) },
        { metric: 'airflow_meta_import_errors', value: Number(doc['import_errors'] ?? 0) },
      ];
      const pools = asArray(doc['pools']);
      for (const p of pools) {
        const name = String(p['name'] ?? 'default');
        samples.push(
          {
            metric: 'airflow_meta_pool_slots',
            value: Number(p['slots'] ?? 0),
            labels: { pool: name },
          },
          {
            metric: 'airflow_meta_pool_occupied',
            value: Number(p['occupied'] ?? 0),
            labels: { pool: name },
          },
        );
      }
      return samples;
    },
  },
];
