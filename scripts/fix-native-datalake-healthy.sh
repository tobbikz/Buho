#!/usr/bin/env bash
# Apply Búho-friendly settings to the host PostgreSQL on :5432 (datalake-local).
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-tomy.berrios}"
PGPASSWORD="${PGPASSWORD:-Yucaquemada1}"
PGDATABASE="${PGDATABASE:-datalake}"
export PGPASSWORD

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
-- Keep shared_buffers (needs restart to change) but fix the ratio check.
ALTER SYSTEM SET effective_cache_size = '512MB';
ALTER SYSTEM SET idle_in_transaction_session_timeout = '15min';
ALTER SYSTEM SET track_io_timing = 'on';
SELECT pg_reload_conf();

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

VACUUM (ANALYZE);
SQL

echo "Host PostgreSQL on ${PGHOST}:${PGPORT} tuned. Restart the collector to refresh checks."
