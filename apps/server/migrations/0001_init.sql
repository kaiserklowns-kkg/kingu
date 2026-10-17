-- Kingu team server: initial schema.
--
-- The server only stores task METADATA for a team. Never add columns that hold
-- source code, diffs, prompts/transcripts, credentials or other secrets.
--
-- Tenancy: every org-scoped table carries org_id and has Row-Level Security
-- enabled AND forced (so the table owner is subject to it as well). Policies
-- compare org_id with the transaction-local setting app.org_id, which request
-- handlers set via `SELECT set_config('app.org_id', $1, true)`. When the
-- setting is absent or empty, app_current_org() is NULL and every policy
-- evaluates to false: the default is "see nothing", not "see everything".
--
-- NOTE: superusers and roles with BYPASSRLS ignore RLS entirely. The API
-- refuses to start when connected as such a role.

-- +goose Up

-- +goose StatementBegin
CREATE FUNCTION app_current_org() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;
-- +goose StatementEnd

CREATE TABLE orgs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
    org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- OIDC subject (issuer-scoped) once auth lands; opaque text for now.
    user_id    text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 255),
    role       text NOT NULL CHECK (role IN ('owner', 'lead', 'dev', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX members_user_id_idx ON members (user_id);

CREATE TABLE projects (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    repo_url         text NOT NULL CHECK (char_length(repo_url) BETWEEN 1 AND 2048),
    default_base_ref text NOT NULL DEFAULT 'main'
                     CHECK (char_length(default_base_ref) BETWEEN 1 AND 255),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name),
    -- Target for composite FKs so child rows can never point across orgs.
    UNIQUE (id, org_id)
);

CREATE TABLE tasks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL,
    project_id   uuid NOT NULL,
    title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
    source       text NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual', 'github', 'linear', 'jira')),
    external_ref text CHECK (external_ref IS NULL OR char_length(external_ref) BETWEEN 1 AND 500),
    status       text NOT NULL DEFAULT 'backlog'
                 CHECK (status IN ('backlog', 'running', 'needs_input', 'review', 'done', 'failed')),
    branch       text CHECK (branch IS NULL OR char_length(branch) BETWEEN 1 AND 255),
    created_by   text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 255),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK ((source = 'manual') = (external_ref IS NULL)),
    FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
    UNIQUE (id, org_id)
);
CREATE INDEX tasks_project_created_idx ON tasks (project_id, created_at DESC);
CREATE INDEX tasks_org_status_idx ON tasks (org_id, status);
CREATE UNIQUE INDEX tasks_external_ref_uq ON tasks (project_id, source, external_ref)
    WHERE external_ref IS NOT NULL;

CREATE TABLE agent_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL,
    task_id       uuid NOT NULL,
    adapter       text NOT NULL CHECK (char_length(adapter) BETWEEN 1 AND 100),
    model         text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
    machine_id    text CHECK (machine_id IS NULL OR char_length(machine_id) BETWEEN 1 AND 200),
    started_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    exit_reason   text CHECK (exit_reason IS NULL OR char_length(exit_reason) BETWEEN 1 AND 200),
    input_tokens  bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at >= started_at),
    FOREIGN KEY (task_id, org_id) REFERENCES tasks (id, org_id) ON DELETE CASCADE
);
CREATE INDEX agent_runs_task_started_idx ON agent_runs (task_id, started_at DESC);
CREATE INDEX agent_runs_org_started_idx ON agent_runs (org_id, started_at DESC);

CREATE TABLE audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    actor       text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 255),
    action      text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
    target_type text NOT NULL CHECK (char_length(target_type) BETWEEN 1 AND 50),
    target_id   uuid,
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);

-- Row-Level Security --------------------------------------------------------

ALTER TABLE orgs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs       FORCE ROW LEVEL SECURITY;
ALTER TABLE members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE members    FORCE ROW LEVEL SECURITY;
ALTER TABLE projects   ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects   FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks      FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log  FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON orgs
    USING (id = app_current_org()) WITH CHECK (id = app_current_org());
CREATE POLICY org_isolation ON members
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY org_isolation ON projects
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY org_isolation ON tasks
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY org_isolation ON agent_runs
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- audit_log is append-only: only SELECT and INSERT policies exist, so UPDATE
-- and DELETE match zero rows for every non-bypass role.
CREATE POLICY org_isolation_select ON audit_log FOR SELECT
    USING (org_id = app_current_org());
CREATE POLICY org_isolation_insert ON audit_log FOR INSERT
    WITH CHECK (org_id = app_current_org());

-- +goose Down
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS orgs;
DROP FUNCTION IF EXISTS app_current_org();
