import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Airflow · Búho' };

type Row = {
  instance_id: number;
  alias: string;
  last_seen_at: Date | null;
  up: number | null;
  scheduler: number | null;
  dags: number | null;
  dags_active: number | null;
  dags_paused: number | null;
  import_errors: number | null;
  runs_running: number | null;
  runs_queued: number | null;
  runs_failed_sample: number | null;
  meta_linked: number | null;
  failed_runs_24h: number | null;
  failed_tasks_24h: number | null;
  open_runs: number | null;
  meta_dags_active: number | null;
};

async function latestMetric(instanceId: number, metric: string): Promise<number | null> {
  const rows = await query<{ value: number }>(
    `select value from buho.metric_samples
      where instance_id = $1 and metric = $2
      order by ts desc limit 1`,
    [instanceId, metric],
  );
  return rows[0] ? Number(rows[0].value) : null;
}

export default async function AirflowFleetPage() {
  let rows: Row[] = [];
  try {
    const instances = await query<{ instance_id: number; alias: string; last_seen_at: Date | null }>(
      `select instance_id, alias, last_seen_at
         from buho.instances
        where engine = 'airflow' and coalesce(retired, false) = false
        order by alias`,
    );
    rows = await Promise.all(
      instances.map(async (i) => {
        const id = Number(i.instance_id);
        const [
          up,
          scheduler,
          dags,
          dags_active,
          dags_paused,
          import_errors,
          runs_running,
          runs_queued,
          runs_failed_sample,
          meta_linked,
          failed_runs_24h,
          failed_tasks_24h,
          open_runs,
          meta_dags_active,
        ] = await Promise.all([
          latestMetric(id, 'airflow_up'),
          latestMetric(id, 'airflow_scheduler_up'),
          latestMetric(id, 'airflow_dags_total'),
          latestMetric(id, 'airflow_dags_active'),
          latestMetric(id, 'airflow_dags_paused'),
          latestMetric(id, 'airflow_import_error_rows'),
          latestMetric(id, 'airflow_runs_running'),
          latestMetric(id, 'airflow_runs_queued'),
          latestMetric(id, 'airflow_runs_failed_sample'),
          latestMetric(id, 'airflow_meta_linked'),
          latestMetric(id, 'airflow_failed_runs_24h'),
          latestMetric(id, 'airflow_failed_tasks_24h'),
          latestMetric(id, 'airflow_open_runs'),
          latestMetric(id, 'airflow_meta_dags_active'),
        ]);
        return {
          instance_id: id,
          alias: i.alias,
          last_seen_at: i.last_seen_at,
          up,
          scheduler,
          dags,
          dags_active,
          dags_paused,
          import_errors,
          runs_running,
          runs_queued,
          runs_failed_sample,
          meta_linked,
          failed_runs_24h,
          failed_tasks_24h,
          open_runs,
          meta_dags_active,
        };
      }),
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const fleetUp = rows.filter((r) => r.up === 1).length;
  const fleetFailed = rows.reduce((n, r) => n + (r.failed_runs_24h ?? r.runs_failed_sample ?? 0), 0);
  const fleetOpen = rows.reduce(
    (n, r) => n + (r.open_runs ?? (r.runs_running ?? 0) + (r.runs_queued ?? 0)),
    0,
  );
  const fleetImport = rows.reduce((n, r) => n + (r.import_errors ?? 0), 0);
  const anyMeta = rows.some((r) => r.meta_linked === 1);

  return (
    <div className="flex flex-col gap-[1.25rem]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5 min-w-0 max-w-[52rem]">
          <h1 className="text-[1.1rem] font-semibold m-0">Airflow</h1>
          <p className="text-[12px] text-foreground-secondary m-0">
            REST health and DAG inventory from Admin → Databases. Optional metadata Postgres on the
            same form unlocks failed/open runs, tasks, and pools.
          </p>
        </div>
        <Link className="btn btn--primary text-[11px] shrink-0" href="/admin/targets?engine=airflow">
          Add Airflow
        </Link>
      </header>

      {rows.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">No Airflow targets</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            <p className="m-0">
              Add the Airflow webserver (and optionally its metadata database) from Admin → Databases
              — same place as PostgreSQL targets. Re-enable a retired lab target (e.g. airflow-mock)
              there if you expect the mock to appear.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label="Instances up"
              value={`${fleetUp}/${rows.length}`}
              tone={fleetUp === rows.length ? 'ok' : 'error'}
            />
            <StatCard
              label="Failed runs (24h / sample)"
              value={String(fleetFailed)}
              tone={fleetFailed > 0 ? 'error' : 'ok'}
            />
            <StatCard
              label="Open runs"
              value={String(fleetOpen)}
              tone={fleetOpen > 0 ? 'warn' : 'ok'}
            />
            <StatCard
              label="Import errors"
              value={String(fleetImport)}
              tone={fleetImport > 0 ? 'error' : 'ok'}
            />
          </div>

          {!anyMeta ? (
            <section className="panel">
              <div className="panel-header">
                <span className="panel-title">Metadata DB not linked</span>
                <Link className="text-[11px]" href="/admin/targets?engine=airflow">
                  Edit in Admin
                </Link>
              </div>
              <div className="panel-body text-[12px] text-foreground-secondary">
                <p className="m-0">
                  REST alone covers health + DAG list. For Superset Airflow Monitor–style KPIs, open
                  the target in Admin and fill the optional metadata Postgres fields.
                </p>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Fleet</span>
              <span className="font-mono text-[10px] text-foreground-muted">
                meta = metadata DB linked
              </span>
            </div>
            <div className="panel-body p-0 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Up</th>
                    <th>Scheduler</th>
                    <th>DAGs</th>
                    <th>Active / paused</th>
                    <th>Import err</th>
                    <th>Running / queued</th>
                    <th>Failed 24h</th>
                    <th>Tasks fail 24h</th>
                    <th>Meta</th>
                    <th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.instance_id}>
                      <td>
                        <Link href={`/instances/${r.instance_id}`}>{r.alias}</Link>
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            r.up === 1 ? 'tag--ok' : r.up === 0 ? 'tag--error' : 'tag--muted'
                          }`}
                        >
                          {r.up === 1 ? 'yes' : r.up === 0 ? 'NO' : '—'}
                        </span>
                      </td>
                      <td>{r.scheduler === 1 ? 'ok' : r.scheduler === 0 ? 'down' : '—'}</td>
                      <td>
                        {r.meta_dags_active != null || r.dags != null
                          ? (r.dags ?? r.meta_dags_active)
                          : '—'}
                      </td>
                      <td>
                        {(r.dags_active ?? r.meta_dags_active ?? '—') +
                          ' / ' +
                          (r.dags_paused ?? '—')}
                      </td>
                      <td>{r.import_errors ?? '—'}</td>
                      <td>{(r.runs_running ?? '—') + ' / ' + (r.runs_queued ?? '—')}</td>
                      <td>{r.failed_runs_24h ?? r.runs_failed_sample ?? '—'}</td>
                      <td>{r.failed_tasks_24h ?? '—'}</td>
                      <td>
                        <span className={`tag ${r.meta_linked === 1 ? 'tag--ok' : 'tag--muted'}`}>
                          {r.meta_linked === 1 ? 'linked' : 'REST only'}
                        </span>
                      </td>
                      <td className="text-[11px] text-foreground-muted">
                        {r.last_seen_at ? String(r.last_seen_at) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
