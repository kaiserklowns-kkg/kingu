# Kingu team server (Phase 0 spike)

Go API that syncs **task metadata** for a team into PostgreSQL: projects, tasks,
agent runs, an audit log and a live event feed. It never receives or stores
source code, diffs, transcripts, credentials or other secrets (repo URLs with
embedded credentials are rejected, and the desktop sync endpoint rejects
anything that looks like file contents, a diff or a credential).

The one exception is **team artifacts**: a page an agent made that a member
explicitly chooses to share with the team (one self-contained HTML file of at
most 2 MiB per artifact, refused when it looks like it contains a credential).
Lists and events carry only its metadata.

- Go stdlib `net/http` routing (Go 1.22+ patterns) and `log/slog` (JSON to stderr)
- `github.com/jackc/pgx/v5` v5.11.0 (`pgxpool`, LISTEN/NOTIFY)
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
KINGU_DEV=1 go run ./cmd/api -migrate   # apply pending migrations, then serve (dev mode)
# go run ./cmd/api -migrate-only        # apply migrations and exit
# go run ./cmd/api                      # serve only, production auth (tokens only)
```

With `KINGU_DEV=1`, create an org and a token in one call (no psql needed):

```sh
curl -s -X POST localhost:8787/v1/dev/tokens -H 'Content-Type: application/json' \
  -d '{"org_name":"dev","user_id":"you"}'
# {"id":"…","token":"kgu_…","prefix":"kgu_AbCd1234","org_id":"…","user_id":"you","role":"owner",…}
TOKEN=kgu_…
curl -s localhost:8787/v1/me -H "Authorization: Bearer $TOKEN"
curl -sN localhost:8787/v1/events -H "Authorization: Bearer $TOKEN"   # live SSE stream
```

Without dev mode, mint tokens from the CLI (the org must exist):

```sh
go run ./cmd/api -mint-token-org <org uuid> -mint-token-user alice [-mint-token-role dev]
```

Then run the dashboard (`apps/web`, see its README) with
`KINGU_API_URL=http://127.0.0.1:8787 bun run dev:web` and sign in with the token.

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
| `KINGU_DEV`      | unset            | `1` enables the `X-Kingu-Org`/`X-Kingu-User` headers and `POST /v1/dev/tokens`. Never set it on a reachable server. |

Rate limit (20 req/s, burst 40 per credential), SSE heartbeat (15s), concurrent
streams per credential (4) and event pruning interval (10 min) are fields of
`api.Config`.

## Authentication

- **Personal access tokens** (`Authorization: Bearer kgu_<43 base64url chars>`).
  Only the SHA-256 of the token is stored (`api_tokens.token_hash`) with a
  display prefix (`kgu_AbCd1234`). The plaintext is shown once at mint time.
  A token resolves to `(org_id, user_id)`; the role comes from `members`, so
  removing a member disables their tokens. Revoked (`revoked_at`) and expired
  (`expires_at`) tokens return 401 `invalid_token`.
- The token lookup runs before the org is known, so `api_tokens` has an extra
  RLS policy that exposes exactly the row whose hash equals the
  transaction-local `app.token_hash`.
- `viewer` members are read-only (403 `forbidden` on writes).
- **Dev headers** (`X-Kingu-Org`, optional `X-Kingu-User`) are accepted only
  with `KINGU_DEV=1`, and act as an `owner`. A bearer token always wins.
- **OIDC (TODO):** `internal/api/auth.go` defines the `Authenticator`
  interface. An OIDC implementation verifies JWTs against the issuer's JWKS,
  maps the subject to `members.user_id` and is registered in `api.New` ahead of
  the PAT authenticator.

## Rate limiting

An in-memory token bucket per credential (token id, or org+user for dev
headers): 20 requests/second sustained, burst 40. Over the limit the API
returns 429 `rate_limited` with `Retry-After`. Failed authentication is also
limited per client IP. Buckets are per replica.

## Tenancy and Row-Level Security

