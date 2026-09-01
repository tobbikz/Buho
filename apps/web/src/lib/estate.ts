import { query } from './db';

/**
 * Consultas del **parque**: inventario a nivel flota.
 *
 * Todas responden la misma forma de pregunta —"¿qué servidor está mal?"— y por
 * eso viven a nivel flota y no dentro de una instancia. "¿Cuál de mis catorce
 * servidores no tiene backup?" no se responde entrando a los catorce.
 *
 * Lee el último estado conocido, no series de tiempo: el colector reemplaza
 * estas filas cada hora.
 *
 * **Un servidor es (host, puerto), no una fila del config.** En Búho una
 * "instancia" es host:puerto/base, y tener dos entradas contra el mismo clúster
 * es normal y útil para métricas y checks por base. Pero versiones, parámetros,
 * bases, tablespaces, volúmenes y replicación son objetos del **clúster**: cada
 * entrada los enumera todos. Sin colapsar por servidor, el parque contaba el
 * doble de disco y comparaba un servidor contra sí mismo. De ahí el
 * `distinct on (host, port, ...)` que se repite en estas consultas.
 */

export type EngineKind = 'postgres' | 'mariadb' | 'mssql' | 'mongodb';

export const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
};

export interface EstateInstance {
  instanceId: number;
  alias: string;
  engine: string;
  host: string;
  port: number;
  environment: string;
  lastSeenAt: Date | null;
}

export interface EngineRow extends EstateInstance {
  versionText: string;
  versionNum: number | null;
  edition: string | null;
  productLevel: string | null;
  updateLevel: string | null;
  collation: string | null;
  startedAt: Date | null;
  cores: number | null;
  memoryBytes: number | null;
  eolDate: string | null;
  capturedAt: Date | null;
}

function base(row: Record<string, unknown>): EstateInstance {
  return {
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine'] ?? 'postgres'),
    host: String(row['host'] ?? ''),
    port: Number(row['port'] ?? 0),
    environment: String(row['environment'] ?? 'prod'),
    lastSeenAt: row['last_seen_at'] ? new Date(row['last_seen_at'] as string) : null,
  };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value: unknown): Date | null {
  return value ? new Date(value as string) : null;
}

/**
 * El driver de pg devuelve las columnas `date` como objetos Date, no como
 * texto, así que un `.slice(0, 10)` directo revienta.
 *
 * Se arma con los componentes locales en vez de toISOString(): la fecha llega
 * como medianoche local y convertirla a UTC la corre un día hacia atrás en
 * cualquier zona al oeste de Greenwich.
 */
function dateOnly(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${parsed.getFullYear()}-${month}-${day}`;
}

// ------------------------------------------------------------------ versiones

export async function getEngineVersions(): Promise<EngineRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (i.host, i.port)
            i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            e.version_text, e.version_num, e.edition, e.product_level, e.update_level,
            e.server_collation, e.started_at, e.cores, e.memory_bytes, e.eol_date, e.captured_at
       from buho.instances i
       left join buho.engine_info e using (instance_id)
      order by i.host, i.port, i.instance_id`,
  );

  return rows.map((row) => ({
    ...base(row),
    versionText: String(row['version_text'] ?? 'not inventoried'),
    versionNum: num(row['version_num']),
    edition: (row['edition'] as string | null) ?? null,
    productLevel: (row['product_level'] as string | null) ?? null,
    updateLevel: (row['update_level'] as string | null) ?? null,
    collation: (row['server_collation'] as string | null) ?? null,
    startedAt: date(row['started_at']),
    cores: num(row['cores']),
    memoryBytes: num(row['memory_bytes']),
    eolDate: dateOnly(row['eol_date']),
    capturedAt: date(row['captured_at']),
  }));
}

// -------------------------------------------------------------------- backups

export interface BackupRow extends EstateInstance {
  database: string;
  kind: string;
  finishedAt: Date | null;
  sizeBytes: number | null;
  source: string;
  detail: Record<string, unknown>;
}

