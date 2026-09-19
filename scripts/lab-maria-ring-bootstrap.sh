#!/usr/bin/env bash
# Bootstrap 4-node MariaDB ring for Búho + register only those targets.
#
# Ring: 1→2→3→4→1 (each is replica of previous; all writable with log-slave-updates).
# PS ON: maria-1/2 · PS OFF: maria-3/4
#
#   bash scripts/lab-maria-ring-bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ROOT_PW="${MARIA_ROOT_PASSWORD:-Buho_Maria_Root1!}"
REPL_PW="${MARIA_REPL_PASSWORD:-Buho_Maria_Repl1!}"
MON_USER="${MARIA_MONITOR_USER:-buho_monitor}"
MON_PW="${MARIA_MONITOR_PASSWORD:-Buho_Monitor_Lab1!}"
DB="${MARIA_DB:-tienda}"

sql() {
  local container="$1"; shift
  docker exec -i "$container" mariadb -uroot -p"$ROOT_PW" -N -e "$*" 2>/dev/null
}

echo "==> Starting Maria ring"
docker compose -f docker-compose.maria-ring.yml up -d

# Same compose project network as store/collector when run from this repo root.
for c in buho-maria-1 buho-maria-2 buho-maria-3 buho-maria-4; do
  docker network connect buho_default "$c" 2>/dev/null || true
done

echo "==> Waiting for healthy nodes"
for c in buho-maria-1 buho-maria-2 buho-maria-3 buho-maria-4; do
  for i in $(seq 1 60); do
    if docker exec "$c" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
      echo "  $c ready"
      break
    fi
    if [[ $i -eq 60 ]]; then
      echo "timeout waiting for $c" >&2
      exit 1
    fi
    sleep 2
  done
done

echo "==> Users + schema on each node"
for c in buho-maria-1 buho-maria-2 buho-maria-3 buho-maria-4; do
  sql "$c" "
CREATE DATABASE IF NOT EXISTS ${DB};
CREATE USER IF NOT EXISTS 'repl'@'%' IDENTIFIED BY '${REPL_PW}';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';
CREATE USER IF NOT EXISTS '${MON_USER}'@'%' IDENTIFIED BY '${MON_PW}';
GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR, REPLICATION MASTER ADMIN ON *.* TO '${MON_USER}'@'%';
GRANT SELECT ON mysql.user TO '${MON_USER}'@'%';
GRANT SELECT ON mysql.db TO '${MON_USER}'@'%';
GRANT SELECT ON mysql.global_priv TO '${MON_USER}'@'%';
GRANT SELECT ON performance_schema.* TO '${MON_USER}'@'%';
GRANT SELECT ON mysql.slow_log TO '${MON_USER}'@'%';
GRANT SELECT ON ${DB}.* TO '${MON_USER}'@'%';
GRANT SELECT ON *.* TO '${MON_USER}'@'%';
ALTER USER '${MON_USER}'@'%' WITH MAX_USER_CONNECTIONS 8;
FLUSH PRIVILEGES;

USE ${DB};
CREATE TABLE IF NOT EXISTS pedidos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cliente VARCHAR(64) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  region VARCHAR(32) NOT NULL DEFAULT 'centro',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_status_region (status, region)
) ENGINE=InnoDB;
"
done

# On PS-ON nodes, enable wait/stage/statement consumers (no-op when P_S is OFF).
echo "==> Enable performance_schema consumers on maria-1/2"
for c in buho-maria-1 buho-maria-2; do
  sql "$c" "
UPDATE performance_schema.setup_consumers SET ENABLED='YES'
  WHERE NAME LIKE 'events_waits%' OR NAME LIKE 'events_stages%' OR NAME LIKE 'events_statements%';
UPDATE performance_schema.setup_instruments SET ENABLED='YES', TIMED='YES'
  WHERE NAME LIKE 'wait/%' OR NAME LIKE 'stage/%' OR NAME LIKE 'statement/%';
" || true
done

# Slow query log on all nodes (TABLE) so SLOW_QUERIES counter + digests move under load.
echo "==> Enable slow_query_log (TABLE, long_query_time=1)"
for c in buho-maria-1 buho-maria-2 buho-maria-3 buho-maria-4; do
  sql "$c" "
SET GLOBAL slow_query_log = ON;
SET GLOBAL log_output = 'TABLE';
SET GLOBAL long_query_time = 1;
" || true
done

echo "==> Reset binlog/GTID then wire ring (1←4←3←2←1)"
for c in buho-maria-1 buho-maria-2 buho-maria-3 buho-maria-4; do
  sql "$c" "STOP SLAVE; RESET SLAVE ALL; SET GLOBAL gtid_slave_pos=''; RESET MASTER; SET GLOBAL slave_exec_mode='IDEMPOTENT';" || true
  sql "$c" "SET sql_log_bin=0; TRUNCATE TABLE ${DB}.pedidos; SET sql_log_bin=1;" || true
done

# Each node replicates FROM the previous in the ring
# maria-1 ← maria-4, maria-2 ← maria-1, maria-3 ← maria-2, maria-4 ← maria-3
wire() {
  local slave="$1" master_host="$2"
  sql "$slave" "
CHANGE MASTER TO
  MASTER_HOST='${master_host}',
  MASTER_USER='repl',
  MASTER_PASSWORD='${REPL_PW}',
  MASTER_PORT=3306,
  MASTER_CONNECT_RETRY=5,
  MASTER_USE_GTID=slave_pos;
START SLAVE;
"
}

