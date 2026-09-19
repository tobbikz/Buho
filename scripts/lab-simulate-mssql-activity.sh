#!/usr/bin/env bash
# Lab workload for Búho MSSQL (mssql-lab / tienda).
#
# Mirrors scripts/lab-simulate-buho-activity.sh for PostgreSQL:
# churn + reads so Overview / Queries / Sessions / Locks / Flow move.
#
# Usage:
#   bash scripts/lab-simulate-mssql-activity.sh [seconds]
#
set -euo pipefail

SECONDS_TOTAL="${1:-180}"
CONTAINER="${MSSQL_CONTAINER:-datasync-mssql-test}"
SA_PASSWORD="${MSSQL_SA_PASSWORD:-DataSync_Dev1!}"
DB="${MSSQL_DB:-tienda}"

sql() {
  docker exec -e MSSQL_SA_PASSWORD="$SA_PASSWORD" "$CONTAINER" \
    /opt/mssql-tools18/bin/sqlcmd -S 127.0.0.1,1433 -U sa -P "$SA_PASSWORD" -C -d "$DB" \
    -b -h -1 -W -Q "SET NOCOUNT ON; $1" 2>/dev/null
}

echo "==> Ensuring schema + Query Store + SPs on ${DB}"
sql "
IF OBJECT_ID(N'dbo.pedidos', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.pedidos (
    id INT IDENTITY(1,1) PRIMARY KEY,
    cliente NVARCHAR(64) NOT NULL,
    total DECIMAL(12,2) NOT NULL,
    status NVARCHAR(20) NOT NULL CONSTRAINT DF_pedidos_status DEFAULT N'open',
    region NVARCHAR(32) NOT NULL CONSTRAINT DF_pedidos_region DEFAULT N'centro',
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_pedidos_created DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_pedidos_status_region ON dbo.pedidos(status, region) INCLUDE (total);
END
IF COL_LENGTH(N'dbo.pedidos', N'status') IS NULL
  ALTER TABLE dbo.pedidos ADD status NVARCHAR(20) NOT NULL CONSTRAINT DF_pedidos_status2 DEFAULT N'open';
IF COL_LENGTH(N'dbo.pedidos', N'region') IS NULL
  ALTER TABLE dbo.pedidos ADD region NVARCHAR(32) NOT NULL CONSTRAINT DF_pedidos_region2 DEFAULT N'centro';
IF COL_LENGTH(N'dbo.pedidos', N'created_at') IS NULL
  ALTER TABLE dbo.pedidos ADD created_at DATETIME2(3) NOT NULL CONSTRAINT DF_pedidos_created2 DEFAULT SYSUTCDATETIME();

ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE);

IF OBJECT_ID(N'dbo.usp_pedidos_resumen', N'P') IS NULL
  EXEC(N'CREATE PROCEDURE dbo.usp_pedidos_resumen AS
    SELECT region, COUNT(*) AS n, SUM(total) AS total FROM dbo.pedidos GROUP BY region');
IF OBJECT_ID(N'dbo.usp_pedidos_top', N'P') IS NULL
  EXEC(N'CREATE PROCEDURE dbo.usp_pedidos_top @n INT = 20 AS
    SELECT TOP (@n) id, cliente, total, status, region FROM dbo.pedidos ORDER BY total DESC');
"

echo "==> Seeding base rows if empty"
COUNT=$(sql "SELECT COUNT(*) FROM dbo.pedidos;" | tr -d '[:space:]' || echo 0)
if [[ "${COUNT:-0}" -lt 500 ]]; then
  sql "
  DECLARE @i INT = 0;
  WHILE @i < 2000
  BEGIN
    INSERT INTO dbo.pedidos (cliente, total, status, region)
    VALUES (
      CONCAT(N'c-', (@i % 50) + 1),
      CAST(10 + (@i % 90) + RAND() * 40 AS DECIMAL(12,2)),
      CASE WHEN @i % 7 = 0 THEN N'cancelled' WHEN @i % 3 = 0 THEN N'shipped' ELSE N'open' END,
      CASE @i % 4 WHEN 0 THEN N'norte' WHEN 1 THEN N'sur' WHEN 2 THEN N'centro' ELSE N'bajio' END
    );
    SET @i += 1;
  END
  "
fi

# Background holders so Sessions (dm_exec_requests sampling ~10s) actually
# catches something: short DML finishes between photos otherwise.
echo "==> Starting background wait / CPU holders for Sessions"
HOLDER_PIDS=()
cleanup_holders() {
  for p in "${HOLDER_PIDS[@]:-}"; do
    kill "$p" 2>/dev/null || true
  done
}
trap cleanup_holders EXIT

hold_wait() {
  while true; do
    sql "WAITFOR DELAY '00:00:12';" >/dev/null || true
  done
}
hold_cpu() {
  while true; do
    sql "
    DECLARE @i INT = 0, @x FLOAT = 0;
    WHILE @i < 400000 BEGIN SET @x = @x + SQRT(@i + 1.0); SET @i += 1; END
    SELECT @x;
    " >/dev/null || true
  done
}
hold_wait & HOLDER_PIDS+=($!)
hold_wait & HOLDER_PIDS+=($!)
hold_cpu & HOLDER_PIDS+=($!)

echo "==> Traffic loop ${SECONDS_TOTAL}s"
END=$((SECONDS + SECONDS_TOTAL))
N=0
while (( SECONDS < END )); do
  N=$((N + 1))
  TH=$((20 + RANDOM % 80))
  ST=$(printf '%s' 'open shipped cancelled' | cut -d' ' -f$((1 + RANDOM % 3)))
  REG=$(printf '%s' 'norte sur centro bajio' | cut -d' ' -f$((1 + RANDOM % 4)))
  CID=$((1 + RANDOM % 50))

  # Writes (DML)
  sql "
  INSERT INTO dbo.pedidos (cliente, total, status, region)
  VALUES (N'c-${CID}', CAST(${TH}.${RANDOM:0:2} AS DECIMAL(12,2)), N'${ST}', N'${REG}');
  UPDATE TOP (3) dbo.pedidos SET total = total + 0.01, status = N'${ST}'
   WHERE region = N'${REG}' AND id > 0;
  DELETE TOP (1) FROM dbo.pedidos WHERE status = N'cancelled' AND total < 15;
  " >/dev/null || true

  # Reads (plans / Query Store / sessions) + SPs for Procedures tab
  sql "
  SELECT COUNT(*) FROM dbo.pedidos WHERE total > ${TH};
  SELECT TOP 20 id, cliente, total FROM dbo.pedidos
   WHERE status = N'${ST}' AND region = N'${REG}' ORDER BY total DESC;
  SELECT region, COUNT(*), SUM(total) FROM dbo.pedidos GROUP BY region;
  EXEC dbo.usp_pedidos_resumen;
  EXEC dbo.usp_pedidos_top @n=10;
  " >/dev/null || true

  # Blocking pair long enough to land in a session photo + Locks
  if (( N % 8 == 0 )); then
    sql "
    BEGIN TRAN;
    UPDATE dbo.pedidos SET total = total WHERE id = 1;
    WAITFOR DELAY '00:00:08';
    COMMIT;
    " >/dev/null &
    sleep 0.4
    sql "UPDATE dbo.pedidos SET total = total + 0.01 WHERE id = 1;" >/dev/null || true
    wait || true
  fi

  sleep 0.25
  if (( N % 20 == 0 )); then
    echo "  … ${N} cycles, $((END - SECONDS))s left"
  fi
done

cleanup_holders
trap - EXIT
echo "==> Done (${N} cycles). Refresh Overview / Queries / Sessions / Replication on mssql-lab."
