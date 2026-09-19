import { isIP } from 'node:net';
import { Pool } from 'pg';
import type { InstanceConfig } from './types';
import { APPLICATION_NAME } from './pool';
import { tagged } from './tag';

/**
 * Motores que Búho sabe inventariar.
 *
 * Alcance deliberado: PostgreSQL tiene el pipeline completo (métricas cada 5 s,
 * 22 checks, consultas). MariaDB y SQL Server entran por el **inventario del
 * parque** (versiones, configuración, disco, replicación, backups, jobs,
 * licencias), que es lo que se pregunta una vez por hora y no cada 5 segundos.
 *
 * Se resiste la tentación de un "adaptador universal de métricas": las vistas de
 * estadísticas de los tres motores no se parecen, y forzarlas a un molde común
 * termina mintiendo. El inventario sí es común, porque son preguntas de negocio
 * ("¿esta versión tiene soporte?", "¿cuándo fue el último backup?") y no de
 * implementación.
 */
export type EngineKind = 'postgres' | 'mariadb' | 'mssql' | 'mongodb' | 'redis' | 'oracle';

export const ENGINE_LABEL: Record<EngineKind, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
  oracle: 'Oracle',
};

export const DEFAULT_PORT: Record<EngineKind, number> = {
  postgres: 5432,
  mariadb: 3306,
  mssql: 1433,
  mongodb: 27017,
  redis: 6379,
  oracle: 1521,
};

/**
 * Denominador común de los tres drivers: mandar texto y recibir filas.
 *
 * No se expone transacción ni streaming a propósito. El inventario son consultas
 * de lectura cortas; cualquier cosa que necesite más que esto probablemente no
 * debería ser común a los tres motores.
 */
