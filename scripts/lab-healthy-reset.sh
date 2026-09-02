#!/usr/bin/env bash
# Reset the lab PostgreSQL pair with healthy Búho-friendly settings.
# Primary: 127.0.0.1:5435 (datalake-local)  Standby: 127.0.0.1:5434 (standby-prueba)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Stopping lab containers and wiping volumes..."
docker compose -f docker-compose.lab.yml down -v --remove-orphans 2>/dev/null || true

echo "Starting healthy lab pair (primary :5435, standby :5434)..."
docker compose -f docker-compose.lab.yml up -d

for port in 5435 5434; do
  echo "Waiting for PostgreSQL on :${port}..."
  for _ in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -p "$port" -U tomy.berrios -d datalake >/dev/null 2>&1; then
      echo "  :${port} ready."
      break
    fi
    sleep 2
  done
done

echo "Done. Ensure buho-store is up (docker compose up -d store), then restart the collector and run: npx tsx scripts/run-checks-once.ts"
