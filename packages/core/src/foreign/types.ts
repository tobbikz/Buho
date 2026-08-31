import type { EngineClient, EngineKind } from '../engine';
import type { Sample, Tier } from '../types';

/**
 * Lo que hay que saber de un motor que no es PostgreSQL antes de preguntarle
 * algo.
 *
 * Es a propósito más chico que `Capabilities`: en PostgreSQL las capacidades
 * describen qué vistas existen en cada versión, y acá la pregunta relevante es
 * casi siempre otra —si el DBA dejó encendido lo que hace falta para medir—.
 * `performance_schema` apagado en MariaDB o `Query Store` ausente en SQL Server
 * no son diferencias de versión, son decisiones del cliente, y la respuesta
 * correcta es decirlo en la consola en vez de mostrar una pantalla vacía.
 */
export interface ForeignCaps {
  engine: EngineKind;
  /** Como lo reporta el motor: '11.4.12-MariaDB', '16.0.4265.3'. */
  versionText: string;
  /** Comparable numéricamente: 110412, 160004. */
  versionNum: number;
  /** MariaDB, MySQL, Percona · Developer Edition, Enterprise… */
  flavor: string;
  startedAt: Date | null;
  /** Nombre del servidor según él mismo, para distinguir réplicas. */
  serverName: string;
  /** Rol frente a la replicación, cuando se puede saber. */
  role: 'primary' | 'replica' | 'unknown';
  /**
   * Qué se puede medir de verdad. Se consulta al arrancar y en cada reprobe,
   * porque casi todo esto se puede encender en caliente.
   */
  features: {
    /** MariaDB: performance_schema=ON. Sin esto no hay analítica de consultas. */
    statementDigests: boolean;
    /** MariaDB: sys.innodb_lock_waits / SQL Server: dm_tran_locks. */
    lockWaits: boolean;
    /** El usuario ve las sesiones de los demás (PROCESS / VIEW SERVER STATE). */
    seesAllSessions: boolean;
    /** SQL Server: Query Store activo en alguna base. */
    queryStore: boolean;
    /** SQL Server: sys.dm_hadr_* devuelve filas (hay Always On). */
    alwaysOn: boolean;
    /** MariaDB: el slow log está encendido y va a archivo. */
    slowLog: boolean;
    /** MariaDB: log_bin=ON. Sin binlog no hay replicación ni recuperación al punto. */
    binlog: boolean;
  };
  /** Lo que no se va a poder medir, en palabras, para la consola. */
  limitations: string[];
}

export interface ForeignCollector {
  id: string;
  tier: Tier;
  description: string;
  appliesTo?: (caps: ForeignCaps) => boolean;
  sql: (caps: ForeignCaps) => string;
  toSamples: (rows: Record<string, unknown>[], caps: ForeignCaps) => Sample[];
}

export interface ForeignRunResult {
  samples: Sample[];
  errors: { collectorId: string; message: string }[];
  latencyMs: number;
}

/**
 * Corre un grupo de colectores contra un motor ajeno.
 *
 * Secuencial y no en paralelo: son consultas de milisegundos a vistas en
 * memoria, y una conexión por instancia es más barata de explicarle a un DBA
 * que un pico de cinco sesiones cada diez segundos.
 */
export async function runForeignCollectors(
  client: EngineClient,
  caps: ForeignCaps,
  collectors: ForeignCollector[],
): Promise<ForeignRunResult> {
  const started = Date.now();
  const samples: Sample[] = [];
  const errors: { collectorId: string; message: string }[] = [];

  for (const collector of collectors) {
    if (collector.appliesTo && !collector.appliesTo(caps)) continue;
    try {
      const rows = await client.query(collector.sql(caps));
      samples.push(...collector.toSamples(rows, caps));
    } catch (error) {
      errors.push({
        collectorId: collector.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { samples, errors, latencyMs: Date.now() - started };
}

/** Los drivers devuelven bigint y decimal como texto; nunca confiar en el tipo. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function str(value: unknown, fallback = '(desconocido)'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}
