#!/usr/bin/env bash
# Lab traffic for the 4-node Maria ring.
#
# Writes (INSERT only) go to maria-1 so circular GTID replication stays healthy.
# Long SELECTs hit PS-off nodes (3/4) for PROCESSLIST Queries without digests.
#
#   bash scripts/lab-simulate-maria-activity.sh [seconds]
set -euo pipefail

SECONDS_TOTAL="${1:-120}"
ROOT_PW="${MARIA_ROOT_PASSWORD:-Buho_Maria_Root1!}"
DB="${MARIA_DB:-tienda}"
WRITER="${MARIA_WRITER:-buho-maria-1}"

sql() {
  local container="$1"; shift
  docker exec "$container" mariadb -uroot -p"$ROOT_PW" -D"$DB" -N -e "$*" 2>/dev/null
}

echo "==> Maria traffic ${SECONDS_TOTAL}s · writer=${WRITER} (INSERT) · SLEEP on 3/4"
END=$((SECONDS + SECONDS_TOTAL))
N=0
while (( SECONDS < END )); do
  N=$((N + 1))
  sql "$WRITER" "
  INSERT INTO pedidos (cliente, total, status, region)
  VALUES (CONCAT('c-', ${N} % 50), 10 + RAND()*40, 'open',
          ELT(1 + (${N} % 4), 'norte', 'sur', 'centro', 'bajio'));
  SELECT COUNT(*) FROM pedidos WHERE status='open';
  " >/dev/null || true

  if (( N % 5 == 0 )); then
    # Background-friendly: short hold so PROCESSLIST sampling sees SQL text
    sql buho-maria-3 "SELECT SLEEP(1.2), COUNT(*) FROM pedidos;" >/dev/null || true
  fi
  if (( N % 7 == 0 )); then
    sql buho-maria-4 "SELECT SLEEP(1.2), region, COUNT(*) FROM pedidos GROUP BY region;" >/dev/null || true
  fi

  if (( N % 25 == 0 )); then
    echo "  … ${N} cycles, $((END - SECONDS))s left"
  fi
  sleep 0.3
done
echo "==> Done (${N} cycles)."
