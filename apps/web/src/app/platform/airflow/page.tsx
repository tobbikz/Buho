import Link from 'next/link';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Airflow · Búho' };

type Row = {
  instance_id: number;
  alias: string;
  last_seen_at: Date | null;
  up: number | null;
  dags: number | null;
  import_errors: number | null;
};

export default async function AirflowFleetPage() {
  let rows: Row[] = [];
  try {
    rows = await query<Row>(
      `select i.instance_id, i.alias, i.last_seen_at,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'airflow_up'
                order by m.ts desc limit 1) as up,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'airflow_dags_total'
                order by m.ts desc limit 1) as dags,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'airflow_import_error_rows'
                order by m.ts desc limit 1) as import_errors
         from buho.instances i
        where i.engine = 'airflow'
        order by i.alias`,
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Airflow</span>
        <Link className="text-[11px]" href="/get-started">
          Add instance
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          No Airflow instances yet. Add a target with engine <code>airflow</code> and REST credentials.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Alias</th>
              <th>Up</th>
              <th>DAGs</th>
              <th>Import errors</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.instance_id}>
                <td>
                  <Link href={`/instances/${r.instance_id}`}>{r.alias}</Link>
                </td>
                <td>{r.up === 1 ? 'yes' : r.up === 0 ? 'NO' : '—'}</td>
                <td>{r.dags ?? '—'}</td>
                <td>{r.import_errors ?? '—'}</td>
                <td>{r.last_seen_at ? String(r.last_seen_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
