-- Team Snap catalog: snaps an org's admins approved, pinned to a git commit
-- and the snap's manifest hash. Desktops list it, install the pinned commit
-- themselves and refuse a manifest whose SHA-256 differs.
--
-- METADATA ONLY: the server never holds snap code, only where to fetch it
-- (git_url + commit_sha) and what the desktop must find there
-- (manifest_sha256, the declared permissions shown to users).

-- +goose Up

CREATE TABLE team_snaps (
    -- Surrogate key so audit_log.target_id (uuid) can point at a row.
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- Same rule as the desktop's snap id (and folder name).
    snap_id         text NOT NULL CHECK (snap_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    version         text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
    git_url         text NOT NULL CHECK (char_length(git_url) BETWEEN 1 AND 2048),
    git_ref         text CHECK (git_ref IS NULL OR char_length(git_ref) BETWEEN 1 AND 255),
    commit_sha      text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    -- Declared permissions as the desktop parsed them: {network, fs, secrets}.
    permissions     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
    approved_by     text NOT NULL CHECK (char_length(approved_by) BETWEEN 1 AND 255),
    approved_at     timestamptz NOT NULL DEFAULT now(),
    required        boolean NOT NULL DEFAULT false,
    note            text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    UNIQUE (org_id, snap_id)
);

ALTER TABLE team_snaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_snaps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON team_snaps
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Catalog changes go through the same event feed so desktops refresh.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed'));

-- +goose StatementBegin
CREATE FUNCTION app_record_snap_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
    r     team_snaps;
BEGIN
    IF TG_OP = 'DELETE' THEN
        r := OLD;
    ELSE
        r := NEW;
    END IF;
    INSERT INTO org_events (org_id, kind, payload)
    VALUES (r.org_id,
            CASE WHEN TG_OP = 'DELETE' THEN 'snap.removed' ELSE 'snap.updated' END,
            jsonb_build_object(
                'snap_id', r.snap_id, 'name', r.name, 'version', r.version,
                'commit_sha', r.commit_sha, 'required', r.required,
                'approved_by', r.approved_by, 'approved_at', r.approved_at))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', r.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER team_snaps_record_event AFTER INSERT OR UPDATE OR DELETE ON team_snaps
    FOR EACH ROW EXECUTE FUNCTION app_record_snap_event();

-- +goose Down
DROP TRIGGER IF EXISTS team_snaps_record_event ON team_snaps;
DROP FUNCTION IF EXISTS app_record_snap_event();
-- NOT VALID: retained snap events (RLS hides them from a DELETE here) age out
-- through the 72h retention instead of blocking the rollback.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated')) NOT VALID;
DROP TABLE IF EXISTS team_snaps;
