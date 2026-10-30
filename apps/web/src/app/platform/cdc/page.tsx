import Link from 'next/link';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'CDC · Búho' };

type Row = {
  instance_id: number;
  alias: string;
  last_seen_at: Date | null;
  lag: number | null;
  datasync_up: number | null;
};

export default async function CdcFleetPage() {
  let rows: Row[] = [];
  try {
    rows = await query<Row>(
      `select i.instance_id, i.alias, i.last_seen_at,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'kafka_group_lag_total'
                order by m.ts desc limit 1) as lag,
              (select value from buho.metric_samples m
                where m.instance_id = i.instance_id and m.metric = 'cdc_datasync_up'
                order by m.ts desc limit 1) as datasync_up
         from buho.instances i
        where i.engine = 'cdc'
          and coalesce(i.retired, false) = false
        order by i.alias`,
    );
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  const applyLag = rows.reduce((n, r) => n + (r.lag ?? 0), 0);
  const healthy = rows.filter((r) => r.datasync_up === 1).length;

  return (
    <div className="flex flex-col gap-[1.25rem]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5 min-w-0 max-w-[52rem]">
          <h1 className="text-[1.1rem] font-semibold m-0">CDC</h1>
          <p className="text-[12px] text-foreground-secondary m-0">
            Change-data capture overlays (Debezium / DataSync apply). Enable capture on the{' '}
            <em>source database</em> first, then point Búho at the pipeline — this tab is not the
            Kafka cluster itself.
          </p>
        </div>
        <Link className="btn btn--primary text-[11px] shrink-0" href="/admin/targets?engine=cdc">
          Add CDC overlay
        </Link>
      </header>

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Activate on the source DB</span>
        </div>
        <div className="panel-body text-[12px] text-foreground-secondary space-y-3">
          <div>
            <div className="font-semibold text-foreground mb-1">PostgreSQL</div>
            <ul className="m-0 pl-4 space-y-1">
              <li>
                Set <code>wal_level = logical</code> (restart required).
              </li>
              <li>
                Create a publication / slot for the tables you stream (Debezium uses{' '}
                <code>pgoutput</code>; older stacks use <code>wal2json</code> — install that
                extension only if your connector requires it).
              </li>
              <li>
                Grant the connector role <code>REPLICATION</code> + <code>SELECT</code> on published
                tables.
              </li>
            </ul>
          </div>
          <div>
            <div className="font-semibold text-foreground mb-1">MariaDB / MySQL</div>
            <ul className="m-0 pl-4 space-y-1">
              <li>
                Enable binary logging (<code>log_bin=ON</code>, row format) and a dedicated
                replication user.
              </li>
              <li>No extra DB extension — the connector reads the binlog.</li>
            </ul>
          </div>
          <div>
            <div className="font-semibold text-foreground mb-1">SQL Server</div>
            <ul className="m-0 pl-4 space-y-1">
              <li>
                Enable CDC on the database/tables (<code>sys.sp_cdc_enable_db</code> /{' '}
                <code>sp_cdc_enable_table</code>) or use Always On / change tracking per your
                connector.
              </li>
            </ul>
          </div>
          <p className="m-0 text-foreground-muted">
            After the source streams into Kafka (or DataSync), add the CDC target in Admin with
            brokers, apply consumer groups, topics, and optional DataSync health URL. Source
            instances stay under the Databases fleet; this tab tracks pipeline health only.
          </p>
        </div>
      </section>

      {rows.length === 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">No CDC overlays yet</span>
          </div>
          <div className="panel-body text-[12px] text-foreground-secondary">
            <p className="m-0">
              When the pipeline exists, use <strong>Add CDC overlay</strong> — Búho will track apply
              lag and DataSync health. Retired lab targets (e.g. cdc-lab) stay hidden until re-enabled
              in Admin → Databases.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Overlays" value={String(rows.length)} tone="neutral" />
            <StatCard
              label="DataSync up"
              value={`${healthy}/${rows.length}`}
              tone={healthy === rows.length ? 'ok' : 'error'}
            />
            <StatCard
              label="Apply lag"
              value={String(applyLag)}
              tone={applyLag > 0 ? 'warn' : 'ok'}
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
                    <th>DataSync</th>
                    <th>Apply lag</th>
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
                            r.datasync_up === 1
                              ? 'tag--ok'
                              : r.datasync_up === 0
                                ? 'tag--error'
                                : 'tag--muted'
                          }`}
                        >
                          {r.datasync_up === 1 ? 'up' : r.datasync_up === 0 ? 'down' : '—'}
                        </span>
                      </td>
                      <td>{r.lag ?? '—'}</td>
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
