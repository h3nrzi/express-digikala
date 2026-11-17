#!/bin/sh
set -e

# Automatically create the test database when the postgres container initializes
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE marketplace_test;
    GRANT ALL PRIVILEGES ON DATABASE marketplace_test TO $POSTGRES_USER;
EOSQL