# Containers share the default compose network — use service DNS names
wire buho-maria-2 maria-1
wire buho-maria-3 maria-2
wire buho-maria-4 maria-3
wire buho-maria-1 maria-4

sleep 2

# Seed AFTER wire so INSERTs replicate around the ring
echo "==> Seed pedidos on maria-1 (replicates around ring)"
COUNT=$(sql buho-maria-1 "SELECT COUNT(*) FROM ${DB}.pedidos;" | tr -d '[:space:]' || echo 0)
if [[ "${COUNT:-0}" -lt 80 ]]; then
  sql buho-maria-1 "
USE ${DB};
SET @i := 0;
INSERT INTO pedidos (cliente, total, status, region)
SELECT CONCAT('c-', (@i := @i + 1) % 50),
       10 + (@i % 90),
       'open',
       ELT(1 + (@i % 4), 'norte', 'sur', 'centro', 'bajio')
  FROM information_schema.columns c1
  CROSS JOIN information_schema.columns c2
 LIMIT 120;
"
  sleep 3
fi

sleep 2
echo "==> Replica status (IO/SQL)"
for c in buho-maria-1 buho-maria-2 buho-maria-3 buho-maria-4; do
  echo "--- $c"
  docker exec "$c" mariadb -uroot -p"$ROOT_PW" -e "SHOW ALL SLAVES STATUS\G" 2>/dev/null \
    | rg -i 'Master_Host|Slave_IO_Running|Slave_SQL_Running|Seconds_Behind|Last_SQL_Error|Last_Error' || true
  echo -n "    pedidos="
  sql "$c" "SELECT COUNT(*) FROM ${DB}.pedidos;" || true
done

echo "==> Tear down PG + MSSQL lab containers (keep buho store/web/collector)"
docker compose -f docker-compose.lab.yml stop datalake-primary datalake-standby 2>/dev/null || true
docker compose -f docker-compose.lab.yml rm -f datalake-primary datalake-standby 2>/dev/null || true
docker rm -f buho-datalake-primary buho-datalake-standby 2>/dev/null || true
docker rm -f datasync-mssql-test buho-mssql-ha 2>/dev/null || true

echo "==> Replace Búho monitor targets with 4 Maria only"
docker compose exec -T store psql -U buho -d buho <<'SQL'
BEGIN;
DELETE FROM buho.monitor_targets WHERE engine IN ('postgres', 'mssql') OR alias LIKE 'maria-%' OR alias LIKE 'mariadb-%';
DELETE FROM buho.instances WHERE engine IN ('postgres', 'mssql');
COMMIT;
SQL

# Register via SQL (collector reads monitor_targets)
docker compose exec -T store psql -U buho -d buho <<SQL
INSERT INTO buho.monitor_targets
  (tenant, alias, engine, host, port, database, username, password, environment, ssl, tags, host_metrics, enabled)
VALUES
  ('default', 'maria-1', 'mariadb', 'maria-1', 3306, '${DB}', '${MON_USER}', '${MON_PW}', 'lab', false, '{"ring":"1","ps":"on"}'::jsonb,
   '{"source":"docker","container":"buho-maria-1","dataDirectory":"/var/lib/mysql"}'::jsonb, true),
  ('default', 'maria-2', 'mariadb', 'maria-2', 3306, '${DB}', '${MON_USER}', '${MON_PW}', 'lab', false, '{"ring":"2","ps":"on"}'::jsonb,
   '{"source":"docker","container":"buho-maria-2","dataDirectory":"/var/lib/mysql"}'::jsonb, true),
  ('default', 'maria-3', 'mariadb', 'maria-3', 3306, '${DB}', '${MON_USER}', '${MON_PW}', 'lab', false, '{"ring":"3","ps":"off"}'::jsonb,
   '{"source":"docker","container":"buho-maria-3","dataDirectory":"/var/lib/mysql"}'::jsonb, true),
  ('default', 'maria-4', 'mariadb', 'maria-4', 3306, '${DB}', '${MON_USER}', '${MON_PW}', 'lab', false, '{"ring":"4","ps":"off"}'::jsonb,
   '{"source":"docker","container":"buho-maria-4","dataDirectory":"/var/lib/mysql"}'::jsonb, true)
ON CONFLICT (tenant, alias) DO UPDATE SET
  host = EXCLUDED.host,
  port = EXCLUDED.port,
  database = EXCLUDED.database,
  username = EXCLUDED.username,
  password = EXCLUDED.password,
  tags = EXCLUDED.tags,
  host_metrics = EXCLUDED.host_metrics,
  enabled = true,
  updated_at = now();
SQL

# Disable leftover non-maria targets explicitly
docker compose exec -T store psql -U buho -d buho -c \
  "UPDATE buho.monitor_targets SET enabled = false WHERE engine <> 'mariadb';
   DELETE FROM buho.monitor_targets WHERE engine <> 'mariadb';"

echo "==> Restart collector to pick up targets"
docker compose up -d --force-recreate collector

echo "==> Done. Targets: maria-1..4 via Docker DNS :3306 (host ports 3307–3310)."
echo "    PS ON: maria-1/2 · PS OFF: maria-3/4 (PROCESSLIST Queries fallback)."
echo "    Cluster HA should show ring peers after inventory/replication cycles."