Every org-scoped table (`orgs`, `members`, `projects`, `tasks`, `agent_runs`,
`audit_log`, `api_tokens`, `org_events`, `team_snaps`, `team_artifacts`) has RLS **enabled and forced**. The
policies compare `org_id` with `app_current_org()`, which is
`NULLIF(current_setting('app.org_id', true), '')::uuid`. Each request runs in a
transaction that first calls `SELECT set_config('app.org_id', $1, true)` with
the org of the authenticated principal. Because the setting is
transaction-local, it cannot leak to the next user of a pooled connection.
With no org set, queries return no rows. Child tables also use composite
foreign keys (`(project_id, org_id)`, `(task_id, org_id)`), so a row cannot
reference another org's parent. `audit_log` and `org_events` are append-only
for orgs: they have only SELECT and INSERT policies (plus the retention policy
below for `org_events`).

## API

Every `/v1` request needs `Authorization: Bearer kgu_…` (or, in dev mode,
`X-Kingu-Org: <org uuid>`). Without credentials the API returns 401
`missing_token` (`missing_org` in dev mode).

| Method | Path                       | Body / query |
|--------|----------------------------|--------------|
| GET    | `/health`                  | Also pings the DB. 503 if the DB is unreachable. |
| GET    | `/v1/me`                   | `{org_id, org_name, user_id, role, token_prefix}` |
| POST   | `/v1/projects`             | `{name, repo_url, default_base_ref?="main"}` |
| GET    | `/v1/projects`             | `?limit=1..500` (default 100) |
| POST   | `/v1/projects/{id}/tasks`  | `{title (≤300), source?=manual\|github\|linear\|jira, external_ref? (required iff source≠manual), status?=backlog, branch?}` |
| GET    | `/v1/projects/{id}/tasks`  | `?status=…&limit=…` |
| GET    | `/v1/tasks`                | Org-wide, newest change first: `?project_id=&status=&limit=` |
| PATCH  | `/v1/tasks/{id}`           | `{status?, branch?}` (at least one) |
| PUT    | `/v1/tasks/{client_task_id}/sync` | Desktop upsert, see below |
| POST   | `/v1/tasks/{id}/runs`      | `{adapter, model?, machine_id?, started_at?, ended_at?, exit_reason?, input_tokens?, output_tokens?, cost_usd?}` |
| PUT    | `/v1/tasks/{client_task_id}/runs/{client_run_id}/sync` | Desktop run upsert, see below |
| GET    | `/v1/runs`                 | Run history with `task_title`, `project_name`, `source`, `external_ref`, `cost_usd`, `created_by`, newest first: `?task_id=&limit=` |
| GET    | `/v1/snaps`                | Team Snap catalog (any member), see below |
| PUT    | `/v1/snaps/{snap_id}`      | **owner/lead.** Approve and pin a snap, see below |
| DELETE | `/v1/snaps/{snap_id}`      | **owner/lead.** Remove it from the catalog |
| GET    | `/v1/artifacts`            | Shared artifacts, newest first, without their pages (any member) |
| GET    | `/v1/artifacts/{artifact_id}` | One shared artifact with its `html` (any member) |
| PUT    | `/v1/artifacts/{artifact_id}` | **Not viewers.** Share or replace a page, see below |
| DELETE | `/v1/artifacts/{artifact_id}` | **Its sharer or owner/lead.** Stop sharing it |
| GET    | `/v1/events`               | Server-Sent Events, see below |
| POST   | `/v1/dev/tokens`           | **Dev only.** `{org_id \| org_name, user_id, role?="owner", name?, ttl_hours?}` |

Task status is one of `backlog`, `running`, `needs_input`, `review`, `done` or
`failed`. Lists return `{"items": [...]}`.

### `PUT /v1/tasks/{client_task_id}/sync`

Idempotent upsert keyed by `(project_id, client_task_id)`; `client_task_id`
(path) matches `[A-Za-z0-9._:-]{1,128}`.

