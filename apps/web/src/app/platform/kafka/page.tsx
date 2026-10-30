import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kafka · Búho' };

type Row = {
  instance_id: number;
  alias: string;
  last_seen_at: Date | null;
  lag: number | null;
  under_repl: number | null;
  brokers: number | null;
};

export default async function KafkaFleetPage() {
  let rows: Row[] = [];
  try {
    rows = await query<Row>(
      `select i.instance_id, i.alias, i.last_seen_at,
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
        where i.engine = 'kafka'
          and coalesce(i.retired, false) = false
        order by i.alias`,
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const totalLag = rows.reduce((n, r) => n + (r.lag ?? 0), 0);
  const underRepl = rows.reduce((n, r) => n + (r.under_repl ?? 0), 0);
  const brokers = rows.reduce((n, r) => n + (r.brokers ?? 0), 0);

  return (
    <div className="flex flex-col gap-[1.25rem]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5 min-w-0 max-w-[52rem]">
          <h1 className="text-[1.1rem] font-semibold m-0">Kafka</h1>
          <p className="text-[12px] text-foreground-secondary m-0">
            Cluster brokers, consumer-group lag, under-replicated partitions. CDC apply lag lives on
            the CDC tab — it is a separate overlay on the source databases.
          </p>
        </div>
        <Link className="btn btn--primary text-[11px] shrink-0" href="/admin/targets?engine=kafka">
          Add Kafka
        </Link>
      </header>

      {rows.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">No Kafka targets</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            <p className="m-0">
              Add a broker cluster from Admin → Databases (engine Kafka), or re-enable a retired lab
              target (e.g. kafka-lab) and wait for the collector cycle. Consumer groups are set on the
              same form for lag tracking.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Clusters" value={String(rows.length)} tone="neutral" />
            <StatCard label="Brokers" value={String(brokers || '—')} tone="neutral" />
            <StatCard
              label="Group lag"
              value={String(totalLag)}
              tone={totalLag > 0 ? 'warn' : 'ok'}
            />
            <StatCard
              label="Under-replicated"
              value={String(underRepl)}
              tone={underRepl > 0 ? 'error' : 'ok'}
            />
          </div>
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Fleet</span>
            </div>
            <div className="panel-body p-0 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Alias</th>
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
                      <td>{r.brokers ?? '—'}</td>
                      <td>{r.lag ?? '—'}</td>
                      <td>{r.under_repl ?? '—'}</td>
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
