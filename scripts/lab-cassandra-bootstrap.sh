#!/usr/bin/env bash
# Bootstrap Cassandra lab target into buho.monitor_targets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${BUHO_STORE_URL:-postgres://buho:buho@127.0.0.1:55432/buho}"

echo "==> Compose up cassandra-lab (first boot ~60–120s)"
cd "$ROOT"
docker compose -f docker-compose.cassandra-lab.yml up -d
echo "==> Wait healthy"
for i in $(seq 1 60); do
  if docker exec buho-cassandra-lab cqlsh -e "SELECT release_version FROM system.local" 2>/dev/null | grep -qE '[0-9]+\.[0-9]+'; then
    break
  fi
  sleep 3
done

echo "==> Seed keyspace + table"
docker exec -i buho-cassandra-lab cqlsh <<'CQL' || true
CREATE KEYSPACE IF NOT EXISTS buho_lab
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
CREATE TABLE IF NOT EXISTS buho_lab.events (
  id uuid PRIMARY KEY,
  created_at timestamp,
  payload text
);
INSERT INTO buho_lab.events (id, created_at, payload)
  VALUES (uuid(), toTimestamp(now()), 'bootstrap');
CQL

echo "==> Upsert monitor_targets (collector reaches via Docker DNS cassandra-lab:9042)"
psql "$STORE" -v ON_ERROR_STOP=1 <<'SQL'
insert into buho.monitor_targets
  (tenant, alias, engine, host, port, database, username, password, ssl, enabled, host_metrics, tags)
values
  ('default', 'cassandra-lab', 'cassandra', 'cassandra-lab', 9042, 'buho_lab', 'cassandra', '',
   false, true,
   '{"source":"docker","container":"buho-cassandra-lab"}'::jsonb,
   '{"DC":"datacenter1"}'::jsonb)
on conflict (tenant, alias) do update
  set host = excluded.host,
      port = excluded.port,
      database = excluded.database,
      username = excluded.username,
      password = excluded.password,
      host_metrics = excluded.host_metrics,
      tags = excluded.tags,
      enabled = true,
      updated_at = now();
SQL

echo "==> Done. Open Fleet → cassandra-lab after collector picks up the target (~30s)."
echo "    Local: cqlsh 127.0.0.1 9042"
