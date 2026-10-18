package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func runBody(project string, updated time.Time, over map[string]any) map[string]any {
	b := map[string]any{
		"project_id": project, "adapter": "claude-code", "model": "opus",
		"exit_reason": "done",
		"started_at":  "2026-10-17T09:00:00Z", "ended_at": "2026-10-17T09:05:00Z",
		"input_tokens": 1500, "output_tokens": 300, "cost_usd": 0.4213,
		"updated_at": updated.UTC().Format(time.RFC3339Nano),
	}
	for k, v := range over {
		if v == nil {
			delete(b, k)
		} else {
			b[k] = v
		}
	}
	return b
}

func TestSyncTaskSource(t *testing.T) {
	requireDB(t)
	tok, _ := devToken(t, map[string]any{"org_name": "source-org", "user_id": "dana"})
	proj := authed(t, tok, "POST", "/v1/projects", map[string]any{"name": "src", "repo_url": "https://e.com/src"}).Body["id"].(string)
	now := time.Now()

	withRef := func(title, source, ref string, at time.Time) map[string]any {
		b := syncBody(proj, title, "running", at)
		b["source"], b["external_ref"] = source, ref
		return b
	}
	r := authed(t, tok, "PUT", "/v1/tasks/gh-1/sync", withRef("Fix login", "github", "acme/app#42", now))
	expect(t, r, http.StatusCreated, "")
	task := r.Body["task"].(map[string]any)
	if task["source"] != "github" || task["external_ref"] != "acme/app#42" {
		t.Fatalf("task = %v", task)
	}
	// A second desktop task on the same issue is fine (import dedupe is for server-created tasks only).
	expect(t, authed(t, tok, "PUT", "/v1/tasks/gh-2/sync", withRef("Fix login again", "github", "acme/app#42", now)), http.StatusCreated, "")
	expect(t, authed(t, tok, "PUT", "/v1/tasks/ln-1/sync", withRef("Linear", "linear", "ENG-7", now)), http.StatusCreated, "")
	// Unlinking goes back to manual.
	r = authed(t, tok, "PUT", "/v1/tasks/gh-2/sync", syncBody(proj, "Fix login again", "running", now.Add(time.Second)))
	expect(t, r, http.StatusOK, "")
	if task := r.Body["task"].(map[string]any); task["source"] != "manual" || task["external_ref"] != nil {
		t.Fatalf("unlinked task = %v", task)
	}

	bad := []struct {
		name string
		body map[string]any
	}{
		{"unknown source", withRef("x", "gitlab", "1", now)},
		{"github without ref", func() map[string]any { b := syncBody(proj, "x", "running", now); b["source"] = "github"; return b }()},
		{"manual with ref", withRef("x", "manual", "#1", now)},
		{"blank ref", withRef("x", "github", "  ", now)},
		{"long ref", withRef("x", "github", strings.Repeat("a", 501), now)},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, authed(t, tok, "PUT", "/v1/tasks/bad/sync", tc.body), http.StatusBadRequest, "invalid_input")
		})
	}
	expect(t, authed(t, tok, "PUT", "/v1/tasks/bad/sync", withRef("x", "github", "ghp_"+strings.Repeat("a", 36), now)),
		http.StatusUnprocessableEntity, "content_not_allowed")
}

