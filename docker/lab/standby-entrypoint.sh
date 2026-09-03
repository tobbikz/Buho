#!/bin/sh
set -eu

: "${PGDATA:=/var/lib/postgresql/18/docker}"

if [ -s "$PGDATA/PG_VERSION" ]; then
  exec /usr/local/bin/docker-entrypoint.sh postgres \
    -c config_file=/etc/postgresql/postgresql.conf \
    -c hba_file=/etc/postgresql/pg_hba.conf \
    "$@"
fi

echo "standby init: waiting for primary at datalake-primary:5432"
until pg_isready -h datalake-primary -p 5432 -U "$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 2
done

gosu postgres sh -eu -c "
  export PGPASSWORD='$POSTGRES_PASSWORD'
  rm -rf '$PGDATA'/*
  pg_basebackup -h datalake-primary -p 5432 -U '$POSTGRES_USER' -D '$PGDATA' -Fp -Xs -P -R -C -S buho_standby
"

exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c config_file=/etc/postgresql/postgresql.conf \
  -c hba_file=/etc/postgresql/pg_hba.conf \
  "$@"