export async function getBackups(): Promise<BackupRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (i.host, i.port, b.database, b.kind)
            i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            b.database, b.kind, b.finished_at, b.size_bytes, b.source, b.detail
       from buho.instances i
       join buho.backup_state b using (instance_id)
      order by i.host, i.port, b.database, b.kind, i.instance_id`,
  );

  return rows.map((row) => ({
    ...base(row),
    database: String(row['database']),
    kind: String(row['kind']),
    finishedAt: date(row['finished_at']),
    sizeBytes: num(row['size_bytes']),
    source: String(row['source'] ?? ''),
    detail: (row['detail'] as Record<string, unknown>) ?? {},
  })).sort((a, b) => {
    // Lo más viejo (y lo que never ocurrió) primero: es el orden en el que
    // alguien quiere leer una lista de respaldos.
    const left = a.finishedAt?.getTime() ?? 0;
    const right = b.finishedAt?.getTime() ?? 0;
    return left - right || a.alias.localeCompare(b.alias);
  });
}

/**
 * Ventana tolerable por tipo de respaldo, en horas.
 *
 * No son umbrales configurables todavía, y el valor está en que sean
 * explícitos: un log de transactions de hace un día significa que se puede
 * perder un día de trabajo, y eso no depende de la opinión de nadie.
 */
export const BACKUP_STALE_HOURS: Record<string, number> = {
  full: 24 * 7,
  differential: 24,
  log: 4,
  wal_archive: 1,
};

/**
 * Tres estados distintos que es tentador confundir en uno:
 *
 * - `sin_recuperacion`: el servidor **no puede** recuperarse. Un catálogo real
 *   que dice "never respaldada", o el archivado de WAL apagado.
 * - `atrasado`: hay respaldo, pero older than its tolerance window.
 * - `no_verificable`: el motor no lleva catálogo, así que Búho no lo sabe. No
 *   es un fallo del servidor y contarlo como tal sería mentir en la dirección
 *   contraria: alarmar por algo que quizá está perfecto.
 *
 * Vive acá y no en la pantalla del parque porque el informe semanal tiene que
 * clasificar exactamente igual: si discrepan, el cliente lee dos verdades.
 */
export type BackupState = 'sin_recuperacion' | 'atrasado' | 'no_verificable' | 'ok';

export function backupAgeHours(row: BackupRow): number | null {
  if (!row.finishedAt) return null;
  return (Date.now() - row.finishedAt.getTime()) / 3_600_000;
}

export function backupState(row: BackupRow): BackupState {
  const archiveMode = row.detail['archive_mode'] as string | undefined;
  if (archiveMode === 'off') return 'sin_recuperacion';

  const age = backupAgeHours(row);
  if (age === null) {
    // msdb es un catálogo real: sin fecha significa que never ocurrió.
    return row.source === 'msdb' ? 'sin_recuperacion' : 'no_verificable';
  }

  const limit = BACKUP_STALE_HOURS[row.kind] ?? 24;
  if (age > limit * 2) return 'sin_recuperacion';
  if (age > limit) return 'atrasado';
  return 'ok';
}

// ---------------------------------------------------------------------- disco

export interface DiskRow extends EstateInstance {
  kind: string;
  name: string;
  container: string;
  sizeBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  maxBytes: number | null;
  location: string | null;
  detail: Record<string, unknown>;
}

/**
 * Uso de disco del parque, **sin contar dos veces el mismo servidor**.
 *
 * En Búho una "instancia" es host:puerto/base, así que dos entradas del config
 * apuntando al mismo clúster son normales y útiles (métricas y checks por base).
 * Pero las bases, tablespaces y volúmenes son objetos del **clúster**: cada
 * entrada los enumera todos, y sumarlos daba el doble de datos en el parque.
 *
 * El `distinct on (host, port, ...)` colapsa por servidor físico, que es la
 * unidad correcta cuando la pregunta es "cuánto disco ocupa esto".
 */
export async function getDiskUsage(kinds: string[] = []): Promise<DiskRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (i.host, i.port, d.kind, d.container, d.name)
            i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            d.kind, d.name, d.container, d.size_bytes, d.used_bytes, d.free_bytes,
            d.max_bytes, d.location, d.detail
       from buho.instances i
       join buho.disk_objects d using (instance_id)
      where cardinality($1::text[]) = 0 or d.kind = any ($1::text[])
      order by i.host, i.port, d.kind, d.container, d.name, i.instance_id`,
    [kinds],
  );

  return rows.map((row) => ({
    ...base(row),
    kind: String(row['kind']),
    name: String(row['name']),
    container: String(row['container'] ?? ''),
    sizeBytes: num(row['size_bytes']),
    usedBytes: num(row['used_bytes']),
    freeBytes: num(row['free_bytes']),
    maxBytes: num(row['max_bytes']),
    location: (row['location'] as string | null) ?? null,
    detail: (row['detail'] as Record<string, unknown>) ?? {},
  })).sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

