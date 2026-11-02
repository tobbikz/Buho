#!/usr/bin/env bash
# Keeps light read/write traffic on the lab datalake so the Flow tab (especially
# Live) has something to animate. Stop with Ctrl+C.
set -euo pipefail

HOST="${BUHO_FLOW_HOST:-127.0.0.1}"
PORT="${BUHO_FLOW_PORT:-5435}"
USER="${BUHO_FLOW_USER:-buho_lab}"
export PGPASSWORD="${BUHO_FLOW_PASSWORD:-Buho_Lab_Pg1!}"
DB="${BUHO_FLOW_DB:-datalake}"

psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS flow_demo;
CREATE TABLE IF NOT EXISTS flow_demo.events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL

echo "Flow demo traffic on $HOST:$PORT/$DB (schema flow_demo) — Ctrl+C to stop"

n=0
while true; do
  n=$((n + 1))
  if (( n % 3 == 0 )); then
    psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -q -c \
      "INSERT INTO flow_demo.events (kind, payload) VALUES ('demo', jsonb_build_object('n', $n, 'batch', 'write'));"
  else
    psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -q -c \
      "SELECT count(*) FROM flow_demo.events WHERE created_at > now() - interval '1 hour';" >/dev/null
  fi
  sleep 2
done
