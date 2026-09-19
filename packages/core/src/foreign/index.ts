/**
 * Paridad de motores.
 *
 * Todo lo que hace falta para que MariaDB y SQL Server tengan lo mismo que
 * PostgreSQL: métricas cada pocos segundos, analítica de consultas, captura de
 * bloqueos, chequeos y lectura del log.
 *
 * La decisión de fondo: **no** hay un adaptador universal que traduzca las
 * vistas de los tres motores a un molde común. Cada motor tiene sus colectores,
 * su SQL y sus límites, y lo único compartido es el formato de salida —`Sample`,
 * `StatementDelta`, `BlockedSession`—. Así las pantallas comunes funcionan para
 * los tres, y cuando un motor no puede medir algo se dice en vez de rellenarlo
 * con un cero que parece un dato.
 */
export { probeForeign, parseVersion } from './capabilities';
export { MARIADB_COLLECTORS } from './mariadb';
export { MSSQL_COLLECTORS, enrichMssqlDerivedSamples } from './mssql';
export { MONGODB_COLLECTORS } from './mongodb';
export {
  sampleMongoSessions,
  sampleMongoBlocking,
  sampleMongoCurrentOpMetrics,
  sampleMongoTop,
} from './mongodb-ops';
export { REDIS_COLLECTORS } from './redis';
export { sampleRedisSessions, sampleRedisBlocking, sampleRedisSlowlog, sampleRedisCommandstats } from './redis-ops';
export { ORACLE_COLLECTORS } from './oracle';
export { sampleOracleSessions, sampleOracleBlocking } from './oracle-ops';
export { CASSANDRA_COLLECTORS } from './cassandra';
export { sampleCassandraSessions, sampleCassandraBlocking } from './cassandra-ops';
export { ELASTICSEARCH_COLLECTORS } from './elasticsearch';
export {
  sampleElasticsearchSessions,
  sampleElasticsearchBlocking,
} from './elasticsearch-ops';
export { runForeignCollectors } from './types';
export type { ForeignCaps, ForeignCollector, ForeignRunResult } from './types';
export {
  ForeignStatementTracker,
  sampleForeignStatements,
  sampleMariadbSlowStatements,
  sampleOracleSlowStatements,
  digestToQueryid,
} from './statements';
export {
  MariadbSlowEventTracker,
  sampleMariadbSlowEvents,
  sampleMariadbIndexes,
  runMariadbExplain,
} from './mariadb-depth';
export type { StatementSlowEvent } from './mariadb-depth';
export {
  ForeignProcedureTracker,
  sampleForeignProcedures,
  sampleMssqlCatalog,
  sampleMariadbCatalog,
} from './procedures';
export type { ProcedureDelta, ProcedureSnapshotRow } from './procedures';
export { sampleForeignBlocking } from './blocking';
export { sampleForeignSessions, classifyMariaState, classifyMssqlWait } from './sessions';
export { readForeignLog, inspectForeignLogging } from './logs';

import type { EngineKind } from '../engine';
import { MARIADB_COLLECTORS } from './mariadb';
import { MSSQL_COLLECTORS } from './mssql';
import { MONGODB_COLLECTORS } from './mongodb';
import { REDIS_COLLECTORS } from './redis';
import { ORACLE_COLLECTORS } from './oracle';
import { CASSANDRA_COLLECTORS } from './cassandra';
import { ELASTICSEARCH_COLLECTORS } from './elasticsearch';
import type { ForeignCaps, ForeignCollector } from './types';

export function foreignCollectorsFor(caps: ForeignCaps, tier?: string): ForeignCollector[] {
  const catalogo: Record<Exclude<EngineKind, 'postgres'>, ForeignCollector[]> = {
    mariadb: MARIADB_COLLECTORS,
    mssql: MSSQL_COLLECTORS,
    mongodb: MONGODB_COLLECTORS,
    redis: REDIS_COLLECTORS,
    oracle: ORACLE_COLLECTORS,
    cassandra: CASSANDRA_COLLECTORS,
    elasticsearch: ELASTICSEARCH_COLLECTORS,
  };
  const lista = caps.engine === 'postgres' ? [] : catalogo[caps.engine];
  return lista.filter(
    (collector) => (!tier || collector.tier === tier) && (!collector.appliesTo || collector.appliesTo(caps)),
  );
}