// ----------------------------------------------------------------------- jobs

export interface JobRow extends EstateInstance {
  scope: string;
  name: string;
  enabled: boolean | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  nextRunAt: Date | null;
  detail: Record<string, unknown>;
}

export async function getJobs(): Promise<JobRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            j.scope, j.name, j.enabled, j.last_run_at, j.last_status,
            j.last_duration_ms, j.next_run_at, j.detail
       from buho.instances i
       join buho.jobs j using (instance_id)
      order by (j.last_status = 'falló') desc nulls last, i.alias, j.name`,
  );

  return rows.map((row) => ({
    ...base(row),
    scope: String(row['scope'] ?? ''),
    name: String(row['name']),
    enabled: row['enabled'] === null ? null : row['enabled'] === true,
    lastRunAt: date(row['last_run_at']),
    lastStatus: (row['last_status'] as string | null) ?? null,
    lastDurationMs: num(row['last_duration_ms']),
    nextRunAt: date(row['next_run_at']),
    detail: (row['detail'] as Record<string, unknown>) ?? {},
  }));
}

// --------------------------------------------------------------- replicación

export interface ReplicationRow extends EstateInstance {
  role: string;
  peer: string;
  state: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  detail: Record<string, unknown>;
}

export async function getReplication(): Promise<ReplicationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (i.host, i.port, r.role, r.peer)
            i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            r.role, r.peer, r.state, r.lag_bytes, r.lag_seconds, r.detail
       from buho.instances i
       join buho.replication_state r using (instance_id)
      order by i.host, i.port, r.role, r.peer, i.instance_id`,
  );

  return rows.map((row) => ({
    ...base(row),
    role: String(row['role']),
    peer: String(row['peer'] ?? ''),
    state: (row['state'] as string | null) ?? null,
    lagBytes: num(row['lag_bytes']),
    lagSeconds: num(row['lag_seconds']),
    detail: (row['detail'] as Record<string, unknown>) ?? {},
  }));
}

// ------------------------------------------------------------------ licencias

export interface LicensingRow extends EstateInstance {
  edition: string | null;
  licenseModel: string | null;
  cores: number | null;
  coresLimit: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  productionOk: boolean | null;
  note: string | null;
  detail: Record<string, unknown>;
}

export async function getLicensing(): Promise<LicensingRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (i.host, i.port)
            i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            l.edition, l.license_model, l.cores, l.cores_limit, l.memory_bytes,
            l.memory_limit_bytes, l.production_ok, l.note, l.detail
       from buho.instances i
       left join buho.licensing l using (instance_id)
      order by i.host, i.port, i.instance_id`,
  );

  return rows.map((row) => ({
    ...base(row),
    edition: (row['edition'] as string | null) ?? null,
    licenseModel: (row['license_model'] as string | null) ?? null,
    cores: num(row['cores']),
    coresLimit: num(row['cores_limit']),
    memoryBytes: num(row['memory_bytes']),
    memoryLimitBytes: num(row['memory_limit_bytes']),
    productionOk: row['production_ok'] === null ? null : row['production_ok'] === true,
    note: (row['note'] as string | null) ?? null,
    detail: (row['detail'] as Record<string, unknown>) ?? {},
  })).sort((a, b) => Number(a.productionOk ?? 2) - Number(b.productionOk ?? 2));
}

// ------------------------------------------------------------- configuración

export interface SettingRow extends EstateInstance {
  name: string;
  value: string;
  unit: string | null;
  category: string | null;
  isDefault: boolean | null;
  requiresRestart: boolean | null;
}

export async function getSettings(): Promise<SettingRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select distinct on (i.host, i.port, s.name)
            i.instance_id, i.alias, i.engine, i.host, i.port, i.environment, i.last_seen_at,
            s.name, s.value, s.unit, s.category, s.is_default, s.requires_restart
       from buho.instances i
       join buho.server_settings s using (instance_id)
      order by i.host, i.port, s.name, i.instance_id`,
  );

  return rows.map((row) => ({
    ...base(row),
    name: String(row['name']),
    value: String(row['value'] ?? ''),
    unit: (row['unit'] as string | null) ?? null,
    category: (row['category'] as string | null) ?? null,
    isDefault: row['is_default'] === null ? null : row['is_default'] === true,
    requiresRestart: row['requires_restart'] === null ? null : row['requires_restart'] === true,
  }));
}

