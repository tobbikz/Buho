import Link from 'next/link';
import { NotesPanel } from '@/components/NotesPanel';
import { StatCard } from '@/components/StatCard';
import { StoreError } from '@/components/StoreError';
import { formatBytes, formatDuration } from '@/lib/format';
import { ENGINE_LABEL, getNotes, getReplication, type ReplicationRow } from '@/lib/estate';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  primary: 'Primario',
  standby: 'Réplica conectada',
  replica: 'Este servidor es réplica',
  slot: 'Slot de replicación',
  availability_group: 'Grupo de disponibilidad',
};

/**
 * Un slot inactivo es el problema más caro de esta pantalla: retiene WAL para
 * un consumidor que ya no existe y llena el disco del primario en silencio.
 */
function isDangerous(row: ReplicationRow): boolean {
  if (row.role === 'slot' && row.state === 'inactivo') return true;
  if (row.role === 'replica' && row.state !== 'Yes') return true;
  if ((row.lagSeconds ?? 0) > 300) return true;
  return false;
}

export default async function ReplicationPage() {
  let rows: ReplicationRow[];
  let notes;
  try {
    [rows, notes] = await Promise.all([getReplication(), getNotes('replication')]);
  } catch (error) {
    return <StoreError message={error instanceof Error ? error.message : String(error)} />;
  }

  // `upstream` cuenta como réplica: es una instancia vigilada que aplica WAL de
  // un primario. Si ese primario no está en el parque, esta es la única fila que
  // demuestra que la replicación existe.
  const withReplicas = rows.filter(
    (row) => row.role === 'standby' || row.role === 'upstream' || row.role === 'availability_group',
  );
  const alone = rows.filter((row) => row.role === 'primary');
  const danger = rows.filter(isDangerous);
  const retained = rows
    .filter((row) => row.role === 'slot')
    .reduce((sum, row) => sum + (row.lagBytes ?? 0), 0);

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="stat-grid">
        <StatCard
          label="Sin alta disponibilidad"
          value={String(alone.length)}
          hint="instancias sin réplica ni grupo"
          tone={alone.length > 0 ? 'warn' : 'ok'}
        />
        <StatCard label="Réplicas conectadas" value={String(withReplicas.length)} tone={withReplicas.length > 0 ? 'ok' : 'neutral'} />
        <StatCard
          label="Requieren atención"
          value={String(danger.length)}
          hint="slots inactivos, réplicas caídas o lag alto"
          tone={danger.length > 0 ? 'error' : 'ok'}
        />
        <StatCard
          label="WAL retenido por slots"
          value={formatBytes(retained)}
          hint="espacio que el primario no puede liberar"
          tone={retained > 10 * 1024 ** 3 ? 'error' : retained > 1024 ** 3 ? 'warn' : 'ok'}
        />
      </div>

      <NotesPanel notes={notes} title="Qué lee Búho de cada motor" />

      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">Topología de replicación</span>
          <span className="font-mono text-[10px] text-foreground-muted">
            PostgreSQL: réplicas y slots · MariaDB: binlog y GTID · SQL Server: AlwaysOn y mirroring
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">Sin datos de replicación todavía.</div>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 'none' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instancia</th>
                  <th>Motor</th>
                  <th>Rol</th>
                  <th>Par</th>
                  <th>Estado</th>
                  <th className="text-right">Lag</th>
                  <th className="text-right">Bytes retenidos</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.instanceId}-${row.role}-${row.peer}-${index}`}>
                    <td>
                      <Link href={`/instances/${row.instanceId}`} className="underline decoration-dotted">
                        {row.alias}
                      </Link>
                    </td>
                    <td className="text-[11px] text-foreground-secondary">
                      {ENGINE_LABEL[row.engine] ?? row.engine}
                    </td>
                    <td>{ROLE_LABEL[row.role] ?? row.role}</td>
                    <td className="font-mono text-[11px]">{row.peer || '·'}</td>
                    <td>
                      <span
                        className={`tag ${
                          isDangerous(row) ? 'tag--error' : row.role === 'primary' ? 'tag--muted' : 'tag--ok'
                        }`}
                      >
                        {row.state ?? 'desconocido'}
                      </span>
                    </td>
                    <td className="num">
                      {row.lagSeconds === null ? '·' : formatDuration(row.lagSeconds)}
                    </td>
                    <td className="num">{row.lagBytes === null ? '·' : formatBytes(row.lagBytes)}</td>
                    <td className="max-w-0 truncate font-mono text-[10px] text-foreground-muted">
                      {Object.entries(row.detail)
                        .filter(([, value]) => value !== null && value !== '')
                        .map(([key, value]) => `${key}=${value}`)
                        .join(' ') || '·'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
