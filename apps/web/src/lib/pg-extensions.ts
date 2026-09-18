/**
 * Short DBA-oriented blurbs for common PostgreSQL extensions.
 * Unknown names fall back to a generic note — we never invent capabilities.
 */
export interface ExtensionInfo {
  summary: string;
  /** What a DBA usually watches or cares about. */
  whyItMatters?: string;
  /** Soft risk / ops note when relevant. */
  caution?: string;
}

const CATALOG: Record<string, ExtensionInfo> = {
  plpgsql: {
    summary: 'Built-in procedural language for stored functions and triggers in PL/pgSQL.',
    whyItMatters: 'Almost every database has it. Required for most triggers and business logic inside Postgres.',
  },
  pg_stat_statements: {
    summary: 'Tracks execution statistics for normalized SQL (calls, total time, rows, I/O).',
    whyItMatters: 'This is what Búho uses for the Queries, Flow, and Topology tabs. Keep it installed and in shared_preload_libraries.',
  },
  pg_stat_kcache: {
    summary: 'Adds OS-level CPU and disk I/O counters on top of pg_stat_statements.',
    whyItMatters: 'Helps separate CPU-bound queries from I/O-bound ones.',
  },
  pg_buffercache: {
    summary: 'Inspects which relations currently occupy shared_buffers.',
    whyItMatters: 'Useful when diagnosing cache pressure or cold working sets.',
  },
  pgstattuple: {
    summary: 'Reports live/dead tuple ratios and free space inside tables and indexes.',
    whyItMatters: 'Búho can use it for deeper bloat measurement when installed.',
  },
  pg_trgm: {
    summary: 'Trigram indexes and similarity operators for fuzzy / LIKE / ILIKE search.',
    whyItMatters: 'Common for search boxes; GIN/GiST indexes on text columns.',
  },
  uuid_ossp: {
    summary: 'Generates UUIDs (v1/v3/v4/v5) via uuid-ossp functions.',
    whyItMatters: 'Older apps often depend on uuid_generate_v4(); newer ones prefer gen_random_uuid() from pgcrypto/core.',
  },
  pgcrypto: {
    summary: 'Cryptographic functions: hashing, encryption, and gen_random_uuid().',
    whyItMatters: 'Used for password hashes and application-level encryption inside SQL.',
  },
  hstore: {
    summary: 'Key/value store type inside a single column.',
    whyItMatters: 'Legacy flexible attributes; many teams migrate to jsonb instead.',
  },
  'btree_gin': {
    summary: 'Allows GIN indexes on scalar types that normally use btree (ints, timestamps, etc.).',
    whyItMatters: 'Lets you combine btree-like columns with GIN in a multi-column index.',
  },
  'btree_gist': {
    summary: 'GiST operator classes for scalar types; enables exclusion constraints on them.',
    whyItMatters: 'Typical for “no overlapping ranges” booking / calendar constraints.',
  },
  citext: {
    summary: 'Case-insensitive text type.',
    whyItMatters: 'Handy for emails and usernames without lower() everywhere.',
  },
  unaccent: {
    summary: 'Text search dictionary that strips accents (é → e).',
    whyItMatters: 'Used in full-text search configurations for multilingual apps.',
  },
  fuzzystrmatch: {
    summary: 'Soundex, metaphone, and Levenshtein distance functions.',
    whyItMatters: 'Fuzzy matching beyond trigrams.',
  },
  postgres_fdw: {
    summary: 'Foreign Data Wrapper to query remote PostgreSQL servers as local tables.',
    whyItMatters: 'Cross-database joins and federation without ETL.',
    caution: 'Remote queries run with the server’s identity to the remote host — review grants and user mapping.',
  },
  dblink: {
    summary: 'Older way to run SQL on a remote Postgres from inside a session.',
    whyItMatters: 'Mostly superseded by postgres_fdw for table-like access.',
    caution: 'Often flagged in security audits; prefer FDW with tight user mappings.',
  },
  file_fdw: {
    summary: 'Reads server-side files (CSV, etc.) as foreign tables.',
    caution: 'Needs filesystem access on the database host.',
  },
  tablefunc: {
    summary: 'Crosstab / pivot helpers and other table functions.',
  },
  intarray: {
    summary: 'Indexes and operators optimized for arrays of integers.',
  },
  ltree: {
    summary: 'Hierarchical tree-like labels (path materialization) with GiST/GIN support.',
    whyItMatters: 'Org charts, categories, nested menus.',
  },
  isn: {
    summary: 'Data types for ISBN, ISSN, EAN, UPC product codes.',
  },
  cube: {
    summary: 'Multidimensional cube type for geometric / scientific data.',
  },
  earthdistance: {
    summary: 'Point-on-sphere distance calculations (often paired with cube).',
    whyItMatters: 'Simple geo distance without PostGIS.',
  },
  postgis: {
    summary: 'Spatial types, indexes, and GIS functions (geometry/geography).',
    whyItMatters: 'The standard for maps, geofencing, and spatial joins.',
  },
  'postgis_topology': {
    summary: 'Topology model on top of PostGIS (nodes, edges, faces).',
  },
  'postgis_raster': {
    summary: 'Raster (grid) storage and analysis in PostGIS.',
  },
  timescaledb: {
    summary: 'Hypertables and time-series tooling on top of PostgreSQL.',
    whyItMatters: 'Auto-partitioning by time, compression, continuous aggregates.',
  },
  vector: {
    summary: 'pgvector — store and search embedding vectors (ANN indexes).',
    whyItMatters: 'RAG / semantic search workloads.',
  },
  pg_partman: {
    summary: 'Automated creation and maintenance of time/serial partitions.',
    whyItMatters: 'Keeps partition sets growing without manual DDL every month.',
  },
  pg_cron: {
    summary: 'Cron-style job scheduler inside the database.',
    whyItMatters: 'Periodic VACUUM, refresh, or cleanup SQL without an external scheduler.',
    caution: 'Jobs run as a database role — audit who can schedule and what they run.',
  },
  pgagent: {
    summary: 'Job agent historically used with pgAdmin for scheduled tasks.',
  },
  auto_explain: {
    summary: 'Logs EXPLAIN plans for queries that exceed a duration threshold.',
    whyItMatters: 'Great for catching regressions without manual EXPLAIN.',
    caution: 'Loaded via shared_preload_libraries; can be noisy if thresholds are too low.',
  },
  pg_repack: {
    summary: 'Online rewrite of tables/indexes to remove bloat with less locking than VACUUM FULL.',
    whyItMatters: 'Maintenance tool — usually installed as an extension and run as a client utility.',
  },
  hypopg: {
    summary: 'Creates hypothetical indexes the planner can see without building them for real.',
    whyItMatters: 'What-if analysis before paying for an index build.',
  },
  pgaudit: {
    summary: 'Session and object audit logging for compliance.',
    whyItMatters: 'Who read/wrote what — beyond the standard log_statement settings.',
  },
  pglogical: {
    summary: 'Logical replication extension (predecessor / alternative tooling to built-in logical rep).',
  },
  'wal2json': {
    summary: 'Logical decoding plugin that emits WAL changes as JSON.',
    whyItMatters: 'CDC pipelines (Debezium and similar).',
  },
  amcheck: {
    summary: 'Verifies logical consistency of btree (and some other) indexes.',
    whyItMatters: 'Corruption checks after crashes or storage incidents.',
  },
  pageinspect: {
    summary: 'Low-level inspection of heap and index pages.',
    caution: 'Expert tooling — easy to misread; not for day-to-day monitoring.',
  },
  pg_freespacemap: {
    summary: 'Shows the free space map for relations.',
  },
  pg_visibility: {
    summary: 'Inspects visibility map bits (all-visible / all-frozen).',
  },
  sslinfo: {
    summary: 'Functions that report SSL certificate details for the current connection.',
  },
  'xml2': {
    summary: 'XPath and XSLT helpers for XML data.',
  },
  'plpython3u': {
    summary: 'Untrusted Python 3 procedural language.',
    caution: 'Can run arbitrary code as the postgres OS user — high security surface.',
  },
  plperlu: {
    summary: 'Untrusted Perl procedural language.',
    caution: 'Can run arbitrary code as the postgres OS user — high security surface.',
  },
  plperl: {
    summary: 'Trusted Perl procedural language (restricted operations).',
  },
  pltcl: {
    summary: 'Trusted Tcl procedural language.',
  },
  adminpack: {
    summary: 'Server-side helpers historically used by pgAdmin (file read/write on the host).',
    caution: 'Filesystem access from SQL — drop if unused.',
  },
  'orafce': {
    summary: 'Oracle compatibility functions and packages for migration ease.',
  },
  'pg_hint_plan': {
    summary: 'Lets you inject planner hints via SQL comments.',
    whyItMatters: 'Last-resort plan control when statistics are wrong and you cannot wait for a fix.',
  },
  'tds_fdw': {
    summary: 'Foreign Data Wrapper for Microsoft SQL Server / Sybase (TDS).',
  },
  'mysql_fdw': {
    summary: 'Foreign Data Wrapper for MySQL / MariaDB.',
  },
  'mongo_fdw': {
    summary: 'Foreign Data Wrapper for MongoDB.',
  },
  'clickhouse_fdw': {
    summary: 'Foreign Data Wrapper for ClickHouse.',
  },
  'age': {
    summary: 'Apache AGE — graph database query (openCypher) on PostgreSQL.',
  },
  rum: {
    summary: 'RUM access method — enhanced full-text / positional indexes.',
  },
  'pg_squeeze': {
    summary: 'Background reorganization of bloated tables with less downtime.',
  },
  'pg_profile': {
    summary: 'Historical workload reports built on top of statistics views.',
  },
  'pg_qualstats': {
    summary: 'Tracks WHERE/JOIN predicates to suggest missing indexes.',
  },
  'pg_track_settings': {
    summary: 'History of GUC / configuration changes over time.',
  },
};

export function describeExtension(name: string): ExtensionInfo {
  const key = name.toLowerCase();
  const known = CATALOG[key];
  if (known) return known;
  return {
    summary: `No built-in blurb for “${name}” yet. Check the extension’s docs or \\dx+ ${name} in psql.`,
    whyItMatters: 'Installed extensions change available functions, types, and sometimes security surface — treat unknown ones as worth a quick review.',
  };
}
