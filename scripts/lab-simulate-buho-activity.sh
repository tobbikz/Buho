#!/usr/bin/env bash
# Lab workload for Búho.
#
# Purpose:
# - Make "Queries" / "Indexes" / "Wait events" screens show realistic activity.
# - Create dead tuples / larger tables via churn on the primary.
# - Generate index usage counters via read queries executed on the standby
#   that Búho actually monitors (instance_id=81 = standby-prueba).
# - Also generate activity on the primary (instance_id=1 = datalake-local)
#   so Overview charts like "DML throughput" are non-zero there too.
#
# Important:
# - Writes go to the primary ("datalake-local") because the standby is in
#   recovery/read-only mode.
# - Reads go to the standby ("standby-prueba") so pg_stat_* counters and
#   query plans are attributed to the monitored instance.
# - Additionally, we execute a subset of the reads on the primary so that
#   primary Overview graphs move as you test.
#
# Usage:
#   bash scripts/lab-simulate-buho-activity.sh [seconds] [enqueuePlans]
#
# Examples:
#   bash scripts/lab-simulate-buho-activity.sh 120 1
#   bash scripts/lab-simulate-buho-activity.sh 60 0

set -euo pipefail

SECONDS_TOTAL="${1:-90}"
ENQUEUE_PLANS="${2:-1}"

PRIMARY_CONTAINER="buho-datalake-primary"
STANDBY_CONTAINER="buho-datalake-standby"
DB="datalake"
PGUSER="buho_lab"
PGPASSWORD="Buho_Lab_Pg1!"

# Búho store instance_id mapping (see buho/config.json / buho.instances).
PRIMARY_INSTANCE_ID=1 # datalake-local
STANDBY_INSTANCE_ID=81 # standby-prueba

# When ENQUEUE_PLANS=1 we ask Búho to run EXPLAIN ANALYZE on both instances.
# (The wait loop still waits for both to be processed, so the lab completes
# in predictable time.)
PLAN_INSTANCE_IDS=("${PRIMARY_INSTANCE_ID}" "${STANDBY_INSTANCE_ID}")

STORE_CONTAINER="buho-store-1"
STORE_DB="buho"
STORE_USER="buho"

echo "Búho lab workload:"
echo "  primary   : ${PRIMARY_CONTAINER} (writes)"
echo "  standby   : ${STANDBY_CONTAINER} (reads / pg_stat attribution)"
echo "  duration  : ${SECONDS_TOTAL}s"
echo "  enqueue   : ${ENQUEUE_PLANS} (EXPLAIN ANALYZE plan requests)"

threshold_sql() {
  # Returns a numeric threshold with 2 decimals, e.g. 999.50
  # Uses only awk (avoid extra dependencies like Python/bc).
  awk -v r="$RANDOM" 'BEGIN {
    # Map 0..32767 -> 1.0..999.5 (roughly).
    x = 1.0 + (r / 32767.0) * (999.5 - 1.0);
    printf "%.2f", x;
  }'
}

customer_id_sql() {
  echo "$(( (RANDOM % 5000) + 1 ))"
}

region_sql() {
  # Must match values created by seed-index-demo.sql.
  case $((RANDOM % 5)) in
    0) echo "west" ;;
    1) echo "east" ;;
    2) echo "north" ;;
    3) echo "south" ;;
    *) echo "central" ;;
  esac
}

status_sql() {
  case $((RANDOM % 4)) in
    0) echo "pending" ;;
    1) echo "shipped" ;;
    2) echo "cancelled" ;;
    *) echo "delivered" ;;
  esac
}

wait_loop() {
  # Wait until collector has processed pending/corriendo requests.
  # This keeps the "Indexes" UI suggestions from looking empty.
  local tries=30
  while [ $tries -gt 0 ]; do
    local all_done=1
    for target_instance_id in "${PLAN_INSTANCE_IDS[@]}"; do
      pending="$(docker exec "${STORE_CONTAINER}" psql -U "${STORE_USER}" -d "${STORE_DB}" -qtAX -c \
        "select count(*) from buho.plan_requests where instance_id=${target_instance_id} and state in ('pendiente','corriendo');")"
      if [ "${pending}" != "0" ]; then
        all_done=0
        break
      fi
    done
    if [ "${all_done}" = "1" ]; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 2
  done
  return 1
}

escape_sql_literal() {
  # PostgreSQL string literal escaping: ' becomes ''.
  echo "$1" | sed "s/'/''/g"
}

start_at="$(date +%s)"
iteration=0

