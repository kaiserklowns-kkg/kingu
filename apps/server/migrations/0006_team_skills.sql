-- Team skills: agent skills members shared with their org, pinned to a git
-- commit and the skill's content hash. Desktops list them, fetch the pinned
-- commit themselves and refuse a skill whose content hash differs.
--
-- METADATA ONLY: the server never holds skill files, only where to fetch them
-- (git_url + path + commit_sha), what the desktop must find there
-- (content_sha256) and the skill's name and description to list it.

-- +goose Up

CREATE TABLE team_skills (
    -- Surrogate key so audit_log.target_id (uuid) can point at a row.
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- Claude Code's skill name rule (the desktop's skill_hub::package::is_skill_name).
    skill_name     text NOT NULL CHECK (skill_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(skill_name) <= 64),
    description    text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1024),
    git_url        text NOT NULL CHECK (char_length(git_url) BETWEEN 1 AND 2048),
    git_ref        text CHECK (git_ref IS NULL OR char_length(git_ref) BETWEEN 1 AND 255),
    -- The skill's folder in the repository ('' for its root).
    path           text NOT NULL DEFAULT '' CHECK (char_length(path) <= 512),
    commit_sha     text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    shared_by      text NOT NULL CHECK (char_length(shared_by) BETWEEN 1 AND 255),
    shared_at      timestamptz NOT NULL DEFAULT now(),
    note           text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    UNIQUE (org_id, skill_name)
);

ALTER TABLE team_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON team_skills
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- +goose Down
DROP TABLE IF EXISTS team_skills;
