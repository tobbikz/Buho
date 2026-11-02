#!/usr/bin/env bash
# Seed lab data so Búho Indexes / Queries screens have something to show on standby-prueba.
# Primary :5435  Standby :5434  Store :55432
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQL="$ROOT/docker/lab/seed-index-demo.sql"

echo "Loading demo schema on primary..."
docker cp "$SQL" buho-datalake-primary:/tmp/seed-index-demo.sql
docker exec buho-datalake-primary psql -U buho_lab -d datalake -f /tmp/seed-index-demo.sql

echo "Waiting for replication..."
sleep 3
docker exec buho-datalake-standby psql -U buho_lab -d datalake -qtAX \
  -c "SELECT count(*) FROM buho_demo.orders;" | xargs -I{} echo "  standby rows: {}"

echo "Running sample queries on standby (pg_stat_statements)..."
for _ in $(seq 1 3); do
  docker exec buho-datalake-standby psql -U buho_lab -d datalake -q -c \
    "SELECT count(*) FROM buho_demo.orders WHERE amount > 999.50;" >/dev/null
  docker exec buho-datalake-standby psql -U buho_lab -d datalake -q -c \
    "SELECT id, amount FROM buho_demo.orders WHERE status = 'cancelled' AND region = 'north' ORDER BY amount DESC LIMIT 20;" >/dev/null
done

echo "Enqueueing EXPLAIN ANALYZE jobs for instance 81 (standby-prueba)..."
docker exec buho-store-1 psql -U buho -d buho -c "
INSERT INTO buho.plan_requests (instance_id, queryid, sql, mode, requested_by, state)
SELECT 81, NULL, sql, 'analyze', 'lab-seed', 'pendiente'
  FROM (VALUES
    ('SELECT count(*) FROM buho_demo.orders WHERE amount > 999.50'),
    ('SELECT id, amount FROM buho_demo.orders WHERE status = ''cancelled'' AND region = ''north'' ORDER BY amount DESC LIMIT 20')
  ) AS v(sql)
 WHERE NOT EXISTS (
   SELECT 1 FROM buho.plan_requests p
    WHERE p.instance_id = 81 AND p.sql = v.sql AND p.mode = 'analyze'
      AND p.state IN ('pendiente','corriendo','listo') AND p.finished_at > now() - interval '1 hour'
 );"

echo "Waiting for collector (up to 60s)..."
for _ in $(seq 1 30); do
  pending=$(docker exec buho-store-1 psql -U buho -d buho -qtAX -c \
    "SELECT count(*) FROM buho.plan_requests WHERE instance_id=81 AND state IN ('pendiente','corriendo');")
  [ "$pending" = "0" ] && break
  sleep 2
done

docker exec buho-store-1 psql -U buho -d buho -c \
  "SELECT request_id, mode, state, left(sql,55) AS sql FROM buho.plan_requests WHERE instance_id=81 ORDER BY request_id DESC LIMIT 5;"

echo ""
echo "Open http://localhost:3100/instances/81/indexes (refresh after ~1 min for checks)."
