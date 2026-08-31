import type { EngineKind } from '../engine';

/**
 * Inventario del parque: el estado que se pregunta una vez por hora y no cada
 * cinco segundos. Es la parte del producto que sí se puede unificar entre
 * motores, porque son preguntas de negocio ("¿esta versión tiene soporte?",
 * "¿cuándo fue el último backup?") y no de implementación.
 */

export interface EngineInfo {
  engine: EngineKind;
  versionNum: number | null;
  versionText: string;
  /** Sólo SQL Server: Enterprise, Standard, Developer, Express. */
  edition?: string | null;
  productLevel?: string | null;
  updateLevel?: string | null;
  collation?: string | null;
  startedAt?: Date | null;
  cores?: number | null;
  memoryBytes?: number | null;
  eolDate?: string | null;
}

export interface SettingRow {
  name: string;
  value: string;
  unit?: string | null;
  category?: string | null;
  isDefault?: boolean | null;
  requiresRestart?: boolean | null;
}

export interface DiskObject {
  kind: 'database' | 'file' | 'tablespace' | 'volume';
  name: string;
  container?: string;
  sizeBytes?: number | null;
  usedBytes?: number | null;
  freeBytes?: number | null;
  maxBytes?: number | null;
  location?: string | null;
  detail?: Record<string, unknown>;
}

export interface ReplicationRow {
  /**
   * `standby` es un standby visto desde su primario; `upstream` es el enlace de
   * una réplica con el primario del que recibe. Separarlos evita que una
   * réplica vigilada se liste a sí misma como su propio standby.
   */
  role: 'primary' | 'standby' | 'upstream' | 'slot' | 'replica' | 'availability_group';
  peer?: string;
  state?: string | null;
  lagBytes?: number | null;
  lagSeconds?: number | null;
  detail?: Record<string, unknown>;
}

export interface BackupRow {
  database: string;
  kind: 'full' | 'differential' | 'log' | 'wal_archive';
  finishedAt?: Date | null;
  sizeBytes?: number | null;
  /** 'msdb' es un catálogo real; 'pg_stat_archiver' es una inferencia. */
  source: string;
  detail?: Record<string, unknown>;
}

export interface JobRow {
  scope?: string;
  name: string;
  enabled?: boolean | null;
  lastRunAt?: Date | null;
  lastStatus?: string | null;
  lastDurationMs?: number | null;
  nextRunAt?: Date | null;
  detail?: Record<string, unknown>;
}

export interface LicensingRow {
  edition?: string | null;
  licenseModel?: string | null;
  cores?: number | null;
  coresLimit?: number | null;
  memoryBytes?: number | null;
  memoryLimitBytes?: number | null;
  /** null = no aplica (motor libre). false = hay un problema real. */
  productionOk?: boolean | null;
  note?: string | null;
  detail?: Record<string, unknown>;
}

export type InventoryDomain =
  | 'engine'
  | 'settings'
  | 'disk'
  | 'replication'
  | 'backups'
  | 'jobs'
  | 'licensing';

/**
 * Por qué un dominio está vacío o incompleto. Es tan parte del resultado como
 * los datos: un tab de Backups vacío sin explicación parece un bug, y el DBA
 * pierde la confianza en todo lo demás que muestra la herramienta.
 */
export interface InventoryNote {
  domain: InventoryDomain;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface InventorySnapshot {
  engine: EngineInfo;
  settings: SettingRow[];
  disks: DiskObject[];
  replication: ReplicationRow[];
  backups: BackupRow[];
  jobs: JobRow[];
  licensing: LicensingRow | null;
  notes: InventoryNote[];
}

export function emptySnapshot(engine: EngineInfo): InventorySnapshot {
  return {
    engine,
    settings: [],
    disks: [],
    replication: [],
    backups: [],
    jobs: [],
    licensing: null,
    notes: [],
  };
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function date(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
