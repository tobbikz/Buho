import Link from 'next/link';
import { StatCard, toneForMinimum, toneForPct } from '@/components/StatCard';
import { TimeseriesPanel } from '@/components/TimeseriesPanel';
import { formatBytes, formatNumber, formatPct } from '@/lib/format';
import { getLabeled, getSeries } from '@/lib/queries';

/**
 * Resumen de instancia MongoDB.
 *
 * Preguntas que sí se pueden contestar con serverStatus/dbStats: conexiones,
 * ops/s, memoria residente y tamaño. Sin waits ni statement digests todavía.
 */

const COLOR = {
  accent: '#005eb8',
  success: '#0a6e42',
  warning: '#9a4a00',
  error: '#b01818',
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
  const [connections, ops, mem, size, dbs] = await Promise.all([
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
    getSeries(instanceId, ['database_size_bytes'], windowMinutes, bucketSeconds, 'sum'),
    getLabeled(instanceId, 'database_size_bytes', 8, 60),
  ]);

  const conn = ultimo(connections, 'connections_total');
  const used = ultimo(connections, 'connections_used_pct');
  const resident = ultimo(mem, 'mongo_mem_resident_mb');
  const cache = ultimo(mem, 'db_cache_hit_pct');
  const bytes = ultimo(size, 'database_size_bytes');

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <section className="panel" style={{ borderLeft: '3px solid var(--accent)' }}>
        <div className="panel-body text-[12px] text-foreground-secondary">
          MongoDB en Búho v0.4: métricas de <span className="font-mono">serverStatus</span> y{' '}
          <span className="font-mono">dbStats</span>. El inventario completo está en{' '}
          <Link href={`/instances/${instanceId}/inventory`} className="underline">
            Inventario
          </Link>
          ; la proyección de disco en{' '}
          <Link href={`/instances/${instanceId}/capacity`} className="underline">
            Capacidad
          </Link>
          .
        </div>
      </section>

      <div className="stat-grid">
        <StatCard label="Conexiones" value={formatNumber(conn)} tone="accent" />
        <StatCard
          label="Uso de conexiones"
          value={used === null ? '—' : formatPct(used, 1)}
          tone={toneForPct(used, 70, 90)}
        />
        <StatCard
          label="RAM residente"
          value={resident === null ? '—' : `${formatNumber(resident, 0)} MB`}
        />
        <StatCard
          label="Cache WT hit"
          value={cache === null ? '—' : formatPct(cache, 1)}
          tone={toneForMinimum(cache, 90, 80)}
        />
        <StatCard label="Tamaño datos+índices" value={bytes === null ? '—' : formatBytes(bytes)} />
      </div>

      <div className="grid grid-cols-1 gap-[0.875rem] xl:grid-cols-2">
        <TimeseriesPanel
          title="Conexiones"
          hint={windowHint}
          data={connections}
          unit="count"
          series={[
            { metric: 'connections_total', label: 'Actuales', color: COLOR.accent },
            { metric: 'mongo_cursors_open', label: 'Cursores', color: COLOR.warning },
          ]}
        />
        <TimeseriesPanel
          title="Operaciones por segundo"
          hint={windowHint}
          data={ops}
          unit="rate"
          series={[
            { metric: 'mongo_op_query_per_sec', label: 'query', color: COLOR.accent },
            { metric: 'mongo_op_insert_per_sec', label: 'insert', color: COLOR.success },
            { metric: 'mongo_op_update_per_sec', label: 'update', color: COLOR.warning },
            { metric: 'mongo_op_delete_per_sec', label: 'delete', color: COLOR.error },
            { metric: 'mongo_op_command_per_sec', label: 'command', color: '#7a828c' },
          ]}
        />
        <TimeseriesPanel
          title="Memoria residente"
          hint={windowHint}
          data={mem}
          unit="count"
          series={[{ metric: 'mongo_mem_resident_mb', label: 'Resident MB', color: COLOR.accent }]}
        />
        <TimeseriesPanel
          title="Cache WiredTiger"
          hint={windowHint}
          data={mem}
          unit="pct"
          series={[{ metric: 'db_cache_hit_pct', label: 'Hit %', color: COLOR.success }]}
        />
      </div>

      {dbs.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <span className="panel-title">Bases por tamaño</span>
          </div>
          <div className="panel-body">
            <ul className="space-y-1 font-mono text-[12px]">
              {dbs.map((row) => {
                const name =
                  row.labels['database'] ??
                  (Object.values(row.labels).join('/') || '(sin nombre)');
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
