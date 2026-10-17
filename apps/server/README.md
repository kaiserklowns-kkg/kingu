# Kingu team server (Phase 0 spike)

Go API that syncs **task metadata** for a team into PostgreSQL: projects, tasks,
agent runs and an audit log. It never receives or stores source code, diffs,
transcripts, credentials or other secrets (repo URLs with embedded credentials
are rejected).

- Go stdlib `net/http` routing (Go 1.22+ patterns) and `log/slog` (JSON to stderr)
- `github.com/jackc/pgx/v5` v5.11.0 (`pgxpool`)
- `github.com/pressly/goose/v3` v3.28.0, SQL migrations embedded from `migrations/`

## Run locally

Use a dedicated dev cluster rather than an existing database. Example with
Homebrew PostgreSQL 16:

```sh
PG=/opt/homebrew/opt/postgresql@16/bin
DEV=$HOME/.kingu-dev-pg

$PG/initdb -D $DEV/data -U postgres -A trust -E UTF8 --no-locale
$PG/pg_ctl -D $DEV/data -l $DEV/pg.log \
  -o "-k $DEV -c listen_addresses='' -p 55432" start

# The API must NOT run as a superuser/BYPASSRLS role (RLS would be ignored;
# the server refuses to start). Create an ordinary role that owns the DB.
$PG/psql -h $DEV -p 55432 -U postgres -c "CREATE ROLE kingu LOGIN NOSUPERUSER NOBYPASSRLS"
$PG/psql -h $DEV -p 55432 -U postgres -c "CREATE DATABASE kingu OWNER kingu"

export DATABASE_URL="host=$DEV port=55432 user=kingu dbname=kingu sslmode=disable"
export KINGU_API_ADDR=127.0.0.1:8787   # default

cd apps/server
go run ./cmd/api -migrate      # apply pending migrations, then serve
# go run ./cmd/api -migrate-only  # apply migrations and exit
# go run ./cmd/api                # serve only (schema must be current)

# There is no org endpoint yet: seed one as the superuser.
$PG/psql -h $DEV -p 55432 -U postgres -d kingu \
  -c "INSERT INTO orgs (name) VALUES ('dev') RETURNING id"
```

Stop the cluster with `$PG/pg_ctl -D $DEV/data stop`.

### Migrations: explicit, behind a flag

Migrations run **only** when `-migrate` (or `-migrate-only`) is passed. Schema
changes are a deliberate deploy step rather than a side effect of any replica
starting; later the migrate step can use a more privileged role than the
serving role. Migrations live in `migrations/*.sql` and are embedded into the
binary with `embed.FS`.

## Configuration

| Env var          | Default          | Notes                                  |
|------------------|------------------|----------------------------------------|
| `KINGU_API_ADDR` | `127.0.0.1:8787` | listen address                         |
| `DATABASE_URL`   | (required)       | libpq keyword/value or `postgres://` URL |

## Tenancy and Row-Level Security

Every org-scoped table (`orgs`, `members`, `projects`, `tasks`, `agent_runs`,
`audit_log`) has RLS **enabled and forced**. The policies compare `org_id` with
`app_current_org()`, which is
`NULLIF(current_setting('app.org_id', true), '')::uuid`. Each request runs in a
transaction that first calls `SELECT set_config('app.org_id', $1, true)`.
Because the setting is transaction-local, it cannot leak to the next user of a
pooled connection. With no org set, queries return no rows. Child tables also
use composite foreign keys (`(project_id, org_id)`, `(task_id, org_id)`), so a
row cannot reference another org's parent. `audit_log` is append-only: it has
only SELECT and INSERT policies.

## API

Every `/v1` request needs `X-Kingu-Org: <org uuid>`. Without it the API returns
401 `missing_org`, a malformed value returns 401 `invalid_org`, and an org that
does not exist returns 403 `unknown_org`. `X-Kingu-User` is an optional
dev-only actor name for `created_by` and the audit log (default `dev`).

| Method | Path                       | Body / query |
|--------|----------------------------|--------------|
| GET    | `/health`                  | Also pings the DB. 503 if the DB is unreachable. |
| POST   | `/v1/projects`             | `{name, repo_url, default_base_ref?="main"}` |
| GET    | `/v1/projects`             | `?limit=1..500` (default 100) |
| POST   | `/v1/projects/{id}/tasks`  | `{title (≤300), source?=manual\|github\|linear\|jira, external_ref? (required iff source≠manual), status?=backlog, branch?}` |
| GET    | `/v1/projects/{id}/tasks`  | `?status=…&limit=…` |
| PATCH  | `/v1/tasks/{id}`           | `{status?, branch?}` (at least one) |
| POST   | `/v1/tasks/{id}/runs`      | `{adapter, model?, machine_id?, started_at?, ended_at?, exit_reason?, input_tokens?, output_tokens?}` |

Task status is one of `backlog`, `running`, `needs_input`, `review`, `done` or
`failed`. Lists return `{"items": [...]}`.

Input handling:

- JSON bodies require `Content-Type: application/json`. Unknown fields,
  trailing data and bodies over 64 KiB are rejected.
- The server reads the body before it opens a DB transaction.
- Other orgs' resources return 404, the same as missing ones.
- Errors always have this shape:

```json
{"error": {"code": "invalid_status", "message": "status must be one of ..."}}
```

Codes: `missing_org`, `invalid_org`, `unknown_org`, `invalid_input`,
`invalid_status`, `invalid_json`, `unknown_field`, `unsupported_media_type`,
`body_too_large`, `not_found`, `conflict`, `internal`.

## Tests

```sh
go test ./...
```

The integration tests in `internal/api` create a throwaway cluster:

1. Run `initdb` into a temp dir.
2. Start it with `pg_ctl` on a free port, listening only on a Unix socket inside
   that dir (`listen_addresses=''`).
3. Create a non-superuser role and database, then run the migrations as that
   role.
4. Exercise the API through `httptest`.
5. Stop the cluster and delete the temp dir.

The tests never touch an existing cluster or the default data directory. They
look for binaries in `$KINGU_PG_BIN`, then `/opt/homebrew/opt/postgresql@16/bin`,
then `pg_ctl` on `PATH`. If none is found, they skip.

## TODO

- **Auth (OIDC):** `X-Kingu-Org` / `X-Kingu-User` are dev-only stand-ins.
  Replace them with OIDC bearer tokens. Derive the org and role from verified
  claims plus the `members` table, then enforce roles (owner/lead/dev/viewer)
  per endpoint.
- **Rate limiting:** add per-org and per-IP limits before exposing the server
  beyond localhost.
- Endpoints for org and member management, listing and closing runs, and
  reading the audit log.
- Cursor pagination instead of `limit` only.
- TLS and deployment config. Use a separate migration role from the serving
  role.
