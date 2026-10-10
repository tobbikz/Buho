import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatNumber, formatPct } from '@/lib/format';
import { getLabeled, getSeries } from '@/lib/queries';
import { peakOf } from '@/lib/series-peak';

/**
 * Resumen de instancia MongoDB.
 *
 * serverStatus: connections, ops, memoria, red, WiredTiger cache/tickets,
 * global lock queue. Sin query profiler todavía.
 */

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
  muted: '#7a828c',
};

function ultimo(points: Array<Record<string, number | null>>, metric: string): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const valor = points[index]?.[metric];
    if (valor !== null && valor !== undefined) return valor;
  }
  return null;
}

export async function MongoSummary({
  instanceId,
  windowMinutes,
  bucketSeconds,
  windowHint,
}: {
  instanceId: number;
  windowMinutes: number;
  bucketSeconds: number;
  windowHint: string;
}) {
  const [connections, ops, mem, wt, network, locks, repl, size, dbs, live, asserts, nsHeat] =
    await Promise.all([
    getSeries(
      instanceId,
      ['connections_total', 'connections_used_pct', 'mongo_cursors_open'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      [
        'mongo_op_insert_per_sec',
        'mongo_op_query_per_sec',
        'mongo_op_update_per_sec',
        'mongo_op_delete_per_sec',
        'mongo_op_command_per_sec',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['mongo_mem_resident_mb', 'db_cache_hit_pct'], windowMinutes, bucketSeconds),
    getSeries(
      instanceId,
      [
        'mongo_wt_cache_used_pct',
        'mongo_tickets_read_used_pct',
        'mongo_tickets_write_used_pct',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['mongo_net_in_bytes_per_sec', 'mongo_net_out_bytes_per_sec'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['mongo_global_lock_queue', 'mongo_global_lock_readers', 'mongo_global_lock_writers'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['replication_lag_seconds', 'mongo_repl_members', 'mongo_repl_state'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['database_size_bytes'], windowMinutes, bucketSeconds, 'sum'),
    getLabeled(instanceId, 'database_size_bytes', 8, 60),
    getSeries(
      instanceId,
      ['mongo_ops_active', 'mongo_ops_waiting_lock', 'mongo_ops_slow', 'mongo_ops_longest_seconds'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      [
        'mongo_asserts_user_per_sec',
        'mongo_asserts_warning_per_sec',
        'db_tup_inserted_per_sec',
        'db_tup_updated_per_sec',
        'db_tup_deleted_per_sec',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getLabeled(instanceId, 'mongo_ns_total_time_per_sec', 8, 30),
  ]);

  const conn = ultimo(connections, 'connections_total');
  const used = ultimo(connections, 'connections_used_pct');
  const resident = ultimo(mem, 'mongo_mem_resident_mb');
  const cache = ultimo(mem, 'db_cache_hit_pct');
  const bytes = ultimo(size, 'database_size_bytes');
  const wtUsed = ultimo(wt, 'mongo_wt_cache_used_pct');
  const ticketsRead = ultimo(wt, 'mongo_tickets_read_used_pct');
  const ticketsWrite = ultimo(wt, 'mongo_tickets_write_used_pct');
  const lockQueue = ultimo(locks, 'mongo_global_lock_queue');
  const replLag = ultimo(repl, 'replication_lag_seconds');
  const replMembers = ultimo(repl, 'mongo_repl_members');
  const opsActive = ultimo(live, 'mongo_ops_active');
  const opsSlow = ultimo(live, 'mongo_ops_slow');
  const opsWaiting = ultimo(live, 'mongo_ops_waiting_lock');

  const peakConn = peakOf(connections, 'connections_used_pct');
  const peakQuery = peakOf(ops, 'mongo_op_query_per_sec');
  const peakWt = peakOf(wt, 'mongo_wt_cache_used_pct');

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
        <div className="panel-body text-[12px] text-foreground-secondary">
          MongoDB: <span className="font-mono">serverStatus</span>,{' '}
          <span className="font-mono">dbStats</span>, <span className="font-mono">currentOp</span>,{' '}
          <span className="font-mono">top</span>. Sessions / Locks sample active ops; Host needs{' '}
          <span className="font-mono">hostMetrics</span>. No SQL profiler (expensive) — slow ops appear
          when <span className="font-mono">secs_running ≥ 1</span>.
        </div>
      </section>

      <div className="stat-grid">
        <StatCard label="Connections" value={formatNumber(conn)} tone="accent" />
        <StatCard
          label="Connection usage"
          value={used === null ? '—' : formatPct(used, 1)}
          tone={toneForPct(used, 70, 90)}
        />
        <StatCard
          label="Resident RAM"
          value={resident === null ? '—' : `${formatNumber(resident, 0)} MB`}
        />
        <StatCard
          label="Cache WT hit"
          value={cache === null ? '—' : formatPct(cache, 1)}
          tone={toneForMinimum(cache, 90, 80)}
        />
        <StatCard label="Data+index size" value={bytes === null ? '—' : formatBytes(bytes)} />
      </div>

      <div className="stat-grid">
        <StatCard
          label="WT cache used"
          value={wtUsed === null ? '—' : formatPct(wtUsed, 1)}
          tone={toneForPct(wtUsed, 80, 95)}
          hint="bytes in cache / max"
        />
        <StatCard
          label="Read tickets"
          value={ticketsRead === null ? '—' : formatPct(ticketsRead, 0)}
          tone={toneForPct(ticketsRead, 70, 90)}
          hint="concurrentTransactions.read out/total"
        />
        <StatCard
          label="Write tickets"
          value={ticketsWrite === null ? '—' : formatPct(ticketsWrite, 0)}
          tone={toneForPct(ticketsWrite, 70, 90)}
          hint="concurrentTransactions.write out/total"
        />
        <StatCard
          label="Global lock queue"
          value={lockQueue === null ? '—' : formatNumber(lockQueue)}
          tone={lockQueue !== null && lockQueue > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Replica set"
          value={
            replMembers === null || replMembers <= 0
              ? 'standalone'
              : `${formatNumber(replMembers, 0)} members`
          }
          hint={
            replLag === null
              ? 'from replSetGetStatus'
              : `lag ${formatNumber(replLag, 1)}s`
          }
          tone={replLag !== null && replLag > 30 ? 'warn' : undefined}
        />
      </div>

      <div className="stat-grid">
        <StatCard
          label="Active ops"
          value={opsActive === null ? '—' : formatNumber(opsActive)}
          hint="currentOp active"
          tone="accent"
        />
        <StatCard
          label="Waiting on lock"
          value={opsWaiting === null ? '—' : formatNumber(opsWaiting)}
          tone={opsWaiting !== null && opsWaiting > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Slow ops (≥1s)"
          value={opsSlow === null ? '—' : formatNumber(opsSlow)}
          tone={opsSlow !== null && opsSlow > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label="Peak conn util"
          value={peakConn === null ? '—' : formatPct(peakConn, 1)}
          tone={toneForPct(peakConn, 70, 90)}
        />
        <StatCard
          label="Peak query/s"
          value={peakQuery === null ? '—' : formatNumber(peakQuery, 1)}
          unit={peakQuery === null ? undefined : '/s'}
        />
        <StatCard
          label="Peak WT cache"
          value={peakWt === null ? '—' : formatPct(peakWt, 1)}
          tone={toneForPct(peakWt, 80, 95)}
        />
      </div>

      <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
        <TimeseriesPanel
          title="Connections"
          hint={windowHint}
          data={connections}
          unit="count"
          series={[
            { metric: 'connections_total', label: 'Current', color: COLOR.accent },
            { metric: 'mongo_cursors_open', label: 'Cursors', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Operations per second"
          hint={windowHint}
          data={ops}
          unit="rate"
          series={[
            { metric: 'mongo_op_query_per_sec', label: 'query', color: COLOR.accent },
            { metric: 'mongo_op_insert_per_sec', label: 'insert', color: COLOR.success },
            { metric: 'mongo_op_update_per_sec', label: 'update', color: COLOR.warning },
            { metric: 'mongo_op_delete_per_sec', label: 'delete', color: COLOR.error },
            { metric: 'mongo_op_command_per_sec', label: 'command', color: COLOR.muted },
          ]}
        />
        <TimeseriesPanel
          title="WiredTiger cache & tickets"
          hint={windowHint}
          data={wt}
          unit="pct"
          series={[
            { metric: 'mongo_wt_cache_used_pct', label: 'cache used %', color: COLOR.accent },
            { metric: 'mongo_tickets_read_used_pct', label: 'read tickets %', color: COLOR.success },
            { metric: 'mongo_tickets_write_used_pct', label: 'write tickets %', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Network"
          hint={windowHint}
          data={network}
          unit="bytes"
          series={[
            { metric: 'mongo_net_in_bytes_per_sec', label: 'in', color: COLOR.success },
            { metric: 'mongo_net_out_bytes_per_sec', label: 'out', color: COLOR.accent },
          ]}
        />
        <TimeseriesPanel
          title="Global lock queue"
          hint={windowHint}
          data={locks}
          unit="count"
          series={[
            { metric: 'mongo_global_lock_queue', label: 'total', color: COLOR.error },
            { metric: 'mongo_global_lock_readers', label: 'readers', color: COLOR.accent },
            { metric: 'mongo_global_lock_writers', label: 'writers', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Replica set lag"
          hint={windowHint}
          data={repl}
          unit="count"
          series={[
            { metric: 'replication_lag_seconds', label: 'lag s', color: COLOR.error },
            { metric: 'mongo_repl_members', label: 'members', color: COLOR.muted },
          ]}
        />
        <TimeseriesPanel
          title="Resident memory"
          hint={windowHint}
          data={mem}
          unit="count"
          series={[{ metric: 'mongo_mem_resident_mb', label: 'Resident MB', color: COLOR.accent }]}
        />
        <TimeseriesPanel
          title="Live operations (currentOp)"
          hint={`${windowHint} · active / lock wait / slow ≥1s`}
          data={live}
          unit="count"
          series={[
            { metric: 'mongo_ops_active', label: 'active', color: COLOR.accent, filled: true },
            { metric: 'mongo_ops_waiting_lock', label: 'waiting lock', color: COLOR.error },
            { metric: 'mongo_ops_slow', label: 'slow ≥1s', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Document ops /s"
          hint={`${windowHint} · metrics.document`}
          data={asserts}
          unit="rate"
          series={[
            { metric: 'db_tup_inserted_per_sec', label: 'inserted', color: COLOR.success },
            { metric: 'db_tup_updated_per_sec', label: 'updated', color: COLOR.accent },
            { metric: 'db_tup_deleted_per_sec', label: 'deleted', color: COLOR.error },
          ]}
        />
        <TimeseriesPanel
          title="Asserts /s"
          hint={`${windowHint} · user + warning`}
          data={asserts}
          unit="rate"
          series={[
            { metric: 'mongo_asserts_user_per_sec', label: 'user', color: COLOR.warning },
            { metric: 'mongo_asserts_warning_per_sec', label: 'warning', color: COLOR.error },
          ]}
        />
      </div>

      {nsHeat.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Hot namespaces (top)</span>
            <span className="font-mono text-[10px] text-foreground-muted">time/s</span>
          </div>
          <div className="panel-body">
            <ul className="space-y-1 font-mono text-[12px]">
              {nsHeat.map((row) => {
                const name = `${row.labels['schema'] ?? '?'}.${row.labels['table'] ?? '?'}`;
                return (
                  <li key={name} className="flex justify-between gap-4">
                    <span className="truncate">{name}</span>
                    <span>{formatNumber(row.value, 0)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}

      {dbs.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Databases by size</span>
          </div>
          <div className="panel-body">
            <ul className="space-y-1 font-mono text-[12px]">
              {dbs.map((row) => {
                const name =
                  row.labels['database'] ??
                  (Object.values(row.labels).join('/') || '(unnamed)');
                return (
                  <li key={name} className="flex justify-between gap-4">
                    <span>{name}</span>
                    <span>{formatBytes(row.value)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}
