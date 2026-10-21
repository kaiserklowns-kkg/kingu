-- Team Snap library: snap PACKAGES (one zip per version) that an org's owner
-- or lead explicitly published for teammates to install, so a team can share
-- a snap without a git host. Versions are immutable; a bad one is yanked, not
-- replaced, and stays downloadable for lock files that pin it.
--
-- PRIVACY: the server stores only the snap packages an owner/lead explicitly
-- publishes. It never receives code, prompts, file names or secrets of users'
-- projects. Secret VALUES never reach it: a snap's permissions only NAME the
-- secrets it asks for. Lists and the event feed carry metadata only, never the
-- package bytes.

-- +goose Up

CREATE TABLE team_snap_versions (
    -- Surrogate key so audit_log.target_id (uuid) can point at a row.
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- Same rule as team_snaps.snap_id (the desktop's snap::is_snap_id).
    snap_id        text NOT NULL CHECK (snap_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    version        text NOT NULL CHECK (version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'),
    name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
    -- The snap's trust hash as the desktop computed it.
    sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- The zip itself (at most 8 MiB, checked by the API before it gets here).
    package        bytea NOT NULL,
    package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
    package_size   integer NOT NULL CHECK (package_size BETWEEN 1 AND 8388608),
    -- Declared permissions as the desktop parsed them; secrets by name only.
    permissions    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
    published_by   text NOT NULL CHECK (char_length(published_by) BETWEEN 1 AND 255),
    published_at   timestamptz NOT NULL DEFAULT now(),
    yanked         boolean NOT NULL DEFAULT false,
    yanked_by      text CHECK (yanked_by IS NULL OR char_length(yanked_by) BETWEEN 1 AND 255),
    yanked_at      timestamptz,
    yank_reason    text CHECK (yank_reason IS NULL OR char_length(yank_reason) BETWEEN 1 AND 200),
    CHECK (octet_length(package) = package_size),
    UNIQUE (org_id, snap_id, version)
);
CREATE INDEX team_snap_versions_snap_idx ON team_snap_versions (org_id, snap_id, published_at DESC);

ALTER TABLE team_snap_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_snap_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON team_snap_versions
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Library changes go through the event feed so desktops refresh.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed',
                    'skill.shared', 'skill.removed', 'snap.published', 'snap.yanked'));

-- +goose StatementBegin
CREATE FUNCTION app_record_snap_version_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
BEGIN
    -- Versions are immutable; only a change of yanked is news.
    IF TG_OP = 'UPDATE' AND OLD.yanked IS NOT DISTINCT FROM NEW.yanked THEN
        RETURN NULL;
    END IF;
    -- Metadata only: never the package.
    INSERT INTO org_events (org_id, kind, payload)
    VALUES (NEW.org_id,
            CASE WHEN TG_OP = 'INSERT' THEN 'snap.published' ELSE 'snap.yanked' END,
            jsonb_build_object(
                'snap_id', NEW.snap_id, 'version', NEW.version, 'name', NEW.name,
                'sha256', NEW.sha256, 'yanked', NEW.yanked, 'published_by', NEW.published_by))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', NEW.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER team_snap_versions_record_event AFTER INSERT OR UPDATE ON team_snap_versions
    FOR EACH ROW EXECUTE FUNCTION app_record_snap_version_event();

-- +goose Down
DROP TRIGGER IF EXISTS team_snap_versions_record_event ON team_snap_versions;
DROP FUNCTION IF EXISTS app_record_snap_version_event();
-- NOT VALID: retained library events age out through the 72h retention.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed',
                    'skill.shared', 'skill.removed')) NOT VALID;
DROP TABLE IF EXISTS team_snap_versions;