func TestSyncRunUpsertAndCost(t *testing.T) {
	requireDB(t)
	tok, org := devToken(t, map[string]any{"org_name": "run-org", "user_id": "erin"})
	proj := authed(t, tok, "POST", "/v1/projects", map[string]any{"name": "runs", "repo_url": "https://e.com/runs"}).Body["id"].(string)
	now := time.Now()
	path := "/v1/tasks/task-9/runs/1760691600000/sync"

	// The task must be synced first; the desktop retries this code.
	expect(t, authed(t, tok, "PUT", path, runBody(proj, now, nil)), http.StatusConflict, "task_not_synced")
	expect(t, authed(t, tok, "PUT", "/v1/tasks/task-9/sync", syncBody(proj, "Runs", "running", now)), http.StatusCreated, "")

	r := authed(t, tok, "PUT", path, runBody(proj, now, map[string]any{"exit_reason": "idle", "ended_at": nil}))
	expect(t, r, http.StatusCreated, "")
	run := r.Body["run"].(map[string]any)
	if run["cost_usd"] != 0.4213 || run["created_by"] != "erin" || run["client_run_id"] != "1760691600000" || run["ended_at"] != nil {
		t.Fatalf("run = %v", run)
	}
	// Retry of the same state: nothing changes.
	r = authed(t, tok, "PUT", path, runBody(proj, now, map[string]any{"exit_reason": "idle", "ended_at": nil}))
	expect(t, r, http.StatusOK, "")
	if r.Body["applied"] != false {
		t.Fatalf("identical retry applied: %v", r.Body)
	}
	// Later state with cumulative usage updates the same row.
	r = authed(t, tok, "PUT", path, runBody(proj, now.Add(time.Minute), map[string]any{"cost_usd": 1.25, "input_tokens": 9000}))
	expect(t, r, http.StatusOK, "")
	if run := r.Body["run"].(map[string]any); run["cost_usd"] != 1.25 || run["exit_reason"] != "done" || r.Body["applied"] != true {
		t.Fatalf("updated run = %v", r.Body)
	}
	// An older state arriving late is ignored.
	r = authed(t, tok, "PUT", path, runBody(proj, now.Add(30*time.Second), map[string]any{"cost_usd": 0.5}))
	expect(t, r, http.StatusOK, "")
	if run := r.Body["run"].(map[string]any); run["cost_usd"] != 1.25 {
		t.Fatalf("stale state applied: %v", run)
	}
	// Cost is optional (unknown stays null) on another run.
	r = authed(t, tok, "PUT", "/v1/tasks/task-9/runs/second/sync", runBody(proj, now, map[string]any{"cost_usd": nil}))
	expect(t, r, http.StatusCreated, "")
	if r.Body["run"].(map[string]any)["cost_usd"] != nil {
		t.Fatalf("cost should be null: %v", r.Body)
	}

	// Listing carries cost, person, project and issue for the dashboard.
	r = authed(t, tok, "GET", "/v1/runs", nil)
	expect(t, r, http.StatusOK, "")
	list := items(t, r)
	if len(list) != 2 {
		t.Fatalf("runs = %v", list)
	}
	var total float64
	for _, it := range list {
		if it["project_name"] != "runs" || it["created_by"] != "erin" || it["task_title"] != "Runs" || it["source"] != "manual" {
			t.Fatalf("run item = %v", it)
		}
		if c, ok := it["cost_usd"].(float64); ok {
			total += c
		}
	}
	if total != 1.25 {
		t.Fatalf("total cost = %v", total)
	}

	// One row per (task, client run id); an audit row per applied change (create + update).
	ctx := context.Background()
	var rows, audits int
	_ = adminPool.QueryRow(ctx, `SELECT count(*) FROM agent_runs WHERE org_id = $1`, org).Scan(&rows)
	_ = adminPool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE org_id = $1 AND action = 'run.sync'`, org).Scan(&audits)
	if rows != 2 || audits != 3 {
		t.Fatalf("rows = %d audits = %d", rows, audits)
	}
}

func TestSyncRunValidation(t *testing.T) {
	requireDB(t)
	tok, _ := devToken(t, map[string]any{"org_name": "run-val", "user_id": "finn"})
	proj := authed(t, tok, "POST", "/v1/projects", map[string]any{"name": "rv", "repo_url": "https://e.com/rv"}).Body["id"].(string)
	now := time.Now()
	expect(t, authed(t, tok, "PUT", "/v1/tasks/t/sync", syncBody(proj, "T", "running", now)), http.StatusCreated, "")
	path := "/v1/tasks/t/runs/r1/sync"
	cases := []struct {
		name   string
		path   string
		over   map[string]any
		status int
		code   string
	}{
		{"negative cost", path, map[string]any{"cost_usd": -0.01}, 400, "invalid_input"},
		{"huge cost", path, map[string]any{"cost_usd": 2e6}, 400, "invalid_input"},
		{"negative tokens", path, map[string]any{"output_tokens": -1}, 400, "invalid_input"},
		{"missing started_at", path, map[string]any{"started_at": nil}, 400, "invalid_input"},
		{"missing updated_at", path, map[string]any{"updated_at": nil}, 400, "invalid_input"},
		{"ended before start", path, map[string]any{"ended_at": "2026-10-17T08:00:00Z"}, 400, "invalid_input"},
		{"future clock", path, map[string]any{"updated_at": now.Add(48 * time.Hour).Format(time.RFC3339)}, 400, "invalid_input"},
		{"missing adapter", path, map[string]any{"adapter": nil}, 400, "invalid_input"},
		{"unknown field", path, map[string]any{"transcript": "hello"}, 400, "unknown_field"},
		{"secret", path, map[string]any{"model": "sk-" + strings.Repeat("a", 30)}, 422, "content_not_allowed"},
		{"diff", path, map[string]any{"exit_reason": "diff --git a/x b/x"}, 422, "content_not_allowed"},
		{"bad run id", "/v1/tasks/t/runs/has%20space/sync", nil, 400, "invalid_input"},
		{"missing project", path, map[string]any{"project_id": "11111111-1111-1111-1111-111111111111"}, 404, "not_found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, authed(t, tok, "PUT", tc.path, runBody(proj, now, tc.over)), tc.status, tc.code)
		})
	}

	// Other orgs cannot report runs on this org's tasks: the project looks missing.
	other, _ := devToken(t, map[string]any{"org_name": "run-other", "user_id": "gus"})
	expect(t, authed(t, other, "PUT", path, runBody(proj, now, nil)), http.StatusNotFound, "not_found")
	// Viewers cannot write.
	viewer, _ := devToken(t, map[string]any{"org_name": "run-viewer", "user_id": "hal", "role": "viewer"})
	expect(t, authed(t, viewer, "PUT", path, runBody(proj, now, nil)), http.StatusForbidden, "")
}

func TestCreateRunCost(t *testing.T) {
	requireDB(t)
	org := newOrg(t, "cost-org")
	projectID := createProject(t, org, "cost")
	r := do(t, "POST", "/v1/projects/"+projectID+"/tasks", org, map[string]any{"title": "c"})
	expect(t, r, http.StatusCreated, "")
	taskID := r.Body["id"].(string)
	r = do(t, "POST", "/v1/tasks/"+taskID+"/runs", org, map[string]any{"adapter": "codex", "cost_usd": 0.75})
	expect(t, r, http.StatusCreated, "")
	if r.Body["cost_usd"] != 0.75 || r.Body["created_by"] != "dev" {
		t.Fatalf("run = %v", r.Body)
	}
	expect(t, do(t, "POST", "/v1/tasks/"+taskID+"/runs", org, map[string]any{"adapter": "codex", "cost_usd": -1}), 400, "invalid_input")
}
