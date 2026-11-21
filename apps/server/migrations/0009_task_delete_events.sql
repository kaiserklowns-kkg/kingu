-- Deleting a task (directly, or with its project) records a task.deleted event
-- so open boards drop the card. The payload is ids and title only.

-- +goose Up

ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'task.deleted', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed',
                    'skill.shared', 'skill.removed', 'snap.published', 'snap.yanked'));

-- +goose StatementBegin
CREATE FUNCTION app_record_task_delete_event() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    ev_id bigint;
BEGIN
    INSERT INTO org_events (org_id, kind, project_id, task_id, payload)
    VALUES (OLD.org_id, 'task.deleted', OLD.project_id, OLD.id,
            jsonb_build_object('id', OLD.id, 'project_id', OLD.project_id, 'title', OLD.title))
    RETURNING id INTO ev_id;
    PERFORM pg_notify('kingu_events', OLD.org_id::text || ':' || ev_id::text);
    RETURN NULL;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER tasks_record_delete_event AFTER DELETE ON tasks
    FOR EACH ROW EXECUTE FUNCTION app_record_task_delete_event();

-- +goose Down
DROP TRIGGER IF EXISTS tasks_record_delete_event ON tasks;
DROP FUNCTION IF EXISTS app_record_task_delete_event();
-- NOT VALID: retained task.deleted events age out through the 72h retention.
ALTER TABLE org_events DROP CONSTRAINT org_events_kind_check;
ALTER TABLE org_events ADD CONSTRAINT org_events_kind_check
    CHECK (kind IN ('task.created', 'task.updated', 'run.created', 'run.updated',
                    'snap.updated', 'snap.removed', 'artifact.shared', 'artifact.removed',
                    'skill.shared', 'skill.removed', 'snap.published', 'snap.yanked')) NOT VALID;
