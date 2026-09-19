#!/usr/bin/env bash
# Bootstrap Redis lab target into buho.monitor_targets + seed light traffic.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${BUHO_STORE_URL:-postgres://buho:buho@127.0.0.1:55432/buho}"

echo "==> Compose up redis-lab"
cd "$ROOT"
docker compose -f docker-compose.redis-lab.yml up -d
echo "==> Wait healthy"
for i in $(seq 1 30); do
  if docker exec buho-redis-lab redis-cli -a 'Buho_Redis_Lab1!' ping 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 1
done

echo "==> Seed keys"
docker exec buho-redis-lab redis-cli -a 'Buho_Redis_Lab1!' --no-auth-warning <<'REDIS' || true
SET buho:ping 1
MSET buho:a 1 buho:b 2 buho:c 3
INCR buho:counter
HSET buho:user:1 name alice score 10
LPUSH buho:queue job1 job2 job3
REDIS

echo "==> Upsert monitor_targets"
psql "$STORE" -v ON_ERROR_STOP=1 <<'SQL'
insert into buho.monitor_targets
  (tenant, alias, engine, host, port, database, username, password, ssl, enabled, host_metrics)
values
  ('default', 'redis-lab', 'redis', 'redis-lab', 6379, '0', '', 'Buho_Redis_Lab1!', false, true,
   '{"source":"docker","container":"buho-redis-lab"}'::jsonb)
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

echo "==> Done. Open Fleet → redis-lab after collector picks up the target (~30s)."
echo "    Local: redis-cli -h 127.0.0.1 -p 6380 -a 'Buho_Redis_Lab1!'"
