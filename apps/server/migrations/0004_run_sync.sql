-- Desktop run sync and run cost: agent runs reported by the desktop
-- (PUT /v1/tasks/{client_task_id}/runs/{client_run_id}/sync), keyed and
-- deduplicated like task sync, with the run's cost in USD and who ran it.
-- Synced tasks may also carry their issue (source/external_ref).
--
-- Still METADATA ONLY: timings, token counts and cost; never prompts,
-- transcripts, code or secrets.

-- +goose Up

ALTER TABLE agent_runs
    -- Desktop-generated id; (task_id, client_run_id) is the sync key.
    ADD COLUMN client_run_id     text CHECK (client_run_id IS NULL OR client_run_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    -- Cost the agent reported for the run (USD). NULL when unknown.
    ADD COLUMN cost_usd          numeric(14, 6) CHECK (cost_usd IS NULL OR (cost_usd >= 0 AND cost_usd <= 1000000)),
    -- Member who started (or reported) the run. NULL for rows created before this column.
    ADD COLUMN created_by        text CHECK (created_by IS NULL OR char_length(created_by) BETWEEN 1 AND 255),
    -- Client clock of the latest accepted sync; older updates are ignored.
    ADD COLUMN client_updated_at timestamptz;

CREATE UNIQUE INDEX agent_runs_client_run_uq ON agent_runs (task_id, client_run_id)
    WHERE client_run_id IS NOT NULL;

-- Several desktop tasks may work on the same issue; import dedupe only applies
-- to tasks created on the server (POST /v1/projects/{id}/tasks).
DROP INDEX tasks_external_ref_uq;
CREATE UNIQUE INDEX tasks_external_ref_uq ON tasks (project_id, source, external_ref)
    WHERE external_ref IS NOT NULL AND client_task_id IS NULL;

-- Event payloads gain external_ref (tasks) and cost_usd/created_by (runs).

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app_record_task_event() RETURNS trigger
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
                'title', NEW.title, 'source', NEW.source, 'external_ref', NEW.external_ref,
                'status', NEW.status, 'branch', NEW.branch,
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
CREATE OR REPLACE FUNCTION app_record_run_event() RETURNS trigger
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
                'client_run_id', NEW.client_run_id,
                'adapter', NEW.adapter, 'model', NEW.model, 'machine_id', NEW.machine_id,
                'started_at', NEW.started_at, 'ended_at', NEW.ended_at, 'exit_reason', NEW.exit_reason,
                'input_tokens', NEW.input_tokens, 'output_tokens', NEW.output_tokens,
                'cost_usd', NEW.cost_usd, 'created_by', NEW.created_by))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', NEW.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose Down

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app_record_run_event() RETURNS trigger
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app_record_task_event() RETURNS trigger
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

DROP INDEX tasks_external_ref_uq;
CREATE UNIQUE INDEX tasks_external_ref_uq ON tasks (project_id, source, external_ref)
    WHERE external_ref IS NOT NULL;
DROP INDEX IF EXISTS agent_runs_client_run_uq;
ALTER TABLE agent_runs
    DROP COLUMN IF EXISTS client_updated_at,
    DROP COLUMN IF EXISTS created_by,
    DROP COLUMN IF EXISTS cost_usd,
    DROP COLUMN IF EXISTS client_run_id;
