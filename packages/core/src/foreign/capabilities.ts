import type { EngineClient } from '../engine';
import type { ForeignCaps } from './types';
import { num, str } from './types';

/**
 * Versión comparable a partir del texto que reporta el motor.
 *
 * MariaDB dice '11.4.12-MariaDB-ubu2404-log' y SQL Server '16.0.4265.3'. Se
 * toman los tres primeros números con el mismo peso que en PostgreSQL
 * (mayor * 10000 + menor * 100 + parche acotado) para poder escribir
 * `versionNum >= 100500` en un colector sin pensar en el formato.
 */
export function parseVersion(text: string): number {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return 0;
  const [, mayor, menor, parche] = match;
  return Number(mayor) * 10_000 + Number(menor) * 100 + Math.min(Number(parche ?? 0), 99);
}

async function probeMariadb(client: EngineClient): Promise<ForeignCaps> {
  const [info] = await client.query(`
    select @@version                as version,
           @@version_comment        as flavor,
           @@hostname               as server_name,
           @@performance_schema     as performance_schema,
           @@slow_query_log         as slow_query_log,
           @@log_bin                as log_bin,
           @@read_only              as read_only,
           (select variable_value from information_schema.global_status
             where variable_name = 'UPTIME')                    as uptime_seconds`);

  const versionText = str(info?.['version'], 'desconocida');
  const performanceSchema = num(info?.['performance_schema']) === 1;

  // El rol se decide por si hay una conexión de réplica configurada, no por
  // read_only: un primario puede estar en read_only durante un mantenimiento y
  // seguir siendo el primario.
  let role: ForeignCaps['role'] = 'unknown';
  let lockWaits = false;
  let seesAllSessions = false;

  try {
    const replica = await client.query('show replica status');
    role = replica.length > 0 ? 'replica' : 'primary';
  } catch {
    role = 'unknown';
  }

  try {
    // sys.innodb_lock_waits necesita el esquema sys y permiso de lectura sobre
    // information_schema.innodb_*; se prueba en vez de suponerlo.
    await client.query('select count(*) as n from information_schema.innodb_trx');
    lockWaits = true;
  } catch {
    lockWaits = false;
  }

  try {
    const sessions = await client.query('select count(*) as n from information_schema.processlist');
    // Sin PROCESS el usuario sólo se ve a sí mismo. Con una sola sesión no se
    // puede distinguir, pero el permiso sí: se pregunta directo.
    const grants = await client.query('show grants for current_user()');
    const texto = grants.map((row) => Object.values(row).join(' ')).join(' ').toUpperCase();
    seesAllSessions = texto.includes('PROCESS') || texto.includes('ALL PRIVILEGES') || num(sessions[0]?.['n']) > 1;
  } catch {
    seesAllSessions = false;
  }

  const limitations: string[] = [];
  if (!performanceSchema) {
    limitations.push(
      'performance_schema está apagado: no hay analítica de consultas ni digests. ' +
        'Se enciende con performance_schema=ON en my.cnf y requiere reiniciar el servidor.',
    );
  }
  if (!seesAllSessions) {
    limitations.push(
      'el usuario de monitoreo no tiene PROCESS: sólo ve sus propias sesiones, ' +
        'así que las conexiones y los bloqueos van a salir en cero.',
    );
  }
  if (!lockWaits) {
    limitations.push('no se puede leer information_schema.innodb_trx: no habrá detalle de bloqueos.');
  }
  if (num(info?.['log_bin']) !== 1) {
    limitations.push(
      'log_bin está apagado: no hay binlog, así que no hay métricas de replicación ' +
        'ni recuperación a un punto en el tiempo. Se enciende con log_bin=ON y requiere reiniciar.',
    );
  }

  const uptime = num(info?.['uptime_seconds']);

  return {
    engine: 'mariadb',
    versionText,
    versionNum: parseVersion(versionText),
    flavor: str(info?.['flavor'], 'MariaDB'),
    startedAt: uptime > 0 ? new Date(Date.now() - uptime * 1000) : null,
    serverName: str(info?.['server_name'], 'desconocido'),
    role,
    features: {
      statementDigests: performanceSchema,
      lockWaits,
      seesAllSessions,
      queryStore: false,
      alwaysOn: false,
      slowLog: num(info?.['slow_query_log']) === 1,
      binlog: num(info?.['log_bin']) === 1,
    },
    limitations,
  };
}

