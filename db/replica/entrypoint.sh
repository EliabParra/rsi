#!/bin/bash
set -e
PRIMARY_HOST="${PRIMARY_HOST:-db-primary}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
REPL_PASS="${POSTGRES_REPLICATION_PASSWORD:-replicator}"
PGDATA="/var/lib/postgresql/data"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Esperando al Primary..."
  until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER"; do
    sleep 2
  done
  echo "Clonando datos del Primary con pg_basebackup..."
  rm -rf "$PGDATA"/*
  PGPASSWORD="$REPL_PASS" pg_basebackup \
    -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" \
    -D "$PGDATA" -Fp -Xs -P -R
  echo "Réplica inicializada."
fi
# hot_standby_feedback=on: la réplica le avisa al primary qué filas siguen
# usando sus lectores, para que el primary NO las limpie (autovacuum) y así
# evitar "terminating connection due to conflict with recovery" bajo carga.
exec docker-entrypoint.sh postgres \
  -c hot_standby_feedback=on \
  -c max_standby_streaming_delay=30s
