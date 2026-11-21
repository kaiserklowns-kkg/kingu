#!/bin/sh
# Runs once, when the database volume is first created.
# kingu_owner owns the schema and runs migrations; kingu_app serves the API and
# only gets data access (granted by the migrate job), so it can never alter the
# schema. Neither may bypass row-level security.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE kingu_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${KINGU_OWNER_PASSWORD}';
CREATE ROLE kingu_app   LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${KINGU_APP_PASSWORD}';
CREATE DATABASE kingu OWNER kingu_owner;
REVOKE ALL ON DATABASE kingu FROM PUBLIC;
GRANT CONNECT ON DATABASE kingu TO kingu_app;
SQL
