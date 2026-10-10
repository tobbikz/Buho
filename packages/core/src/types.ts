import type { LogConfig } from './logs';
import type { HostConfig } from './host';
import type { EngineKind } from './engine';
import type { EndpointProbeConfig } from './endpoints/probe';

export type { EndpointProbeConfig };

/** Infra device sensors (engine=infra). Shape matches @buho/sensors TargetConfig.sensors. */
export type InfraSensorConfig = {
  type: string;
  id: string;
  [key: string]: unknown;
};

export type InfraDeviceConfig = {
  /** PRTG-style role: server | switch | firewall | router | endpoint | ups | other */
  role?: string;
  sensors: InfraSensorConfig[];
};

export interface InstanceConfig {
  alias: string;
  /**
   * Ausente = postgres, para no romper las configuraciones existentes.
   * MariaDB y SQL Server entran por el inventario del parque; el pipeline de
   * métricas de 5 s y los 22 checks siguen siendo de PostgreSQL.
   * `endpoint` = sonda sintética HTTP/TCP/TLS (app layer, no SNMP).
   * `infra` = dispositivo + sensores PRTG (@buho/sensors).
   */
  engine?: EngineKind;
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  environment?: string;
  tenant?: string;
  ssl?: boolean;
  /**
   * Etiquetas libres para organizar el parque: `{ "grupo": "core-cr",
   * "equipo": "datos", "cliente": "acme" }`.
   *
   * La consola agrupa y filtra por cualquiera de estas claves. Se declaran acá
   * y no se editan desde la interfaz: ver el comentario de `instance_tags` en
   * el schema.
   */
  tags?: Record<string, string>;
  /** CPU, memoria y disco del servidor; ver HostConfig. Ausente = no se recoge. */
  hostMetrics?: HostConfig;
  /** De dónde leer el log de PostgreSQL. Apagado si no se declara. */
  logs?: LogConfig;
  /** Probe config when engine = endpoint. */
  endpoint?: EndpointProbeConfig;
  /** Device + sensors when engine = infra (also persisted in monitor_targets.endpoint jsonb). */
  infra?: InfraDeviceConfig;
}

/**
 * Estado de pg_stat_statements. `preloaded_not_created` es el caso interesante:
 * la librería ya está en shared_preload_libraries, así que se activa con un
 * CREATE EXTENSION sin reiniciar el servidor.
 */
export type StatStatementsState = 'active' | 'preloaded_not_created' | 'not_preloaded';

export interface Capabilities {
  versionNum: number;
  versionText: string;
  inRecovery: boolean;
  isSuperuser: boolean;
  hasPgMonitor: boolean;
  startedAt: Date;
  trackIoTiming: boolean;
  statStatements: StatStatementsState;
  extensions: Record<string, string>;
  /** pg_stat_io existe desde PG16 */
  hasStatIo: boolean;
  /** pg_stat_checkpointer existe desde PG17; antes las columnas vivían en pg_stat_bgwriter */
  hasStatCheckpointer: boolean;
  /** pg_stat_wal existe desde PG14 */
  hasStatWal: boolean;
  /** pg_wait_events (catálogo de descripciones) existe desde PG17 */
  hasWaitEventsCatalog: boolean;
  /** last_seq_scan / last_idx_scan existen desde PG16 */
  hasLastScanColumns: boolean;
}

export interface Sample {
  metric: string;
  value: number;
  labels?: Record<string, string>;
  /**
   * true = contador acumulado. El DeltaEngine deriva la tasa por segundo.
   */
  counter?: boolean;
  /**
   * Marca de reset del contador **de esa fila**. En pg_stat_database el
   * stats_reset es por base de datos, no por vista, así que viaja por muestra.
   */
  statsReset?: string | null;
}

export type Tier = 'fast' | 'normal' | 'slow' | 'hourly';

export interface CollectorResult {
  samples: Sample[];
}

export interface MetricCollector {
  id: string;
  tier: Tier;
  description: string;
  appliesTo?: (caps: Capabilities) => boolean;
  sql: (caps: Capabilities) => string;
  toSamples: (rows: Record<string, unknown>[], caps: Capabilities) => Sample[];
}
