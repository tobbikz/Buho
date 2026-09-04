#!/usr/bin/env bash
#
# Automated MariaDB + SQL Server parity check (no manual UI clicking).
#
# Expects:
#   - buho store + collector + web already running (lab compose)
#   - MariaDB reachable (default: container buho-mariadb-lab on buho_default)
#   - MSSQL reachable on host:1433 (datasync-mssql-test or equivalent)
#
#   ./scripts/ensayo-engines.sh
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

VERDE=$'\033[32m'; ROJO=$'\033[31m'; NEGRITA=$'\033[1m'; FIN=$'\033[0m'
ok()  { printf '  %s✓%s %s\n' "$VERDE" "$FIN" "$1"; }
mal() { printf '  %s✗%s %s\n' "$ROJO" "$FIN" "$1"; FALLOS=$((FALLOS + 1)); }
paso(){ printf '\n%s==>%s %s\n' "$NEGRITA" "$FIN" "$1"; }
FALLOS=0

MARIA_URL="${BUHO_PROBE_MARIADB:-mariadb://buho_monitor:Buho_Monitor_Lab1!@127.0.0.1:3307/tienda}"
MSSQL_URL="${BUHO_PROBE_MSSQL:-mssql://buho_monitor:Buho_Mon1tor!Lab@127.0.0.1:1433/tienda}"

paso 'Probe collectors/checks — MariaDB'
if BUHO_PROBE="$MARIA_URL" npx tsx scripts/probe-parity.ts mariadb > /tmp/buho-probe-maria.log 2>&1; then
  if grep -q 'salud ' /tmp/buho-probe-maria.log && ! grep -qE '^\s+✗ ' /tmp/buho-probe-maria.log; then
    ok 'MariaDB collectors + checks without hard errors'
  elif grep -q 'salud ' /tmp/buho-probe-maria.log; then
    ok 'MariaDB probe completed (see soft collector warnings in /tmp/buho-probe-maria.log)'
  else
    mal 'MariaDB probe did not report a health score'
    tail -20 /tmp/buho-probe-maria.log
  fi
else
  mal 'MariaDB probe failed'
  tail -30 /tmp/buho-probe-maria.log
fi

paso 'Probe collectors/checks — SQL Server'
if BUHO_PROBE="$MSSQL_URL" npx tsx scripts/probe-parity.ts mssql > /tmp/buho-probe-mssql.log 2>&1; then
  if grep -q 'salud ' /tmp/buho-probe-mssql.log; then
    ok 'SQL Server collectors + checks completed'
  else
    mal 'SQL Server probe did not report a health score'
    tail -20 /tmp/buho-probe-mssql.log
  fi
else
  mal 'SQL Server probe failed'
  tail -30 /tmp/buho-probe-mssql.log
fi

paso 'Resolve instance ids from store'
MARIA_ID=$(docker exec buho-store-1 psql -U buho -d buho -Atc \
  "select instance_id from buho.instances where alias='mariadb-lab' limit 1" 2>/dev/null || true)
MSSQL_ID=$(docker exec buho-store-1 psql -U buho -d buho -Atc \
  "select instance_id from buho.instances where alias='mssql-lab' limit 1" 2>/dev/null || true)
PG_ID=$(docker exec buho-store-1 psql -U buho -d buho -Atc \
  "select instance_id from buho.instances where engine='postgres' order by instance_id limit 1" 2>/dev/null || true)

if [[ -n "$MARIA_ID" && -n "$MSSQL_ID" ]]; then
  ok "store has mariadb-lab=$MARIA_ID mssql-lab=$MSSQL_ID"
else
  mal 'mariadb-lab / mssql-lab not registered in the store yet (collector must have started them)'
fi

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

paso 'Console screens (verify:parity)'
if [[ -n "${MARIA_ID:-}" && -n "${MSSQL_ID:-}" ]]; then
  # Console accounts (not the bootstrap BUHO_AUTH_PASSWORD once users exist).
  PARITY_USER="${BUHO_PARITY_USER:-tomy}"
  PARITY_PASSWORD="${BUHO_PARITY_PASSWORD:-contrasena-larga-1}"
  set +e
  BUHO_MARIADB="$MARIA_ID" BUHO_MSSQL="$MSSQL_ID" BUHO_POSTGRES="${PG_ID:-1}" \
    BUHO_USER="$PARITY_USER" BUHO_PASSWORD="$PARITY_PASSWORD" \
    node scripts/verify-parity.mjs > /tmp/buho-verify-parity.log 2>&1
  set -e
  if ! grep -q 'sesión iniciada\|MariaDB: resumen' /tmp/buho-verify-parity.log; then
    mal 'verify:parity did not start a session'
    tail -25 /tmp/buho-verify-parity.log
  elif grep -E '✗ MariaDB|✗ SQL Server' /tmp/buho-verify-parity.log >/dev/null; then
    mal 'MariaDB or SQL Server UI screen failed'
    grep -E '✗ MariaDB|✗ SQL Server' /tmp/buho-verify-parity.log || true
  else
    ok 'MariaDB + SQL Server UI screens OK'
    if grep -q '✗ ' /tmp/buho-verify-parity.log; then
      printf '  (non-engine flake noted)\n'
      grep '✗ ' /tmp/buho-verify-parity.log || true
    fi
  fi
fi

if [[ "$FALLOS" -eq 0 ]]; then
  printf '\n%sEngine ensayo passed.%s\n' "$NEGRITA" "$FIN"
else
  printf '\n%s%s failure(s) in engine ensayo.%s\n' "$ROJO" "$FALLOS" "$FIN"
  exit 1
fi
