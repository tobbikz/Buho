#!/usr/bin/env bash
# Bootstrap Mongo lab target into buho.monitor_targets + seed light traffic.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${BUHO_STORE_URL:-postgres://buho:buho@127.0.0.1:55432/buho}"
MONGO_URI="${BUHO_MONGO_URI:-mongodb://buho:Buho_Mongo_Lab1!@127.0.0.1:27018/tienda?authSource=admin}"

echo "==> Compose up mongo-lab"
cd "$ROOT"
docker compose -f docker-compose.mongo-lab.yml up -d
echo "==> Wait healthy"
for i in $(seq 1 30); do
  if docker exec buho-mongo-lab mongosh --quiet -u buho -p 'Buho_Mongo_Lab1!' --authenticationDatabase admin --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 2
done

echo "==> Seed collections"
docker exec buho-mongo-lab mongosh --quiet -u buho -p 'Buho_Mongo_Lab1!' --authenticationDatabase admin tienda --eval '
db.pedidos.createIndex({ cliente_id: 1 });
db.pedidos.createIndex({ created_at: -1 });
for (let i = 0; i < 200; i++) {
  db.pedidos.insertOne({ cliente_id: i % 20, total: Math.random() * 100, created_at: new Date() });
}
db.productos.insertMany([{ sku: "A", stock: 10 }, { sku: "B", stock: 5 }]);
print("seeded", db.pedidos.countDocuments());
' || true

echo "==> Upsert monitor_targets (collector reaches via Docker DNS mongo-lab:27017)"
psql "$STORE" -v ON_ERROR_STOP=1 <<'SQL'
insert into buho.monitor_targets
  (tenant, alias, engine, host, port, database, username, password, ssl, enabled, host_metrics)
values
  ('default', 'mongo-lab', 'mongodb', 'mongo-lab', 27017, 'tienda', 'buho', 'Buho_Mongo_Lab1!', false, true,
   '{"source":"docker","container":"buho-mongo-lab"}'::jsonb)
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

echo "==> Done. Open Fleet → mongo-lab after collector picks up the target (~30s)."
echo "    Local mongosh: $MONGO_URI"
