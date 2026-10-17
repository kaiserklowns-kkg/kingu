-- Team visibility: personal access tokens, desktop task sync and the org
-- event feed behind GET /v1/events.
--
-- Still METADATA ONLY: nothing here may hold source code, diffs, prompts,
-- transcripts or secrets. Tokens are stored as SHA-256 hashes; the plaintext
-- is shown once at mint time and never persisted.

-- +goose Up

-- Personal access tokens ------------------------------------------------------

-- +goose StatementBegin
CREATE FUNCTION app_current_token_hash() RETURNS bytea
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT decode(NULLIF(current_setting('app.token_hash', true), ''), 'hex')
$$;
-- +goose StatementEnd

CREATE TABLE api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    user_id      text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 255),
    name         text NOT NULL DEFAULT '' CHECK (char_length(name) <= 100),
    -- SHA-256 of the full plaintext token ("kgu_" + 43 base64url chars).
    token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    -- First characters of the token, safe to display ("kgu_AbCd1234").
    prefix       text NOT NULL CHECK (char_length(prefix) BETWEEN 4 AND 16),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz,
    FOREIGN KEY (org_id, user_id) REFERENCES members (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX api_tokens_org_user_idx ON api_tokens (org_id, user_id);

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;

-- Normal org scoping (listing / revoking an org's tokens).
CREATE POLICY org_isolation ON api_tokens
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
-- Authentication happens before the org is known: the auth middleware sets
-- app.token_hash (hex) and may then see exactly the one row whose hash matches.
-- Knowing the hash requires knowing the token, so this exposes nothing new.
CREATE POLICY token_lookup ON api_tokens FOR SELECT
    USING (token_hash = app_current_token_hash());
CREATE POLICY token_touch ON api_tokens FOR UPDATE
    USING (token_hash = app_current_token_hash())
    WITH CHECK (token_hash = app_current_token_hash());

-- Desktop task sync -----------------------------------------------------------

ALTER TABLE tasks
    -- Desktop-generated id; (project_id, client_task_id) is the sync key.
    ADD COLUMN client_task_id    text CHECK (client_task_id IS NULL OR client_task_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD COLUMN agent             text CHECK (agent IS NULL OR char_length(agent) BETWEEN 1 AND 100),
    ADD COLUMN model             text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
    ADD COLUMN additions         integer NOT NULL DEFAULT 0 CHECK (additions BETWEEN 0 AND 100000000),
    ADD COLUMN deletions         integer NOT NULL DEFAULT 0 CHECK (deletions BETWEEN 0 AND 100000000),
    ADD COLUMN files_changed     integer NOT NULL DEFAULT 0 CHECK (files_changed BETWEEN 0 AND 1000000),
    ADD COLUMN started_at        timestamptz,
    ADD COLUMN finished_at       timestamptz,
    -- Client clock of the latest accepted sync; older updates are ignored.
    ADD COLUMN client_updated_at timestamptz,
    ADD COLUMN updated_by        text CHECK (updated_by IS NULL OR char_length(updated_by) BETWEEN 1 AND 255);

CREATE UNIQUE INDEX tasks_client_task_uq ON tasks (project_id, client_task_id)
    WHERE client_task_id IS NOT NULL;
CREATE INDEX tasks_org_updated_idx ON tasks (org_id, updated_at DESC);

-- Org event feed --------------------------------------------------------------

CREATE TABLE org_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated')),
    project_id uuid,
    task_id    uuid,
    -- Snapshot of the changed row's metadata columns (never content).
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_events_org_id_idx ON org_events (org_id, id);
CREATE INDEX org_events_created_idx ON org_events (created_at);

ALTER TABLE org_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_events FORCE ROW LEVEL SECURITY;

-- Append-only for orgs: SELECT and INSERT only.
CREATE POLICY org_isolation_select ON org_events FOR SELECT
    USING (org_id = app_current_org());
CREATE POLICY org_isolation_insert ON org_events FOR INSERT
    WITH CHECK (org_id = app_current_org());
-- Bounded retention: the pruner sets app.prune_events = 'on' and may then see
-- and delete ONLY rows older than the 72 hour retention window, in any org.
-- (DELETE ... WHERE needs the rows to pass a SELECT policy as well.)
CREATE POLICY retention_prune_select ON org_events FOR SELECT
    USING (current_setting('app.prune_events', true) = 'on'
           AND created_at < now() - interval '72 hours');
CREATE POLICY retention_prune_delete ON org_events FOR DELETE
    USING (current_setting('app.prune_events', true) = 'on'
           AND created_at < now() - interval '72 hours');

-- Every task/run change records an event and wakes SSE listeners. The NOTIFY
-- payload carries only "<org_id>:<event_id>"; listeners read the event row
-- back under RLS, so the channel never carries data across orgs.

-- +goose StatementBegin
CREATE FUNCTION app_record_task_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
BEGIN
    INSERT INTO org_events (org_id, kind, project_id, task_id, payload)
    VALUES (NEW.org_id,
            CASE WHEN TG_OP = 'INSERT' THEN 'task.created' ELSE 'task.updated' END,
            NEW.project_id, NEW.id,
            jsonb_build_object(
                'id', NEW.id, 'project_id', NEW.project_id, 'client_task_id', NEW.client_task_id,
                'title', NEW.title, 'source', NEW.source, 'status', NEW.status, 'branch', NEW.branch,
                'agent', NEW.agent, 'model', NEW.model,
                'additions', NEW.additions, 'deletions', NEW.deletions, 'files_changed', NEW.files_changed,
                'created_by', NEW.created_by, 'updated_by', NEW.updated_by,
                'started_at', NEW.started_at, 'finished_at', NEW.finished_at,
                'created_at', NEW.created_at, 'updated_at', NEW.updated_at))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', NEW.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app_record_run_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
    proj  uuid;
BEGIN
    SELECT project_id INTO proj FROM tasks WHERE id = NEW.task_id;
    INSERT INTO org_events (org_id, kind, project_id, task_id, payload)
    VALUES (NEW.org_id,
            CASE WHEN TG_OP = 'INSERT' THEN 'run.created' ELSE 'run.updated' END,
            proj, NEW.task_id,
            jsonb_build_object(
                'id', NEW.id, 'task_id', NEW.task_id, 'project_id', proj,
                'adapter', NEW.adapter, 'model', NEW.model, 'machine_id', NEW.machine_id,
                'started_at', NEW.started_at, 'ended_at', NEW.ended_at, 'exit_reason', NEW.exit_reason,
                'input_tokens', NEW.input_tokens, 'output_tokens', NEW.output_tokens))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', NEW.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER tasks_record_event AFTER INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION app_record_task_event();
CREATE TRIGGER agent_runs_record_event AFTER INSERT OR UPDATE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION app_record_run_event();

-- +goose Down
DROP TRIGGER IF EXISTS agent_runs_record_event ON agent_runs;
DROP TRIGGER IF EXISTS tasks_record_event ON tasks;
DROP FUNCTION IF EXISTS app_record_run_event();
DROP FUNCTION IF EXISTS app_record_task_event();
DROP TABLE IF EXISTS org_events;
DROP INDEX IF EXISTS tasks_org_updated_idx;
DROP INDEX IF EXISTS tasks_client_task_uq;
ALTER TABLE tasks
    DROP COLUMN IF EXISTS updated_by,
    DROP COLUMN IF EXISTS client_updated_at,
    DROP COLUMN IF EXISTS finished_at,
    DROP COLUMN IF EXISTS started_at,
    DROP COLUMN IF EXISTS files_changed,
    DROP COLUMN IF EXISTS deletions,
    DROP COLUMN IF EXISTS additions,
    DROP COLUMN IF EXISTS model,
    DROP COLUMN IF EXISTS agent,
    DROP COLUMN IF EXISTS client_task_id;
DROP TABLE IF EXISTS api_tokens;
DROP FUNCTION IF EXISTS app_current_token_hash();
