export type {
  Capabilities,
  CollectorResult,
  InstanceConfig,
  MetricCollector,
  Sample,
  StatStatementsState,
  Tier,
  KafkaInstanceConfig,
  AirflowInstanceConfig,
  CdcInstanceConfig,
  ActionsInstanceConfig,
  BackupInstanceConfig,
  DatahubInstanceConfig,
} from './types';
export { KAFKA_COLLECTORS, CDC_COLLECTORS } from './kafka/collectors';
export { AIRFLOW_COLLECTORS } from './airflow/collectors';
export {
  runAction,
  killPostgresSession,
  cancelPostgresQuery,
  pauseAirflowDag,
} from './actions';
export type { ActionKind, ActionRequest, ActionResult } from './actions';
export { emitInstanceToDatahub, datahubBrowseUrl } from './datahub/emitter';
export type { DatahubEmitResult } from './datahub/emitter';
export {
  evaluateRpo,
  runRestoreDrill,
  runRestoreDrillStub,
} from './backup/monitor';
export type {
  BackupEvidenceRow,
  RpoEvaluation,
  RestoreDrillSpec,
  RestoreDrillResult,
} from './backup/monitor';
export { runPhysicalRestoreDrill } from './backup/physical-drill';
export type { PhysicalDrillSpec, PhysicalDrillResult } from './backup/physical-drill';
export { runFailoverDrill } from './ha/failover-drill';
export type { FailoverDrillResult } from './ha/failover-drill';
export { waitClassOf, correlateWaitsWithSql } from './waits/taxonomy';
export { fingerprintPlan, fingerprintPlanText } from './waits/fingerprint';
export { detectPlanRegression } from './waits/plan-regression';
export type { PlanRegression } from './waits/plan-regression';
export type { WaitClass, WaitShareRow, SqlBlameRow } from './waits/taxonomy';
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
export { buildBlockingTree, summarizeLockHolders, toBlockingTreeInput } from './locks/blocking-tree';
export type {
  BlockingTreeInput,
  BlockingTreeNode,
  BlockingTreeResult,
  LockHolderSummary,
} from './locks/blocking-tree';
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
export {
  probeEndpoint,
  probeHttp,
  probeTcp,
  probeTlsCert,
  probeIcmp,
  probeJourney,
} from './endpoints/probe';
export type { EndpointProbeConfig, EndpointProbeResult, ProbeKind } from './endpoints/probe';
export { analyzeBaseUrl } from './endpoints/analyze';
export type {
  AnalyzeBaseUrlOptions,
  AnalyzeBaseUrlResult,
  AnalyzePathResult,
} from './endpoints/analyze';
export {
  BUHO_CONSOLE_PATHS,
  DEFAULT_ANALYZE_STATUSES,
  joinBaseUrl,
} from './endpoints/catalog';
export { parseOtlpTracesJson, spanDurationMs } from './otel/parse';
export type { ParsedSpan, ParsedTraceBatch } from './otel/parse';
export { parseOtlpLogsJson } from './otel/parse-logs';
export type { ParsedLogRecord, ParsedLogBatch } from './otel/parse-logs';
export * as inventory from './inventory';
export { collectInventory } from './inventory';
export type { InventorySnapshot, InventoryNote, InventoryDomain, EngineInfo, SettingRow, DiskObject, ReplicationRow, BackupRow, JobRow, LicensingRow } from './inventory';
export { postgresClient } from './engine';
export { auditSecurity, securityScore, CATEGORY_LABEL, SEVERITY_ORDER } from './security';
export { captureDdlEvent, captureDdlEvents } from './ddl/capture';
export type { NormalizedDdlEvent, RawDdlEvent } from './ddl/capture';
export { discover, expandRange, isPrivateAddress, DEFAULT_PORTS } from './discovery';
export { runExplain, analyzePlan, isReadOnly, statementKind, rewriteNormalizedPlaceholders } from './explain';
export { sampleVacuum, vacuumSamples } from './vacuum';
export type { VacuumSnapshot, VacuumTable, VacuumProgress, TableForeignKey } from './vacuum';
export { sampleIndexes } from './indexes';
export { sampleCatalog } from './catalog';
export type { CatalogSnapshot, CatalogTable, CatalogColumn } from './catalog';
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
export { inspectLogging, readLog, readSqlLog, readStatErrorDeltas, parseEntries, parseLine, fingerprint } from './logs';
export type { StatErrorTotals } from './logs';
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
  sampleOracleIndexes,
  sampleMssqlIndexes,
  sampleMssqlMaintenance,
  sampleMssqlMissingIndexes,
  runMariadbExplain,
  runMssqlExplain,
  runOracleExplain,
  ForeignProcedureTracker,
  sampleForeignProcedures,
  sampleMssqlCatalog,
  sampleMariadbCatalog,
  sampleOracleCatalog,
  sampleForeignBlocking,
  sampleForeignSessions,
  sampleRedisSlowlog,
  sampleRedisCommandstats,
  readForeignLog,
  inspectForeignLogging,
  digestToQueryid,
} from './foreign';
export type {
  ForeignCaps,
  ForeignCollector,
  ForeignRunResult,
  ProcedureDelta,
  StatementSlowEvent,
  MssqlMaintenanceSnapshot,
  MssqlHeapPressureRow,
  MssqlIndexFragmentationRow,
} from './foreign';