export interface EngineClient {
  kind: EngineKind;
  query(sql: string): Promise<Record<string, unknown>[]>;
  /**
   * MongoDB / Redis: protocolo no-SQL (`serverStatus`, INFO, …).
   * Los motores SQL no lo implementan.
   */
  command?(cmd: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface EngineOptions {
  statementTimeoutMs?: number;
  connectTimeoutMs?: number;
  applicationName?: string;
}

export function engineOf(instance: InstanceConfig): EngineKind {
  return instance.engine ?? 'postgres';
}

class PostgresClient implements EngineClient {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(sql);
    return result.rows as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class MariadbClient implements EngineClient {
  readonly kind = 'mariadb' as const;

  // El driver se carga en demanda: una instalación que sólo monitorea
  // PostgreSQL no debería pagar el arranque de tres drivers.
  constructor(private readonly pool: { query: (sql: string) => Promise<unknown>; end: () => Promise<void> }) {}

  async query(sql: string): Promise<Record<string, unknown>[]> {
    // Marca al final, igual que en PostgreSQL: los digests de
    // performance_schema y la caché de planes de SQL Server guardan el texto
    // completo, así que sin la marca el ranking de consultas lo domina el
    // propio monitor.
    const [rows] = (await this.pool.query(tagged(sql))) as [unknown, unknown];
    // SHOW REPLICA STATUS devuelve un arreglo vacío cuando no hay replicación,
    // y las sentencias sin resultado devuelven un OkPacket que no es arreglo.
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class MssqlClient implements EngineClient {
  readonly kind = 'mssql' as const;

  constructor(
    private readonly pool: {
      request: () => { query: (sql: string) => Promise<{ recordset?: unknown }> };
      close: () => Promise<unknown>;
    },
  ) {}

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.request().query(tagged(sql));
    return (result.recordset as Record<string, unknown>[] | undefined) ?? [];
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/**
 * Envuelve un pool de PostgreSQL que ya existe.
 *
 * El colector ya tiene un pool por instancia con sus timeouts; el inventario lo
 * reutiliza en vez de abrir una segunda conexión al mismo servidor sólo para
 * cambiar de interfaz.
 */
export function postgresClient(pool: Pool): EngineClient {
  const client = new PostgresClient(pool);
  // close() es deliberadamente inerte: quien presta el pool sigue siendo su
  // dueño. Sin esto, un `finally { client.close() }` de buena fe mataría el pool
  // del colector y dejaría la instancia sin métricas.
  return { kind: client.kind, query: (sql) => client.query(sql), close: async () => {} };
}

export async function openEngine(
  instance: InstanceConfig,
  opts: EngineOptions = {},
): Promise<EngineClient> {
  const kind = engineOf(instance);
  const statementTimeout = opts.statementTimeoutMs ?? 10_000;
  const connectTimeout = opts.connectTimeoutMs ?? 5_000;
  const appName = opts.applicationName ?? APPLICATION_NAME;

  if (kind === 'postgres') {
    return new PostgresClient(
      new Pool({
        host: instance.host,
        port: instance.port,
        database: instance.database,
        user: instance.user,
        password: instance.password,
        ssl: instance.ssl ? { rejectUnauthorized: false } : undefined,
        application_name: appName,
        max: 1,
        connectionTimeoutMillis: connectTimeout,
        statement_timeout: statementTimeout,
        query_timeout: statementTimeout,
        allowExitOnIdle: true,
      }),
    );
  }

  if (kind === 'mariadb') {
    const mysql = await import('mysql2/promise');
    return new MariadbClient(
      mysql.createPool({
        host: instance.host,
        port: instance.port,
        user: instance.user,
        password: instance.password,
        database: instance.database || undefined,
        connectionLimit: 1,
        connectTimeout,
        // El equivalente de application_name: aparece en performance_schema y
        // en SHOW PROCESSLIST, así que el DBA ve quién se conecta.
        connectAttributes: { program_name: appName },
        ssl: instance.ssl ? { rejectUnauthorized: false } : undefined,
        // Los BIGINT de information_schema (tamaños en bytes) exceden el entero
        // seguro de JavaScript; como texto se convierten sin perder precisión.
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      }),
    );
  }

  if (kind === 'mongodb') {
    const { MongoClient } = await import('mongodb');
    const auth =
      instance.user
        ? `${encodeURIComponent(instance.user)}:${encodeURIComponent(instance.password ?? '')}@`
        : '';
    const dbName = instance.database || 'admin';
    const params = new URLSearchParams({
      appName: appName ?? 'buho',
      directConnection: 'true',
      serverSelectionTimeoutMS: String(connectTimeout),
      // Root / SCRAM users live in admin; without this, auth uses the path db (tienda) and fails.
      authSource: 'admin',
    });
    if (instance.ssl) params.set('tls', 'true');
    const uri = `mongodb://${auth}${instance.host}:${instance.port}/${dbName}?${params.toString()}`;
    const client = new MongoClient(uri);
    await client.connect();
    return new MongodbClient(client, dbName);
  }

  if (kind === 'redis') {
    const { createClient } = await import('redis');
    const dbNum = instance.database && /^\d+$/.test(instance.database) ? instance.database : '0';
    const auth =
      instance.password
        ? instance.user
          ? `${encodeURIComponent(instance.user)}:${encodeURIComponent(instance.password)}@`
          : `:${encodeURIComponent(instance.password)}@`
        : '';
    const protocol = instance.ssl ? 'rediss' : 'redis';
    const url = `${protocol}://${auth}${instance.host}:${instance.port}/${dbNum}`;
    const client = createClient({
      url,
      socket: { connectTimeout: connectTimeout },
    });
    client.on('error', () => {});
    await client.connect();
    return new RedisClient(client);
  }

  if (kind === 'oracle') {
    // Thin mode (node-oracledb 6+): no Instant Client.
    // @ts-expect-error oracledb ships JS without types in this monorepo install
    const oracledbMod = await import('oracledb');
    const oracledb = oracledbMod.default ?? oracledbMod;
    const service = instance.database || 'FREEPDB1';
    const connectString = `${instance.host}:${instance.port}/${service}`;
    const pool = await oracledb.createPool({
      user: instance.user,
      password: instance.password,
      connectString,
      poolMin: 0,
      poolMax: 1,
      poolIncrement: 1,
      connectTimeout: Math.ceil(connectTimeout / 1000),
    });
    return new OracleClient(pool, statementTimeout, oracledb.OUT_FORMAT_OBJECT);
  }

  // `mssql` es CommonJS: bajo import() dinámico sus exportaciones quedan en
  // `default` y `mssql.ConnectionPool` sale undefined.
  const imported = await import('mssql');
  const mssql = imported.default ?? imported;
  const pool = new mssql.ConnectionPool({
    server: instance.host,
    port: instance.port,
    user: instance.user,
    password: instance.password,
    database: instance.database || undefined,
    options: {
      // Los contenedores y la mayoría de instalaciones on-prem usan certificado
      // autofirmado: sin esto el driver rechaza la conexión.
      encrypt: true,
      trustServerCertificate: true,
      appName,
      // Cuando el host es una IP, tedious se la pasa igual como nombre de
      // servidor al iniciar TLS y Node la rechaza: la RFC 6066 no permite una
      // dirección en SNI. El fallo es intermitente porque sólo aparece en el
      // camino de negociación de cifrado, y un ciclo de seguridad que falla al
      // azar es peor que uno que falla siempre. Con un nombre cualquiera basta,
      // porque trustServerCertificate ya omite la validación del certificado.
      ...(isIP(instance.host) ? { serverName: 'localhost' } : {}),
    },
    connectionTimeout: connectTimeout,
    requestTimeout: statementTimeout,
    pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
  });
  await pool.connect();
  return new MssqlClient(pool);
}

class MongodbClient implements EngineClient {
  readonly kind = 'mongodb' as const;

  constructor(
    private readonly client: {
      db: (name?: string) => {
        command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
        admin: () => { command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> };
      };
      close: () => Promise<void>;
    },
    private readonly database: string,
  ) {}

  /**
   * Mongo no habla SQL. Se acepta un JSON de comando como texto para no romper
   * el contrato de EngineClient; el camino normal es `command()`.
   */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const trimmed = sql.trim();
    if (!trimmed.startsWith('{')) {
      throw new Error('MongoDB no acepta SQL; usar command() o pasar un documento JSON');
    }
    const doc = await this.command(JSON.parse(trimmed) as Record<string, unknown>);
    return [doc];
  }

  async command(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    // dbStats vive en la base configurada; el resto de admin va a admin.
    const keys = Object.keys(cmd);
    const local = keys.some((k) => ['dbStats', 'collStats', 'listCollections'].includes(k));
    const handle = local ? this.client.db(this.database) : this.client.db().admin();
    return handle.command(cmd);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class RedisClient implements EngineClient {
  readonly kind = 'redis' as const;

  constructor(
    private readonly client: {
      info: (section?: string) => Promise<string>;
      sendCommand: (args: string[]) => Promise<unknown>;
      quit: () => Promise<unknown>;
      destroy?: () => void;
    },
  ) {}

  /** JSON command docs: `{info:"all"|"memory"|…}` or `{clientList:1}`. */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const trimmed = sql.trim();
    if (!trimmed.startsWith('{')) {
      throw new Error('Redis no acepta SQL; usar command() o pasar un documento JSON');
    }
    const doc = await this.command(JSON.parse(trimmed) as Record<string, unknown>);
    return [doc];
  }

  async command(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (cmd['clientList'] != null) {
      const raw = String(await this.client.sendCommand(['CLIENT', 'LIST']));
      return { raw };
    }
    const section = cmd['info'] != null ? String(cmd['info']) : cmd['section'] != null ? String(cmd['section']) : 'default';
    const text =
      section === 'all' || section === '1' || section === 'default'
        ? await this.client.info()
        : await this.client.info(section);
    return parseRedisInfo(text);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.destroy?.();
    }
  }
}

function parseRedisInfo(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // Keep dotted versions / statuses as strings (e.g. redis_version=7.2.5).
    if (/^\d+$/.test(value)) {
      out[key] = Number(value);
    } else if (/^\d+\.\d+$/.test(value)) {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

class OracleClient implements EngineClient {
  readonly kind = 'oracle' as const;

  constructor(
    private readonly pool: {
      getConnection: () => Promise<{
        execute: (
          sql: string,
          binds?: unknown,
          opts?: Record<string, unknown>,
        ) => Promise<{ rows?: unknown[]; metaData?: { name: string }[] }>;
        close: () => Promise<void>;
        callTimeout?: number;
      }>;
      close: (drain?: number) => Promise<void>;
    },
    private readonly statementTimeoutMs: number,
    private readonly outFormatObject: number,
  ) {}

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const conn = await this.pool.getConnection();
    try {
      conn.callTimeout = this.statementTimeoutMs;
      const result = await conn.execute(sql, [], {
        outFormat: this.outFormatObject,
      });
      const rows = (result.rows as Record<string, unknown>[] | undefined) ?? [];
      // Oracle returns uppercase column names; normalize for collectors.
      return rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
        return out;
      });
    } finally {
      await conn.close();
    }
  }

  async close(): Promise<void> {
    await this.pool.close(0);
  }
}
