import Link from 'next/link';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kafka / CDC · Búho' };

type Row = {
  instance_id: number;
  alias: string;
  engine: string;
  last_seen_at: Date | null;
  lag: number | null;
  under_repl: number | null;
  brokers: number | null;
};

export default async function KafkaFleetPage() {
  let rows: Row[] = [];
  try {
    rows = await query<Row>(
      `select i.instance_id, i.alias, i.engine, i.last_seen_at,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'kafka_group_lag_total'
                order by m.ts desc limit 1) as lag,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'kafka_under_replicated_partitions'
                order by m.ts desc limit 1) as under_repl,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'kafka_brokers'
                order by m.ts desc limit 1) as brokers
         from buho.instances i
        where i.engine in ('kafka', 'cdc')
        order by i.alias`,
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title">Kafka / CDC</span>
        <Link className="text-[11px]" href="/get-started">
          Add instance
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          No Kafka/CDC instances yet. Add a target with engine <code>kafka</code> or <code>cdc</code>{' '}
          (see DEEP_PLATFORM.md).
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Alias</th>
              <th>Engine</th>
              <th>Brokers</th>
              <th>Lag</th>
              <th>Under-repl</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.instance_id}>
                <td>
                  <Link href={`/instances/${r.instance_id}`}>{r.alias}</Link>
                </td>
                <td>{r.engine}</td>
                <td>{r.brokers ?? '—'}</td>
                <td>{r.lag ?? '—'}</td>
                <td>{r.under_repl ?? '—'}</td>
                <td>{r.last_seen_at ? String(r.last_seen_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