// ---------------------------------------------------------------------- notas

export interface NoteRow {
  instanceId: number;
  alias: string;
  engine: string;
  domain: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Las notas explican por qué un dominio está vacío o incompleto. Se muestran
 * junto a los datos, no en un rincón: un tab de Backups vacío sin explicación
 * parece un bug y le quita credibilidad a todo lo demás.
 */
export async function getNotes(domain?: string): Promise<NoteRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select i.instance_id, i.alias, i.engine, n.domain, n.level, n.message
       from buho.instances i
       join buho.inventory_notes n using (instance_id)
      where $1::text is null or n.domain = $1
      order by case n.level when 'error' then 0 when 'warn' then 1 else 2 end, i.alias`,
    [domain ?? null],
  );

  return rows.map((row) => ({
    instanceId: Number(row['instance_id']),
    alias: String(row['alias']),
    engine: String(row['engine'] ?? 'postgres'),
    domain: String(row['domain']),
    level: String(row['level']) as NoteRow['level'],
    message: String(row['message']),
  }));
}

/**
 * Motor de una instancia. Lo consultan las pantallas por instancia para no
 * renderizarle a un SQL Server la plantilla de PostgreSQL, con edad de XID y
 * `pg_stat_statements` incluidos: mostrar campos que no aplican no es un hueco
 * cosmético, hace dudar de los números que sí son ciertos.
 */
export async function getInstanceEngine(instanceId: number): Promise<string | null> {
  const rows = await query<Record<string, unknown>>(
    'select engine from buho.instances where instance_id = $1',
    [instanceId],
  );
  return rows[0] ? String(rows[0]['engine'] ?? 'postgres') : null;
}

export interface InstanceInventory {
  engine: EngineRow | null;
  backups: BackupRow[];
  disks: DiskRow[];
  jobs: JobRow[];
  replication: ReplicationRow[];
  settings: SettingRow[];
  licensing: LicensingRow | null;
  notes: NoteRow[];
}

/** Todo el inventario de una sola instancia, para su pantalla de resumen. */
export async function getInstanceInventory(instanceId: number): Promise<InstanceInventory> {
  const [engines, backups, disks, jobs, replication, settings, licensing, notes] = await Promise.all([
    getEngineVersions(),
    getBackups(),
    getDiskUsage(),
    getJobs(),
    getReplication(),
    getSettings(),
    getLicensing(),
    getNotes(),
  ]);

  const mine = <T extends { instanceId: number }>(rows: T[]) =>
    rows.filter((row) => row.instanceId === instanceId);

  return {
    engine: engines.find((row) => row.instanceId === instanceId) ?? null,
    backups: mine(backups),
    disks: mine(disks),
    jobs: mine(jobs),
    replication: mine(replication),
    settings: mine(settings),
    licensing: mine(licensing)[0] ?? null,
    notes: mine(notes),
  };
}

/** Cuántas instancias hay por motor, para el encabezado del parque. */
export async function getEngineCounts(): Promise<{ engine: string; count: number }[]> {
  const rows = await query<Record<string, unknown>>(
    `select engine, count(*) as count from buho.instances group by engine order by 2 desc`,
  );
  return rows.map((row) => ({ engine: String(row['engine']), count: Number(row['count']) }));
}
