export interface SettingGuide {
  recommended: string;
  hint: string;
}

const POSTGRES: Record<string, SettingGuide> = {
  archive_mode: {
    recommended: 'on',
    hint: 'Required for WAL archiving and point-in-time recovery. Off is fine for dev-only clusters.',
  },
  archive_command: {
    recommended: 'Configured when archive_mode=on',
    hint: 'Must archive WAL to a durable destination (pgBackRest, Barman, etc.).',
  },
  archive_library: {
    recommended: 'Set when using archive modules',
    hint: 'PostgreSQL 15+ can archive via a shared library instead of shell.',
  },
  autovacuum: {
    recommended: 'on',
    hint: 'Disabling autovacuum causes bloat and transaction-id wraparound risk.',
  },
  checkpoint_completion_target: {
    recommended: '0.9',
    hint: 'Spreads checkpoint I/O; pairs with checkpoint_timeout.',
  },
  checkpoint_timeout: {
    recommended: '5–15 min',
    hint: 'Shorter = more frequent checkpoints, more WAL; longer = longer recovery.',
  },
  default_transaction_read_only: {
    recommended: 'off',
    hint: 'on makes every transaction read-only unless explicitly overridden.',
  },
  effective_cache_size: {
    recommended: '~50–75% of RAM',
    hint: 'Planner hint only — does not allocate memory.',
  },
  fsync: {
    recommended: 'on',
    hint: 'off risks corruption on crash. Never off in production.',
  },
  full_page_writes: {
    recommended: 'on',
    hint: 'Protects against partial page writes after crash.',
  },
  idle_in_transaction_session_timeout: {
    recommended: '5–15 min',
    hint: 'Kills idle transactions that hold locks and block vacuum.',
  },
  lock_timeout: {
    recommended: '0 or a few seconds',
    hint: 'Non-zero fails fast instead of waiting forever on locks.',
  },
  log_min_duration_statement: {
    recommended: '250 ms–1 s (or -1 off)',
    hint: 'Logs slow queries. Too low floods logs.',
  },
  maintenance_work_mem: {
    recommended: '256 MB–2 GB',
    hint: 'Memory for VACUUM, CREATE INDEX, ALTER TABLE ADD FOREIGN KEY.',
  },
  max_connections: {
    recommended: 'As low as the app needs',
    hint: 'Each connection can use work_mem per sort/hash node. Prefer a pooler.',
  },
  max_wal_size: {
    recommended: '1–4 GB (scale with write rate)',
    hint: 'Larger reduces checkpoint frequency but lengthens recovery.',
  },
  max_worker_processes: {
    recommended: '≥ max_parallel_workers + replicas',
    hint: 'Caps background workers including logical replication apply.',
  },
  password_encryption: {
    recommended: 'scram-sha-256',
    hint: 'md5 is legacy. SCRAM is the modern default.',
  },
  random_page_cost: {
    recommended: '1.1–4',
    hint: 'Lower on SSD/NVMe (1.1–1.5), higher on HDD.',
  },
  shared_buffers: {
    recommended: '~25% of RAM',
    hint: 'PostgreSQL buffer pool. Too low increases disk reads.',
  },
  shared_preload_libraries: {
    recommended: 'pg_stat_statements (monitoring)',
    hint: 'Libraries listed here load at server start — requires restart.',
  },
  ssl: {
    recommended: 'on (production)',
    hint: 'Encrypts client connections.',
  },
  statement_timeout: {
    recommended: 'Per environment (e.g. 15 min)',
    hint: 'Cancels runaway queries. 0 = disabled.',
  },
  synchronous_commit: {
    recommended: 'on',
    hint: 'off acknowledges commits before WAL is durable — faster but can lose data.',
  },
  track_io_timing: {
    recommended: 'on',
    hint: 'Required to attribute I/O wait in pg_stat_statements and EXPLAIN ANALYZE.',
  },
  wal_compression: {
    recommended: 'on (PG 15+)',
    hint: 'Reduces WAL volume with minimal CPU cost on modern Postgres.',
  },
  wal_level: {
    recommended: 'replica',
    hint: 'minimal disables streaming replication. logical enables CDC.',
  },
  work_mem: {
    recommended: '4–64 MB per operation',
    hint: 'Multiplies by active connections and parallel nodes — do not set globally too high.',
  },
};

const MARIADB: Record<string, SettingGuide> = {
  innodb_buffer_pool_size: {
    recommended: '~70–80% of RAM',
    hint: 'Main InnoDB cache. Dominates memory use.',
  },
  max_connections: {
    recommended: 'As low as the app needs',
    hint: 'Prefer a connection pool over hundreds of open sessions.',
  },
  slow_query_log: {
    recommended: 'ON',
    hint: 'Logs queries above long_query_time.',
  },
  log_bin: {
    recommended: 'ON (replication / PITR)',
    hint: 'Required for replication and point-in-time recovery.',
  },
};

const MSSQL: Record<string, SettingGuide> = {
  'max server memory (mb)': {
    recommended: 'Leave headroom for OS',
    hint: 'SQL Server will use all RAM unless capped — leave 4–8 GB for Windows/Linux.',
  },
  'backup compression default': {
    recommended: '1',
    hint: 'Compresses backups — less disk and network.',
  },
  'cost threshold for parallelism': {
    recommended: '50',
    hint: 'Minimum plan cost before parallel plans are considered.',
  },
};

const BY_ENGINE: Record<string, Record<string, SettingGuide>> = {
  postgres: POSTGRES,
  mariadb: MARIADB,
  mssql: MSSQL,
};

export function settingGuide(engine: string, name: string): SettingGuide | null {
  const table = BY_ENGINE[engine];
  if (!table) return null;
  return table[name] ?? table[name.toLowerCase()] ?? null;
}

/** Rough signal for the expanded row — not a full audit. */
export function settingStatus(
  current: string,
  guide: SettingGuide | null,
): 'ok' | 'review' | 'neutral' {
  if (!guide) return 'neutral';
  const c = current.trim().toLowerCase();
  const r = guide.recommended.toLowerCase();
  if (r.includes('~') || r.includes('–') || r.includes('per ') || r.includes('as low') || r.includes('leave')) {
    return 'neutral';
  }
  if (r.includes('(production)')) return c === 'on' ? 'ok' : 'review';
  if (r.startsWith('configured') || r.startsWith('set when')) return 'neutral';
  const token = r.split(/[\s,(]/)[0] ?? '';
  if (!token) return 'neutral';
  if (c === token) return 'ok';
  if (token === 'on' && c === 'off') return 'review';
  if (token === 'off' && c === 'on' && r.includes('off is fine')) return 'ok';
  return 'neutral';
}