```json
{"project_id": "uuid", "title": "Add login page", "status": "running",
 "branch": "kingu/add-login", "agent": "claude-code", "model": "opus",
 "diff_stats": {"additions": 12, "deletions": 3, "files_changed": 2},
 "started_at": "2026-10-17T09:00:00Z", "finished_at": null,
 "source": "github", "external_ref": "acme/app#42",
 "updated_at": "2026-10-17T10:00:00Z"}
```

`source`/`external_ref` are optional (absent = `manual`, no reference);
`external_ref` is required iff the source is not `manual`. Several desktop tasks
may reference the same issue (the import uniqueness applies only to tasks
created with `POST /v1/projects/{id}/tasks`).

- Returns `{task, created, applied}`: 201 when created, else 200.
  `applied: false` means nothing changed (an exact retry, or a state whose
  `updated_at` is older than the stored one). No-op calls write no audit row and
  emit no event.
- Strict: unknown fields (also inside `diff_stats`) → 400 `unknown_field`;
  bodies over 8 KiB → 413; any string over 2 KiB, multi-line, or containing
  diff markers (`diff --git`, `@@ -`, `+++ b/`), PEM blocks or well-known token
  formats → 422 `content_not_allowed`. `updated_at` is required and may be at
  most 24h in the future.

### `PUT /v1/tasks/{client_task_id}/runs/{client_run_id}/sync`

Idempotent upsert of one agent run of a synced task, keyed by
`(task, client_run_id)`; both path ids match `[A-Za-z0-9._:-]{1,128}`.

```json
{"project_id": "uuid", "adapter": "claude-code", "model": "opus",
 "exit_reason": "done", "started_at": "2026-10-17T09:00:00Z",
 "ended_at": "2026-10-17T09:05:00Z", "input_tokens": 1500,
 "output_tokens": 300, "cost_usd": 0.4213,
 "updated_at": "2026-10-17T09:05:00Z"}
```

- Returns `{run, created, applied}` with the same newest-state-wins rules and
  content screening as task sync. `started_at` and `updated_at` are required;
  `cost_usd` (0..1000000) may be omitted when unknown. `created_by` is the
  caller.
- 409 `task_not_synced` when the task has not been synced yet: the desktop
  retries it after the task's own sync.

### Team Snap catalog (`/v1/snaps`)

Snaps an org approved for its desktops, pinned to a git commit and the snap's
manifest hash (the desktop's trust hash: SHA-256 of `snap.toml`, plus skill
files when the snap has skills). Only metadata is stored; the code stays in
git and each desktop clones `git_url` at `commit_sha` itself and refuses a
manifest whose hash differs.

```json
PUT /v1/snaps/go
{"name": "Go tools", "version": "1.0.0",
 "git_url": "https://github.com/acme/kingu-go.git", "git_ref": "v1",
 "commit_sha": "<40 lowercase hex>", "manifest_sha256": "<64 lowercase hex>",
 "permissions": {"network": false, "fs": "worktree", "secrets": ["GO_TOKEN"]},
 "required": false, "note": "optional, one line"}
```

- `snap_id` (path) matches `^[a-z0-9][a-z0-9-]{0,39}$`; `git_url` must be
  `https://`, `ssh://` or `user@host:path` without credentials (no `file://`,
  local paths or `http://`); `permissions.secrets` holds names only.
- 201 when created, 200 when it replaces the org's earlier approval of that id
  (`approved_by`/`approved_at` are set by the server). `dev` and `viewer`
  members get 403 `forbidden` on PUT/DELETE.
- Changes emit `snap.updated` / `snap.removed` on `/v1/events` and are audited
  (`snap.approve`, `snap.remove`).

### Team artifacts (`/v1/artifacts`)