while true; do
  now_at="$(date +%s)"
  elapsed=$((now_at - start_at))
  if [ "${elapsed}" -ge "${SECONDS_TOTAL}" ]; then
    break
  fi

  iteration=$((iteration + 1))

  # 1) Writes on primary: create dead tuples (and touch indexed columns sometimes)
  # Keep queries small but repeated: the goal is to increase churn, not crash the lab.
  docker exec "${PRIMARY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "UPDATE buho_demo.orders
        SET amount = amount + (random() * 3.0), created_at = created_at + interval '1 second'
      WHERE id % 7 = 0;" >/dev/null

  docker exec "${PRIMARY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "UPDATE buho_demo.orders
        SET status = 'pending'
      WHERE id % 11 = 0;" >/dev/null

  # 2) Reads:
  #   - On standby: attributed to the monitored instance (instance_id=81)
  #     so Indexes / Queries suggestions feel "live".
  #   - On primary: subset of the same workload so primary Overview charts
  #     (DML throughput / commits / WAL) are visible while you test.
  th="$(threshold_sql)"
  cid="$(customer_id_sql)"
  st="$(status_sql)"
  reg="$(region_sql)"

  # Primary reads (no region predicate to avoid making the "region-only"
  # demo index look too "used" on the primary side).
  docker exec "${PRIMARY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "SELECT count(*) FROM buho_demo.orders WHERE amount > ${th};" >/dev/null

  docker exec "${PRIMARY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "SELECT id, amount
       FROM buho_demo.orders
      WHERE customer_id = ${cid} AND status = '${st}'
      ORDER BY amount DESC
      LIMIT 20;" >/dev/null

  # seq-scan heavy predicate (missing index / filter discard evidence)
  docker exec "${STANDBY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "SELECT count(*) FROM buho_demo.orders WHERE amount > ${th};" >/dev/null

  # index usage (customer_id, plus additional filters)
  docker exec "${STANDBY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "SELECT id, amount
       FROM buho_demo.orders
      WHERE customer_id = ${cid} AND status = '${st}'
      ORDER BY amount DESC
      LIMIT 20;" >/dev/null

  # mixed predicates (status/region) to help redundancy/missing index discussions
  docker exec "${STANDBY_CONTAINER}" psql -U "${PGUSER}" -d "${DB}" -q -c \
    "SELECT id
       FROM buho_demo.orders
      WHERE status = '${st}' AND region = '${reg}'
      ORDER BY id DESC
      LIMIT 20;" >/dev/null

  # 3) Enqueue a couple of ANALYZE plans for the Indexes screen (optional)
  if [ "${ENQUEUE_PLANS}" = "1" ] && [ $((iteration % 6)) -eq 0 ]; then
    sql1="SELECT count(*) FROM buho_demo.orders WHERE amount > ${th};"
    sql2="SELECT id, amount FROM buho_demo.orders WHERE status = '${st}' AND region = '${reg}' ORDER BY amount DESC LIMIT 20;"

    sql1e="$(escape_sql_literal "${sql1}")"
    sql2e="$(escape_sql_literal "${sql2}")"

    for target_instance_id in "${PLAN_INSTANCE_IDS[@]}"; do
      docker exec "${STORE_CONTAINER}" psql -U "${STORE_USER}" -d "${STORE_DB}" -q -c \
        "insert into buho.plan_requests (instance_id, queryid, sql, mode, requested_by, state)
         select ${target_instance_id}, null, '${sql1e}', 'analyze', 'lab-activity', 'pendiente'
         where not exists (
           select 1 from buho.plan_requests p
            where p.instance_id=${target_instance_id} and p.sql='${sql1e}'
              and p.mode='analyze' and p.state in ('pendiente','corriendo','listo')
              and (p.state!='listo' or p.finished_at > now() - interval '20 seconds')
         );
        insert into buho.plan_requests (instance_id, queryid, sql, mode, requested_by, state)
         select ${target_instance_id}, null, '${sql2e}', 'analyze', 'lab-activity', 'pendiente'
         where not exists (
           select 1 from buho.plan_requests p
            where p.instance_id=${target_instance_id} and p.sql='${sql2e}'
              and p.mode='analyze' and p.state in ('pendiente','corriendo','listo')
              and (p.state!='listo' or p.finished_at > now() - interval '20 seconds')
         );" >/dev/null || true
    done
  fi

  # Small pause between iterations.
  sleep 1
done

echo "Workload completed after ${SECONDS_TOTAL}s. Waiting for queued plans..."
if [ "${ENQUEUE_PLANS}" = "1" ]; then
  if wait_loop; then
    echo "Plans processed."
  else
    echo "Timeout waiting for plans; UI may update shortly."
  fi
fi

echo "Done."

