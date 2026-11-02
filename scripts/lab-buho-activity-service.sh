#!/usr/bin/env bash
# Continuous Búho lab activity generator (service wrapper).
#
# Runs indefinitely until SIGTERM/SIGINT.
# - Writes: churn on primary (datalake-local)
# - Reads: workload on standby (standby-prueba / instance_id=81)
# - Optional: TRUNCATE+RELOAD on the primary every N seconds to stress the UI.
#
# Tunables (env vars):
# - SIM_SECONDS (default: 60): how long each cycle of the workload runs
# - ENQUEUE_PLANS (default: 1): whether to enqueue EXPLAIN ANALYZE plans for Indexes
# - PAUSE_SECONDS (default: 2): sleep between cycles
# - TRUNCATE_EVERY_SECONDS (default: 600): 10 minutes
#
# Example:
#   SIM_SECONDS=60 ENQUEUE_PLANS=1 TRUNCATE_EVERY_SECONDS=600 bash lab-buho-activity-service.sh

set -euo pipefail

SIM_SECONDS="${SIM_SECONDS:-60}"
ENQUEUE_PLANS="${ENQUEUE_PLANS:-1}"
PAUSE_SECONDS="${PAUSE_SECONDS:-2}"
TRUNCATE_EVERY_SECONDS="${TRUNCATE_EVERY_SECONDS:-600}"

PRIMARY_CONTAINER="buho-datalake-primary"
DB="datalake"
PGUSER="buho_lab"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_SCRIPT="${SCRIPT_DIR}/lab-simulate-buho-activity.sh"

terminate=0
trap 'terminate=1' SIGINT SIGTERM

echo "Búho continuous activity service:"
echo "  SIM_SECONDS=${SIM_SECONDS}"
echo "  ENQUEUE_PLANS=${ENQUEUE_PLANS}"
echo "  PAUSE_SECONDS=${PAUSE_SECONDS}"
echo "  TRUNCATE_EVERY_SECONDS=${TRUNCATE_EVERY_SECONDS}"

start_at="$(date +%s)"
next_truncate=$((start_at + TRUNCATE_EVERY_SECONDS))

truncate_reload_primary() {
  echo "Truncate + reload on primary (every ${TRUNCATE_EVERY_SECONDS}s)..."
  docker exec "${PRIMARY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE buho_demo.orders;

INSERT INTO buho_demo.orders (id, customer_id, status, region, amount, created_at)
SELECT
  g,
  (g % 5000) + 1,
  CASE (g % 4) WHEN 0 THEN 'pending' WHEN 1 THEN 'shipped' WHEN 2 THEN 'cancelled' ELSE 'delivered' END,
  CASE (g % 5) WHEN 0 THEN 'west' WHEN 1 THEN 'east' WHEN 2 THEN 'north' WHEN 3 THEN 'south' ELSE 'central' END,
  (random() * 1000)::numeric(12,2),
  now() - ((g % 365) || ' days')::interval
FROM generate_series(1, 80000) g;

ANALYZE buho_demo.orders;
SQL
}

# Ensure demo schema exists (optional safety net).
ensure_seeded() {
  if docker exec "${PRIMARY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -qtAX -c \
    "select to_regclass('buho_demo.orders') is not null;" 2>/dev/null | grep -q "t"; then
    return 0
  fi

  echo "buho_demo.orders missing; seeding lab data first..."
  bash "${SCRIPT_DIR}/lab-seed-index-demo.sh"
}

ensure_seeded

while [ "${terminate}" = "0" ]; do
  now="$(date +%s)"
  if [ "${now}" -ge "${next_truncate}" ]; then
    truncate_reload_primary
    next_truncate=$((now + TRUNCATE_EVERY_SECONDS))
  fi

  echo "Starting workload cycle: ${SIM_SECONDS}s (enqueuePlans=${ENQUEUE_PLANS})"
  set +e
  bash "${BASE_SCRIPT}" "${SIM_SECONDS}" "${ENQUEUE_PLANS}"
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    echo "Workload cycle returned rc=${rc} (will retry after ${PAUSE_SECONDS}s)."
  fi

  if [ "${terminate}" = "1" ]; then
    break
  fi
  sleep "${PAUSE_SECONDS}"
done

echo "Stopped."