Pages an agent made that a member shared from the desktop (the desktop inlines
the page's assets first), for teammates to open read-only.

```json
PUT /v1/artifacts/0123456789abcdef
{"title": "Benchmark results", "description": null, "format": "html",
 "version": 3, "html": "<!doctype html>…"}
```

- `artifact_id` (path) is the desktop's id, 16 lowercase hex characters;
  `title` 1–200 characters, `description` null or 1–1000, `format` `html` or
  `markdown` (what the desktop made it from; `html` is always the rendered
  page), `version` 1–1000000.
- `html` is 1 byte to 2 MiB of UTF-8 (413 `body_too_large` above; the route
  accepts bodies up to 3 MiB instead of the usual 64 KB). A page that looks
  like it holds a credential is rejected with 422 `content_not_allowed`.
- The server sets `sha256`, `size_bytes`, `shared_by`, `shared_at` and
  `updated_at`. 201 when shared, 200 when replaced; only the sharer or an
  owner/lead may replace or delete it (403 `forbidden`), viewers never write.
- Responses never echo `html` except `GET /v1/artifacts/{artifact_id}`.
- Changes emit `artifact.shared` / `artifact.removed` on `/v1/events` (metadata
  only) and are audited (`artifact.share`, `artifact.remove`).

### `GET /v1/events` (SSE)

- One stream per request, scoped to the caller's org by RLS. Messages:
  `id: <n>` / `event: task.created|task.updated|run.created|run.updated|snap.updated|snap.removed` /
  `data: {"id","kind","project_id","task_id","at","data":{…row metadata…}}`.
- Triggers on `tasks` and `agent_runs` insert the event row into `org_events`
  and `pg_notify('kingu_events', '<org_id>:<event_id>')`. One dedicated
  connection per server `LISTEN`s and wakes that org's streams, which read new
  rows from their last id under RLS (the notification itself carries no data).
- A `: ping` comment every 15s keeps proxies from closing the stream (each
  heartbeat also catches up, as a fallback if a NOTIFY was missed).
- `Last-Event-ID` (or `?last_event_id=`) replays everything after that id. If
  that event has been pruned or more than 2000 events are missing, the server
  sends `event: reset` and the client should reload its snapshot.
- Retention: events older than 72 hours are deleted every 10 minutes. The
  pruner enables a dedicated RLS policy (`app.prune_events = on`) that can only
  see and delete expired rows.

Input handling:

- JSON bodies require `Content-Type: application/json`. Unknown fields,
  trailing data and bodies over 64 KiB are rejected.
- The server reads the body before it opens a DB transaction.
- Other orgs' resources return 404, the same as missing ones.
- Errors always have this shape:

```json
{"error": {"code": "invalid_status", "message": "status must be one of ..."}}
```

Codes: `missing_token`, `invalid_token`, `missing_org`, `invalid_org`,
`unknown_org`, `forbidden`, `rate_limited`, `too_many_streams`,
`invalid_input`, `invalid_status`, `invalid_json`, `unknown_field`,
`content_not_allowed`, `unsupported_media_type`, `body_too_large`,
`not_found`, `conflict`, `internal`.

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
4. Exercise the API through `httptest`: dev headers and tokens, RLS isolation
   (HTTP and SQL level, including tokens and events), idempotent sync and its
   validation, SSE (an event delivered via NOTIFY with the heartbeat disabled,
   heartbeat, `Last-Event-ID` replay, retention + `reset`) and 429s.
5. Stop the cluster and delete the temp dir.

The tests never touch an existing cluster or the default data directory. They
look for binaries in `$KINGU_PG_BIN`, then `/opt/homebrew/opt/postgresql@16/bin`,
then `pg_ctl` on `PATH`. If none is found, they skip.

## TODO

- **Auth (OIDC):** implement the `Authenticator` for OIDC bearer JWTs (see
  above), then enforce owner/lead/dev roles per endpoint beyond viewer = read-only.
- Token management endpoints (list/revoke for the caller and for org owners).
- Rate limiting is per replica (in memory); move to a shared store when
  running several replicas.
- Endpoints for org and member management, closing runs, and reading the
  audit log.
- Cursor pagination instead of `limit` only.
- TLS and deployment config. Use a separate migration role from the serving
  role.