async function probeMssql(client: EngineClient): Promise<ForeignCaps> {
  const [info] = await client.query(`
    select cast(serverproperty('ProductVersion') as varchar(50)) as version,
           cast(serverproperty('Edition')        as varchar(60)) as flavor,
           cast(serverproperty('ServerName')     as varchar(128)) as server_name,
           (select sqlserver_start_time from sys.dm_os_sys_info)  as started_at,
           has_perms_by_name(null, null, 'VIEW SERVER STATE')     as view_server_state`);

  const versionText = str(info?.['version'], 'desconocida');
  const seesAllSessions = num(info?.['view_server_state']) === 1;

  let alwaysOn = false;
  try {
    const replicas = await client.query('select count(*) as n from sys.dm_hadr_database_replica_states');
    alwaysOn = num(replicas[0]?.['n']) > 0;
  } catch {
    alwaysOn = false;
  }

  let role: ForeignCaps['role'] = 'primary';
  if (alwaysOn) {
    try {
      const [estado] = await client.query(`
        select count(*) as secundarias
          from sys.dm_hadr_database_replica_states s
          join sys.dm_hadr_availability_replica_states r on r.replica_id = s.replica_id
         where s.is_local = 1 and r.role_desc <> 'PRIMARY'`);
      role = num(estado?.['secundarias']) > 0 ? 'replica' : 'primary';
    } catch {
      role = 'unknown';
    }
  } else {
    // Log shipping o mirroring dejan la base en RESTORING: eso también es una
    // réplica, aunque no haya Always On.
    try {
      const [restaurando] = await client.query(`
        select count(*) as n from sys.databases where state_desc = 'RESTORING' and database_id > 4`);
      if (num(restaurando?.['n']) > 0) role = 'replica';
    } catch {
      role = 'unknown';
    }
  }

  let queryStore = false;
  try {
    const [qs] = await client.query(
      `select count(*) as n from sys.databases where is_query_store_on = 1 and database_id > 4`,
    );
    queryStore = num(qs?.['n']) > 0;
  } catch {
    queryStore = false;
  }

  const limitations: string[] = [];
  if (!seesAllSessions) {
    limitations.push(
      'el login de monitoreo no tiene VIEW SERVER STATE: las DMV devuelven sólo ' +
        'la sesión propia, así que las esperas y las sesiones activas van a salir en cero.',
    );
  }
  if (!queryStore) {
    limitations.push(
      'ninguna base tiene Query Store activo: la analítica de consultas sale de ' +
        'sys.dm_exec_query_stats, que se vacía al reiniciar y al recompilar el plan.',
    );
  }

  const startedAt = info?.['started_at'];

  return {
    engine: 'mssql',
    versionText,
    versionNum: parseVersion(versionText),
    flavor: str(info?.['flavor'], 'SQL Server'),
    startedAt: startedAt instanceof Date ? startedAt : startedAt ? new Date(String(startedAt)) : null,
    serverName: str(info?.['server_name'], 'desconocido'),
    role,
    features: {
      statementDigests: true,
      lockWaits: seesAllSessions,
      seesAllSessions,
      queryStore,
      alwaysOn,
      slowLog: false,
      binlog: false,
    },
    limitations,
  };
}

/**
 * Qué se puede medir en este motor, ahora.
 *
 * Se vuelve a preguntar en cada reprobe porque casi todo es reversible en
 * caliente: alguien enciende Query Store, alguien le da PROCESS al usuario de
 * monitoreo, alguien agrega una réplica. El colector no debería necesitar un
 * reinicio para darse cuenta.
 */
export async function probeForeign(client: EngineClient): Promise<ForeignCaps> {
  if (client.kind === 'mariadb') return probeMariadb(client);
  if (client.kind === 'mssql') return probeMssql(client);
  if (client.kind === 'mongodb') return probeMongodb(client);
  throw new Error(`probeForeign no aplica a ${client.kind}`);
}

async function probeMongodb(client: EngineClient): Promise<ForeignCaps> {
  if (!client.command) throw new Error('cliente MongoDB sin command()');

  const build = await client.command({ buildInfo: 1 });
  const hello = await client.command({ hello: 1 });
  const status = await client.command({
    serverStatus: 1,
    repl: 0,
    metrics: 0,
    wiredTiger: 0,
  });

  const versionText = str(build['version'], 'desconocida');
  const uptime = num(status['uptime']);
  const setName = hello['setName'] ?? status['setName'];
  const isRepl = Boolean(setName);
  const isPrimary = hello['isWritablePrimary'] === true || hello['ismaster'] === true;

  const limitations: string[] = [
    'MongoDB v0.4: métricas de serverStatus/dbStats. Sin profiler de consultas ni topología de sharding todavía.',
  ];

  return {
    engine: 'mongodb',
    versionText,
    versionNum: parseVersion(versionText),
    flavor: str(build['modules'] ? 'MongoDB' : 'MongoDB', 'MongoDB'),
    startedAt: uptime > 0 ? new Date(Date.now() - uptime * 1000) : null,
    serverName: str(status['host'], 'desconocido'),
    role: isRepl ? (isPrimary ? 'primary' : 'replica') : 'primary',
    features: {
      statementDigests: false,
      lockWaits: false,
      seesAllSessions: true,
      queryStore: false,
      alwaysOn: isRepl,
      slowLog: false,
      binlog: false,
    },
    limitations,
  };
}
