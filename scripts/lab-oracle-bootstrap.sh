#!/usr/bin/env bash
# Bootstrap Oracle Free lab + grant monitor privileges + register target.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${BUHO_STORE_URL:-postgres://buho:buho@127.0.0.1:55432/buho}"
SYS_PASS="${ORACLE_PASSWORD:-Buho_Oracle_Lab1!}"
APP_USER="${APP_USER:-buho}"
APP_PASS="${APP_USER_PASSWORD:-Buho_Oracle_Lab1!}"

echo "==> Compose up oracle-lab (first boot can take 2–5 min)"
cd "$ROOT"
docker compose -f docker-compose.oracle-lab.yml up -d

echo "==> Wait healthy"
for i in $(seq 1 60); do
  if docker inspect -f '{{.State.Health.Status}}' buho-oracle-lab 2>/dev/null | grep -q healthy; then
    break
  fi
  echo "  … waiting ($i)"
  sleep 10
done

echo "==> Grant SELECT on V$/DBA views to $APP_USER (as SYSTEM)"
docker exec -i buho-oracle-lab sqlplus -s "system/${SYS_PASS}@localhost/FREEPDB1" <<SQL || true
SET FEEDBACK OFF
GRANT SELECT ANY DICTIONARY TO ${APP_USER};
GRANT SELECT_CATALOG_ROLE TO ${APP_USER};
EXIT
SQL

echo "==> Upsert monitor_targets (service FREEPDB1 in database field)"
psql "$STORE" -v ON_ERROR_STOP=1 <<SQL
insert into buho.monitor_targets
  (tenant, alias, engine, host, port, database, username, password, ssl, enabled, host_metrics)
values
  ('default', 'oracle-lab', 'oracle', 'oracle-lab', 1521, 'FREEPDB1', '${APP_USER}', '${APP_PASS}', false, true,
   '{"source":"docker","container":"buho-oracle-lab"}'::jsonb)
on conflict (tenant, alias) do update
  set host = excluded.host,
      port = excluded.port,
      database = excluded.database,
      username = excluded.username,
      password = excluded.password,
      host_metrics = excluded.host_metrics,
      enabled = true,
      updated_at = now();
SQL

echo "==> Done. Open Fleet → oracle-lab after collector reconnects."
echo "    Local: localhost:1522/FREEPDB1 user=${APP_USER}"
