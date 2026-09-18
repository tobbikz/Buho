import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { InstanceConfig } from './types';

export interface RetentionConfig {
  rawDays: number;
  rollup5mDays: number;
  rollup1hDays: number;
  /** Los episodios de bloqueo son pocos y valen oro en un postmortem. */
  lockEpisodeDays: number;
  statementDays: number;
  /** Planes de ejecución pedidos desde la consola; son pocos y ligeros. */
  planDays: number;
  logDays: number;
  checkResultDays: number;
  collectorEventDays: number;
  healthScoreDays: number;
  /** Sin muestras durante este tiempo → instancia unreachable (resuelve alertas zombie). */
  unreachableAfterMinutes: number;
}

export interface CollectorConfig {
  statementTimeoutMs: number;
  connectTimeoutMs: number;
  instanceCycleBudgetMs: number;
  retention: RetentionConfig;
}

export interface BuhoConfig {
  store: { url: string };
  collector: CollectorConfig;
  instances: InstanceConfig[];
}

const DEFAULT_COLLECTOR: CollectorConfig = {
  statementTimeoutMs: 5_000,
  connectTimeoutMs: 5_000,
  instanceCycleBudgetMs: 20_000,
  retention: {
    // Product floor: ~90 days of operable history (rollups / statements).
    // Raw samples stay short — they are the expensive part of the store.
    rawDays: 7,
    rollup5mDays: 90,
    rollup1hDays: 400,
    lockEpisodeDays: 90,
    statementDays: 90,
    planDays: 90,
    logDays: 90,
    checkResultDays: 90,
    collectorEventDays: 90,
    healthScoreDays: 90,
    unreachableAfterMinutes: 5,
  },
};

export async function loadConfig(path = process.env['BUHO_CONFIG'] ?? 'config.json'): Promise<BuhoConfig> {
  const raw = await readFile(resolve(path), 'utf8');
  const parsed = JSON.parse(raw) as Partial<BuhoConfig>;

  const storeUrl = process.env['BUHO_STORE_URL'] ?? parsed.store?.url;
  if (!storeUrl) {
    throw new Error('Falta la URL del store: definir store.url en el config o BUHO_STORE_URL.');
  }
  // Instances are optional in config.json: production installs add targets from
  // the console (buho.monitor_targets). File-based instances remain supported
  // for labs and air-gapped bootstrap.
  const instances = parsed.instances ?? [];

  // Un motor mal escrito ("postgresql", "sqlserver") tiene que fallar en el
  // arranque con el nombre del alias, no convertirse en un intento silencioso de
  // hablar PostgreSQL con un SQL Server.
  const engines = new Set(['postgres', 'mariadb', 'mssql', 'mongodb']);
  for (const instance of instances) {
    const engine = instance.engine ?? 'postgres';
    if (!engines.has(engine)) {
      throw new Error(
        `La instancia "${instance.alias}" declara engine "${engine}"; los valores válidos son ${[...engines].join(', ')}.`,
      );
    }

    // Una etiqueta con valor numérico o nulo llegaría al store como "null" o
    // "3" y aparecería como un grupo con ese nombre. Mejor fallar acá con el
    // alias en el mensaje.
    // La lectura del log toca el sistema operativo del servidor vigilado. Un
    // error de configuración acá tiene que fallar al arrancar y no convertirse
    // en una pantalla vacía que parezca "no hay errores".
    const logs = instance.logs;
    if (logs?.source && logs.source !== 'none') {
      if (!['journal', 'file'].includes(logs.source)) {
        throw new Error(
          `La instancia "${instance.alias}" declara logs.source = "${logs.source}". ` +
            'Los valores válidos son "journal" (systemd), "file" (archivos) o "none".',
        );
      }
      if (logs.access === 'ssh' && !logs.target) {
        throw new Error(
          `La instancia "${instance.alias}" lee el log por SSH pero no declara logs.target. ` +
            'Hace falta "usuario@servidor".',
        );
      }
    }

    for (const [key, value] of Object.entries(instance.tags ?? {})) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(
          `La instancia "${instance.alias}" tiene la etiqueta "${key}" sin un valor de texto. ` +
            'Las etiquetas son pares clave/valor de texto: { "grupo": "core-cr" }.',
        );
      }
    }
  }

  return {
    store: { url: storeUrl },
    collector: {
      ...DEFAULT_COLLECTOR,
      ...parsed.collector,
      retention: { ...DEFAULT_COLLECTOR.retention, ...parsed.collector?.retention },
    },
    instances,
  };
}

/** Permite pasar credenciales por variables de entorno en vez del archivo. */
export function instanceFromEnv(): InstanceConfig | null {
  const host = process.env['PGHOST'];
  const database = process.env['PGDATABASE'];
  const user = process.env['PGUSER'];
  if (!host || !database || !user) return null;
  return {
    alias: process.env['BUHO_ALIAS'] ?? `${host}/${database}`,
    host,
    port: Number(process.env['PGPORT'] ?? 5432),
    database,
    user,
    password: process.env['PGPASSWORD'],
    environment: process.env['BUHO_ENVIRONMENT'] ?? 'prod',
  };
}

export function instanceFromUrl(url: string, alias?: string): InstanceConfig {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) throw new Error('La URL no incluye base de datos.');
  return {
    alias: alias ?? `${parsed.hostname}/${database}`,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl: parsed.searchParams.get('sslmode') === 'require',
  };
}
