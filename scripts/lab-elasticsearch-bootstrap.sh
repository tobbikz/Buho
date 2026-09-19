#!/usr/bin/env bash
# Bootstrap Elasticsearch lab target into buho.monitor_targets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${BUHO_STORE_URL:-postgres://buho:buho@127.0.0.1:55432/buho}"

echo "==> Compose up elasticsearch-lab"
cd "$ROOT"
docker compose -f docker-compose.elasticsearch-lab.yml up -d
echo "==> Wait healthy"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9200/_cluster/health >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

echo "==> Seed index"
curl -fsS -X PUT 'http://127.0.0.1:9200/buho-lab' \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"number_of_shards":1,"number_of_replicas":0}}' || true
curl -fsS -X POST 'http://127.0.0.1:9200/buho-lab/_doc' \
  -H 'Content-Type: application/json' \
  -d '{"msg":"bootstrap","ts":"'"$(date -Iseconds)"'"}' || true

echo "==> Upsert monitor_targets (collector reaches via Docker DNS elasticsearch-lab:9200)"
psql "$STORE" -v ON_ERROR_STOP=1 <<'SQL'
insert into buho.monitor_targets
  (tenant, alias, engine, host, port, database, username, password, ssl, enabled, host_metrics)
values
  ('default', 'elasticsearch-lab', 'elasticsearch', 'elasticsearch-lab', 9200, '', 'elastic', '',
   false, true,
   '{"source":"docker","container":"buho-elasticsearch-lab"}'::jsonb)
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

echo "==> Done. Open Fleet → elasticsearch-lab after collector picks up the target (~30s)."
echo "    Local: curl http://127.0.0.1:9200/_cluster/health"
