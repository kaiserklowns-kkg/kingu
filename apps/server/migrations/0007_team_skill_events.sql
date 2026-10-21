-- Team skill changes go through the event feed (GET /v1/events) like snaps
-- and artifacts, so a desktop's Settings › Skills refreshes when a teammate
-- shares or stops sharing a skill. Metadata only, as in team_skills itself.

-- +goose Up

ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed',
                    'skill.shared', 'skill.removed'));

-- +goose StatementBegin
CREATE FUNCTION app_record_skill_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
    r     team_skills;
BEGIN
    IF TG_OP = 'DELETE' THEN
        r := OLD;
    ELSE
        r := NEW;
    END IF;
    INSERT INTO org_events (org_id, kind, payload)
    VALUES (r.org_id,
            CASE WHEN TG_OP = 'DELETE' THEN 'skill.removed' ELSE 'skill.shared' END,
            jsonb_build_object(
                'skill_name', r.skill_name, 'commit_sha', r.commit_sha,
                'content_sha256', r.content_sha256, 'shared_by', r.shared_by,
                'shared_at', r.shared_at))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', r.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER team_skills_record_event AFTER INSERT OR UPDATE OR DELETE ON team_skills
    FOR EACH ROW EXECUTE FUNCTION app_record_skill_event();

-- +goose Down
DROP TRIGGER IF EXISTS team_skills_record_event ON team_skills;
DROP FUNCTION IF EXISTS app_record_skill_event();
-- NOT VALID: retained skill events age out through the 72h retention.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed')) NOT VALID;
