import { Pool } from 'pg';
import type { InstanceConfig } from './types';

/**
 * Se identifica en pg_stat_activity para que el DBA del cliente vea de
 * inmediato quién se está conectando a su base.
 */
export const APPLICATION_NAME = 'buho_collector';

export interface PoolOptions {
  statementTimeoutMs?: number;
  connectTimeoutMs?: number;
  applicationName?: string;
  max?: number;
}

/**
 * Un pool por instancia monitoreada, con timeouts estrictos: si la base que
 * monitoreamos se cuelga, Búho no se cuelga con ella.
 */
export function createPool(instance: InstanceConfig, opts: PoolOptions = {}): Pool {
  const statementTimeout = opts.statementTimeoutMs ?? 5_000;
  return new Pool({
    host: instance.host,
    port: instance.port,
    database: instance.database,
    user: instance.user,
    password: instance.password,
    ssl: instance.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: opts.applicationName ?? APPLICATION_NAME,
    max: opts.max ?? 2,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
    // El colector nunca escribe ni abre transacciones largas, pero si algo
    // se va de las manos preferimos que el servidor lo corte.
    idle_in_transaction_session_timeout: 10_000,
    allowExitOnIdle: true,
  });
}

export function instanceKey(instance: InstanceConfig): string {
  return `${instance.host}:${instance.port}/${instance.database}`;
}
