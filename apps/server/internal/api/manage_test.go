package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
)

func TestProjectManagement(t *testing.T) {
	requireDB(t)
	owner, lead, dev, _, _ := adminOrg(t, "projects-org")
	otherOwner, _ := devToken(t, map[string]any{"org_name": "projects-other", "user_id": "mallory"})
	r := authed(t, lead, "POST", "/v1/projects", map[string]any{"name": "app", "repo_url": "https://github.com/acme/app.git"})
	expect(t, r, http.StatusCreated, "")
	proj := r.Body["id"].(string)
	if r.Body["task_count"] != float64(0) {
		t.Fatalf("new project = %v", r.Body)
	}
	expect(t, authed(t, dev, "POST", "/v1/projects/"+proj+"/tasks", map[string]any{"title": "One"}), http.StatusCreated, "")
	expect(t, authed(t, dev, "POST", "/v1/projects/"+proj+"/tasks", map[string]any{"title": "Two"}), http.StatusCreated, "")

	r = authed(t, dev, "GET", "/v1/projects/"+proj, nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["task_count"] != float64(2) || r.Body["name"] != "app" {
		t.Fatalf("project = %v", r.Body)
	}
	expect(t, authed(t, otherOwner, "GET", "/v1/projects/"+proj, nil), http.StatusNotFound, "not_found")

	// Edit: owners and leads; validated like create.
	expect(t, authed(t, dev, "PATCH", "/v1/projects/"+proj, map[string]any{"name": "x"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, lead, "PATCH", "/v1/projects/"+proj, map[string]any{}), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, lead, "PATCH", "/v1/projects/"+proj, map[string]any{"repo_url": "https://user:pw@github.com/a/b.git"}), http.StatusBadRequest, "")
	r = authed(t, lead, "PATCH", "/v1/projects/"+proj, map[string]any{"name": "shop", "default_base_ref": "develop"})
	expect(t, r, http.StatusOK, "")
	if r.Body["name"] != "shop" || r.Body["default_base_ref"] != "develop" || r.Body["repo_url"] != "https://github.com/acme/app.git" {
		t.Fatalf("patched = %v", r.Body)
	}
	expect(t, authed(t, otherOwner, "PATCH", "/v1/projects/"+proj, map[string]any{"name": "pwn"}), http.StatusNotFound, "not_found")

	// Delete: owners only, takes tasks along.
	expect(t, authed(t, lead, "DELETE", "/v1/projects/"+proj, nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, otherOwner, "DELETE", "/v1/projects/"+proj, nil), http.StatusNotFound, "not_found")
	r = authed(t, owner, "DELETE", "/v1/projects/"+proj, nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["tasks"] != float64(2) {
		t.Fatalf("deleted = %v", r.Body)
	}
	expect(t, authed(t, owner, "GET", "/v1/projects/"+proj, nil), http.StatusNotFound, "not_found")
	if n := len(items(t, authed(t, owner, "GET", "/v1/tasks", nil))); n != 0 {
		t.Fatalf("%d tasks left", n)
	}
	a := items(t, authed(t, owner, "GET", "/v1/audit?action=project.", nil))
	if len(a) != 3 || a[0]["action"] != "project.delete" || a[1]["action"] != "project.update" {
		t.Fatalf("project audit = %v", a)
	}
}

func TestTaskDetailEditDelete(t *testing.T) {
	requireDB(t)
	base := newServer(t, api.Config{Heartbeat: time.Hour})
	owner, lead, dev, viewer, _ := adminOrg(t, "taskedit-org")
	proj := authed(t, owner, "POST", "/v1/projects", map[string]any{"name": "app", "repo_url": "https://github.com/acme/app.git"}).Body["id"].(string)
	r := authed(t, dev, "POST", "/v1/projects/"+proj+"/tasks", map[string]any{"title": "Fix login"})
	expect(t, r, http.StatusCreated, "")
	task := r.Body["id"].(string)

	r = authed(t, viewer, "GET", "/v1/tasks/"+task, nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["title"] != "Fix login" || r.Body["project_name"] != "app" {
		t.Fatalf("task = %v", r.Body)
	}
	expect(t, authed(t, viewer, "GET", "/v1/tasks/00000000-0000-4000-8000-000000000000", nil), http.StatusNotFound, "not_found")

	expect(t, authed(t, viewer, "PATCH", "/v1/tasks/"+task, map[string]any{"title": "x"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev, "PATCH", "/v1/tasks/"+task, map[string]any{"title": " "}), http.StatusBadRequest, "invalid_input")
	r = authed(t, dev, "PATCH", "/v1/tasks/"+task, map[string]any{"title": "Fix login page", "status": "review"})
	expect(t, r, http.StatusOK, "")
	if r.Body["title"] != "Fix login page" || r.Body["status"] != "review" || r.Body["updated_by"] != "dana" {
		t.Fatalf("patched = %v", r.Body)
	}

	ch, stop := openStream(t, base, owner, nil)
	defer stop()
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "connected" })

	expect(t, authed(t, dev, "DELETE", "/v1/tasks/"+task, nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, lead, "DELETE", "/v1/tasks/"+task, nil), http.StatusOK, "")
	expect(t, authed(t, lead, "DELETE", "/v1/tasks/"+task, nil), http.StatusNotFound, "not_found")
	m := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if m.Event != "task.deleted" {
		t.Fatalf("event = %+v", m)
	}
	ev := eventData(t, m)
	if ev["task_id"] != task || ev["data"].(map[string]any)["title"] != "Fix login page" {
		t.Fatalf("task.deleted = %v", ev)
	}
	if n := len(items(t, authed(t, owner, "GET", "/v1/audit?action=task.delete", nil))); n != 1 {
		t.Fatalf("task.delete audit = %d", n)
	}
}
