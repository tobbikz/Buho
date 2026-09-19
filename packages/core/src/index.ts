export type {
  Capabilities,
  CollectorResult,
  InstanceConfig,
  MetricCollector,
  Sample,
  StatStatementsState,
  Tier,
} from './types';
export { APPLICATION_NAME, createPool, instanceKey } from './pool';
export type { PoolOptions } from './pool';
export { capabilityWarnings, probeCapabilities } from './capabilities';
export { DeltaEngine } from './deltas';
export type { RateResult } from './deltas';
export { QUERY_TAG, tagged } from './tag';
export { HostTracker, readHostSnapshot, parseSnapshot } from './host';
export type { HostConfig, HostSnapshot, HostSourceKind } from './host';
export { sampleBlocking } from './blocking';
export type { BlockedSession } from './blocking';
export { sampleStatements, StatementTracker } from './statements';
export type { StatementDelta } from './statements';
export { COLLECTORS, collectorsFor } from './collectors/index';
export { measureLatency, runCollectors } from './runner';
export type { CollectionResult, CollectorError } from './runner';
export { formatBytes, formatDuration, formatPct } from './format';
export { instanceFromEnv, instanceFromUrl, loadConfig } from './config';
export type { BuhoConfig, CollectorConfig, RetentionConfig } from './config';
export { openEngine, engineOf, ENGINE_LABEL, DEFAULT_PORT } from './engine';
export type { EngineKind, EngineClient, EngineOptions } from './engine';
export * as inventory from './inventory';
export { collectInventory } from './inventory';
export type { InventorySnapshot, InventoryNote, InventoryDomain, EngineInfo, SettingRow, DiskObject, ReplicationRow, BackupRow, JobRow, LicensingRow } from './inventory';
export { postgresClient } from './engine';
export { auditSecurity, securityScore, CATEGORY_LABEL, SEVERITY_ORDER } from './security';
export { discover, expandRange, isPrivateAddress, DEFAULT_PORTS } from './discovery';
export { runExplain, analyzePlan, isReadOnly, statementKind, rewriteNormalizedPlaceholders } from './explain';
export { sampleVacuum, vacuumSamples } from './vacuum';
export type { VacuumSnapshot, VacuumTable, VacuumProgress, TableForeignKey } from './vacuum';
export { sampleIndexes } from './indexes';
export type { IndexSnapshot, IndexObject, IndexStatus } from './indexes';
export { sampleActors, inspectActors, ActorAccumulator } from './actors';
export { sampleSessions, summarizeSessions } from './sessions';
export type { SessionSample, SessionSnapshot } from './sessions';
export type { ActorObservation, ActorSupport } from './actors';
export { statementObjects } from './sqlobjects';
export type { StatementObjects, StatementOperation, FlowWeight } from './sqlobjects';
export { suggestIndexes, mergeSuggestions, columnsFromPredicate } from './advisor';
export type { IndexSuggestion, IndexEvidence, SuggestionKind } from './advisor';
export { inspectPgstattuple, measureBloat } from './bloat';
export type { BloatMeasurement, BloatMode, PgstattupleState } from './bloat';
export { inspectLogging, readLog, parseEntries, parseLine, fingerprint } from './logs';
export type {
  LogConfig,
  LogEntry,
  LogKind,
  LogReadResult,
  LogSourceInfo,
  LogSourceKind,
} from './logs';
export type { PlanReport, PlanNode, PlanFinding, PlanSeverity, ExplainOptions, StatementKind } from './explain';
export type { Discovered, DiscoveryOptions, DiscoveryTarget } from './discovery';
export type {
  SecurityAudit,
  SecurityFinding,
  SecurityPrincipal,
  SecuritySeverity,
  SecurityCategory,
} from './security';

// Paridad de motores: MariaDB y SQL Server con métricas, consultas, bloqueos y log.
export {
  probeForeign,
  foreignCollectorsFor,
  runForeignCollectors,
  MARIADB_COLLECTORS,
  MSSQL_COLLECTORS,
  enrichMssqlDerivedSamples,
  ForeignStatementTracker,
  sampleForeignStatements,
  sampleMariadbSlowStatements,
  sampleOracleSlowStatements,
  MariadbSlowEventTracker,
  sampleMariadbSlowEvents,
  sampleMariadbIndexes,
  runMariadbExplain,
  ForeignProcedureTracker,
  sampleForeignProcedures,
  sampleMssqlCatalog,
  sampleMariadbCatalog,
  sampleForeignBlocking,
  sampleForeignSessions,
  sampleRedisSlowlog,
  sampleRedisCommandstats,
  readForeignLog,
  inspectForeignLogging,
  digestToQueryid,
} from './foreign';
export type { ForeignCaps, ForeignCollector, ForeignRunResult, ProcedureDelta, StatementSlowEvent } from './foreign';
