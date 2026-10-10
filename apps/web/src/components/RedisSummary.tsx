import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatNumber, formatPct } from '@/lib/format';
import { getSeries } from '@/lib/queries';
import { peakOf } from '@/lib/series-peak';

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

export async function RedisSummary({
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
  const [connections, ops, mem, hit, net, keys, persist, slow] = await Promise.all([
    getSeries(
      instanceId,
      ['connections_total', 'connections_used_pct', 'redis_blocked_clients'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['redis_instantaneous_ops', 'redis_total_commands_per_sec'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['redis_used_memory_bytes', 'redis_memory_used_pct', 'redis_mem_fragmentation_ratio'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['db_cache_hit_pct'], windowMinutes, bucketSeconds),
    getSeries(
      instanceId,
      ['redis_total_net_input_bytes_per_sec', 'redis_total_net_output_bytes_per_sec'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      ['redis_keys_total', 'redis_evicted_keys_per_sec', 'redis_expired_keys_per_sec'],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(
      instanceId,
      [
        'redis_rdb_last_bgsave_status',
        'redis_aof_enabled',
        'redis_rdb_changes_since_last_save',
        'redis_connected_slaves',
      ],
      windowMinutes,
      bucketSeconds,
    ),
    getSeries(instanceId, ['redis_slowlog_len'], windowMinutes, bucketSeconds),
  ]);

  const connPct = ultimo(connections, 'connections_used_pct');
  const memPct = ultimo(mem, 'redis_memory_used_pct');
  const hitPct = ultimo(hit, 'db_cache_hit_pct');
  const opsNow = ultimo(ops, 'redis_instantaneous_ops');
  const usedMem = ultimo(mem, 'redis_used_memory_bytes');
  const keysTotal = ultimo(keys, 'redis_keys_total');
  const blocked = ultimo(connections, 'redis_blocked_clients');

  return (
    <div className="stack gap-4">
      <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
        <div className="panel-body text-[12px] text-foreground-secondary">
          Redis: <span className="font-mono">INFO</span>, <span className="font-mono">COMMANDSTATS</span>,{' '}
          <span className="font-mono">SLOWLOG</span>, <span className="font-mono">CLIENT LIST</span>. Commands /
          Slowlog tabs are not SQL digests. Persistence tab = RDB/AOF status.
        </div>
      </section>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Clients"
          value={formatNumber(ultimo(connections, 'connections_total'))}
          hint={connPct != null ? `${formatPct(connPct)} of max` : undefined}
          tone={toneForPct(connPct, 80, 95)}
        />
        <StatCard
          label="Ops/s"
          value={formatNumber(opsNow)}
          hint={`peak ${formatNumber(peakOf(ops, 'redis_instantaneous_ops'))}`}
        />
        <StatCard
          label="Memory"
          value={usedMem != null ? formatBytes(usedMem) : '—'}
          hint={memPct != null ? `${formatPct(memPct)} of maxmemory` : 'no maxmemory'}
          tone={toneForPct(memPct, 85, 95)}
        />
        <StatCard
          label="Hit ratio"
          value={hitPct != null ? formatPct(hitPct) : '—'}
          tone={toneForMinimum(hitPct, 90, 80)}
        />
        <StatCard label="Keys" value={formatNumber(keysTotal)} />
        <StatCard
          label="Blocked"
          value={formatNumber(blocked)}
          tone={blocked && blocked > 0 ? 'warn' : 'ok'}
        />
      </div>

      <TimeseriesPanel
        title="Clients & blocked"
        hint={windowHint}
        data={connections}
        series={[
          { metric: 'connections_total', label: 'Clients', color: COLOR.accent },
          { metric: 'redis_blocked_clients', label: 'Blocked', color: COLOR.warning },
        ]}
      />
      <TimeseriesPanel
        title="Throughput"
        hint={windowHint}
        data={ops}
        series={[
          { metric: 'redis_instantaneous_ops', label: 'Instant ops/s', color: COLOR.accent },
          { metric: 'redis_total_commands_per_sec', label: 'Commands/s', color: COLOR.success },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesPanel
          title="Memory"
          hint={windowHint}
          data={mem}
          series={[
            { metric: 'redis_used_memory_bytes', label: 'Used', color: COLOR.accent },
            { metric: 'redis_memory_used_pct', label: '% maxmemory', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Network"
          hint={windowHint}
          data={net}
          unit="bytes"
          series={[
            {
              metric: 'redis_total_net_input_bytes_per_sec',
              label: 'In',
              color: COLOR.success,
            },
            {
              metric: 'redis_total_net_output_bytes_per_sec',
              label: 'Out',
              color: COLOR.accent,
            },
          ]}
        />
      </div>
      <TimeseriesPanel
        title="Keyspace"
        hint={windowHint}
        data={keys}
        series={[
          { metric: 'redis_keys_total', label: 'Keys', color: COLOR.accent },
          { metric: 'redis_evicted_keys_per_sec', label: 'Evicted/s', color: COLOR.error },
          { metric: 'redis_expired_keys_per_sec', label: 'Expired/s', color: COLOR.muted },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeseriesPanel
          title="Persistence & replicas"
          hint={windowHint}
          data={persist}
          series={[
            { metric: 'redis_rdb_last_bgsave_status', label: 'RDB ok', color: COLOR.success },
            { metric: 'redis_aof_enabled', label: 'AOF on', color: COLOR.accent },
            { metric: 'redis_connected_slaves', label: 'Slaves', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="SLOWLOG length"
          hint={windowHint}
          data={slow}
          series={[{ metric: 'redis_slowlog_len', label: 'Entries', color: COLOR.error }]}
        />
      </div>
    </div>
  );
}
