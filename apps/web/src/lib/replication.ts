import { query } from './db';

export interface InstanceReplicationRow {
  role: string;
  peer: string;
  state: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  detail: Record<string, unknown>;
  capturedAt: Date;
}

/**
 * Estado de replicación de una instancia.
 *
 * A diferencia de la vista de parque, acá no se deduplica por servidor: se está
 * mirando una instancia concreta y sus pares, y esconder una fila porque otra
 * instancia del mismo host ya la reportó dejaría la pantalla incompleta.
 */
export async function getInstanceReplication(instanceId: number): Promise<InstanceReplicationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select role, peer, state, lag_bytes, lag_seconds, detail, captured_at
       from buho.replication_state
      where instance_id = $1
      order by case role
                 when 'primary' then 0
                 when 'standby' then 1
                 when 'replica' then 2
                 else 3
               end,
               peer`,
    [instanceId],
  );

  return rows.map((row) => ({
    role: String(row['role'] ?? ''),
    peer: String(row['peer'] ?? ''),
    state: (row['state'] as string | null) ?? null,
    lagBytes: row['lag_bytes'] === null ? null : Number(row['lag_bytes']),
    lagSeconds: row['lag_seconds'] === null ? null : Number(row['lag_seconds']),
    detail: (row['detail'] as Record<string, unknown>) ?? {},
    capturedAt: row['captured_at'] as Date,
  }));
}
