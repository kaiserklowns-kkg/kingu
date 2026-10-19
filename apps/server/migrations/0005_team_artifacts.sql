-- Team artifacts: pages an agent made (one self-contained HTML file, assets
-- inlined) that a member explicitly shared with the org, so teammates can
-- open them read-only.
--
-- THE ONE EXCEPTION to "metadata only": the html column holds the page the
-- user chose to share. It is capped at 2 MiB, and the API rejects a page that
-- looks like it carries a credential. Events and lists carry metadata only.

-- +goose Up

CREATE TABLE team_artifacts (
    -- Surrogate key so audit_log.target_id (uuid) can point at a row.
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- The desktop's artifact id (16 lowercase hex characters).
    artifact_id text NOT NULL CHECK (artifact_id ~ '^[0-9a-f]{16}$'),
    title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
    format      text NOT NULL CHECK (format IN ('html', 'markdown')),
    version     integer NOT NULL CHECK (version >= 1),
    html        text NOT NULL CHECK (octet_length(html) BETWEEN 1 AND 2097152),
    sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
    shared_by   text NOT NULL CHECK (char_length(shared_by) BETWEEN 1 AND 255),
    shared_at   timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, artifact_id)
);

CREATE INDEX team_artifacts_org_updated ON team_artifacts (org_id, updated_at DESC);

ALTER TABLE team_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON team_artifacts
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed'));

-- +goose StatementBegin
CREATE FUNCTION app_record_artifact_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
    r     team_artifacts;
BEGIN
    IF TG_OP = 'DELETE' THEN
        r := OLD;
    ELSE
        r := NEW;
    END IF;
    -- Metadata only: never the page itself.
    INSERT INTO org_events (org_id, kind, payload)
    VALUES (r.org_id,
            CASE WHEN TG_OP = 'DELETE' THEN 'artifact.removed' ELSE 'artifact.shared' END,
            jsonb_build_object(
                'artifact_id', r.artifact_id, 'title', r.title, 'format', r.format,
                'version', r.version, 'shared_by', r.shared_by, 'updated_at', r.updated_at))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', r.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER team_artifacts_record_event AFTER INSERT OR UPDATE OR DELETE ON team_artifacts
    FOR EACH ROW EXECUTE FUNCTION app_record_artifact_event();

-- +goose Down
DROP TRIGGER IF EXISTS team_artifacts_record_event ON team_artifacts;
DROP FUNCTION IF EXISTS app_record_artifact_event();
-- NOT VALID: retained artifact events age out through the 72h retention.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed')) NOT VALID;
DROP TABLE IF EXISTS team_artifacts;
