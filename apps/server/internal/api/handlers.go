package api

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- resources -------------------------------------------------------------

type project struct {
	ID             string    `json:"id"`
	OrgID          string    `json:"org_id"`
	Name           string    `json:"name"`
	RepoURL        string    `json:"repo_url"`
	DefaultBaseRef string    `json:"default_base_ref"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

const projectCols = `id::text, org_id::text, name, repo_url, default_base_ref, created_at, updated_at`

func scanProject(row pgx.Row) (project, error) {
	var p project
	err := row.Scan(&p.ID, &p.OrgID, &p.Name, &p.RepoURL, &p.DefaultBaseRef, &p.CreatedAt, &p.UpdatedAt)
	return p, err
}

type task struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	Title       string    `json:"title"`
	Source      string    `json:"source"`
	ExternalRef *string   `json:"external_ref"`
	Status      string    `json:"status"`
	Branch      *string   `json:"branch"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`

	// Desktop sync metadata (PUT /v1/tasks/{id}/sync).
	ClientTaskID *string    `json:"client_task_id"`
	Agent        *string    `json:"agent"`
	Model        *string    `json:"model"`
	Additions    int        `json:"additions"`
	Deletions    int        `json:"deletions"`
	FilesChanged int        `json:"files_changed"`
	StartedAt    *time.Time `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at"`
	UpdatedBy    *string    `json:"updated_by"`
}

const taskCols = `id::text, project_id::text, title, source, external_ref, status, branch, created_by, created_at, updated_at,
	client_task_id, agent, model, additions, deletions, files_changed, started_at, finished_at, updated_by`

func (t *task) scanDest() []any {
	return []any{&t.ID, &t.ProjectID, &t.Title, &t.Source, &t.ExternalRef, &t.Status,
		&t.Branch, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt,
		&t.ClientTaskID, &t.Agent, &t.Model, &t.Additions, &t.Deletions, &t.FilesChanged,
		&t.StartedAt, &t.FinishedAt, &t.UpdatedBy}
}

func scanTask(row pgx.Row) (task, error) {
	var t task
	err := row.Scan(t.scanDest()...)
	return t, err
}

type agentRun struct {
	ID           string     `json:"id"`
	TaskID       string     `json:"task_id"`
	Adapter      string     `json:"adapter"`
	Model        *string    `json:"model"`
	MachineID    *string    `json:"machine_id"`
	StartedAt    time.Time  `json:"started_at"`
	EndedAt      *time.Time `json:"ended_at"`
	ExitReason   *string    `json:"exit_reason"`
	InputTokens  int64      `json:"input_tokens"`
	OutputTokens int64      `json:"output_tokens"`
}

type listResponse[T any] struct {
	Items []T `json:"items"`
}

func parseLimit(r *http.Request) (int, error) {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return 100, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > 500 {
		return 0, errBadRequest("invalid_input", "limit must be an integer between 1 and 500")
	}
	return n, nil
}

func pathUUID(r *http.Request, name string) (string, error) {
	id, ok := parseUUID(r.PathValue(name))
	if !ok {
		return "", errBadRequest("invalid_input", name+" must be a uuid")
	}
	return id, nil
}

// ---- projects --------------------------------------------------------------

type createProjectReq struct {
	Name           string `json:"name"`
	RepoURL        string `json:"repo_url"`
	DefaultBaseRef string `json:"default_base_ref"`
}

func (s *Server) createProject(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	var req createProjectReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := checkText("name", req.Name, maxProjectNameLen, true); err != nil {
		return 0, nil, err
	}
	if err := checkRepoURL(req.RepoURL); err != nil {
		return 0, nil, err
	}
	if req.DefaultBaseRef == "" {
		req.DefaultBaseRef = "main"
	}
	if err := checkRef("default_base_ref", req.DefaultBaseRef); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	p, err := scanProject(tx.QueryRow(ctx,
		`INSERT INTO projects (org_id, name, repo_url, default_base_ref)
		 VALUES (app_current_org(), $1, $2, $3)
		 RETURNING `+projectCols,
		req.Name, req.RepoURL, req.DefaultBaseRef))
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "project.create", "project", p.ID, map[string]any{"name": p.Name}); err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, p, nil
}

func (s *Server) listProjects(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	limit, err := parseLimit(r)
	if err != nil {
		return 0, nil, err
	}
	rows, err := tx.Query(r.Context(),
		`SELECT `+projectCols+` FROM projects ORDER BY created_at DESC, id LIMIT $1`, limit)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (project, error) { return scanProject(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[project]{Items: items}, nil
}

// ---- tasks -----------------------------------------------------------------

type createTaskReq struct {
	Title       string  `json:"title"`
	Source      string  `json:"source"`
	ExternalRef *string `json:"external_ref"`
	Status      string  `json:"status"`
	Branch      *string `json:"branch"`
}

// projectVisible reports whether the project exists within the current org
// (RLS hides other orgs' projects, so they look exactly like missing ones).
func projectVisible(r *http.Request, tx pgx.Tx, id string) error {
	var exists bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM projects WHERE id = $1)`, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound("project not found")
	}
	return nil
}

func (s *Server) createTask(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	projectID, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	var req createTaskReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := checkText("title", req.Title, maxTitleLen, true); err != nil {
		return 0, nil, err
	}
	if req.Source == "" {
		req.Source = "manual"
	}
	if !taskSources[req.Source] {
		return 0, nil, errBadRequest("invalid_input", "source must be one of manual, github, linear, jira")
	}
	if req.Source == "manual" {
		if req.ExternalRef != nil {
			return 0, nil, errBadRequest("invalid_input", "external_ref is not allowed for source manual")
		}
	} else {
		if req.ExternalRef == nil {
			return 0, nil, errBadRequest("invalid_input", "external_ref is required for source "+req.Source)
		}
		if err := checkText("external_ref", *req.ExternalRef, maxExternalRefLen, true); err != nil {
			return 0, nil, err
		}
	}
	if req.Status == "" {
		req.Status = "backlog"
	}
	if !taskStatuses[req.Status] {
		return 0, nil, errBadRequest("invalid_status", "status must be one of backlog, running, needs_input, review, done, failed")
	}
	if req.Branch != nil {
		if err := checkRef("branch", *req.Branch); err != nil {
			return 0, nil, err
		}
	}
	if err := projectVisible(r, tx, projectID); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	t, err := scanTask(tx.QueryRow(ctx,
		`INSERT INTO tasks (org_id, project_id, title, source, external_ref, status, branch, created_by)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+taskCols,
		projectID, req.Title, req.Source, req.ExternalRef, req.Status, req.Branch, oc.Actor))
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "task.create", "task", t.ID, map[string]any{"project_id": projectID, "status": t.Status}); err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, t, nil
}

func (s *Server) listTasks(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	projectID, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	limit, err := parseLimit(r)
	if err != nil {
		return 0, nil, err
	}
	var status string
	if status = r.URL.Query().Get("status"); status != "" && !taskStatuses[status] {
		return 0, nil, errBadRequest("invalid_status", "status must be one of backlog, running, needs_input, review, done, failed")
	}
	if err := projectVisible(r, tx, projectID); err != nil {
		return 0, nil, err
	}
	rows, err := tx.Query(r.Context(),
		`SELECT `+taskCols+` FROM tasks
		 WHERE project_id = $1 AND ($2 = '' OR status = $2)
		 ORDER BY created_at DESC, id LIMIT $3`, projectID, status, limit)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (task, error) { return scanTask(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[task]{Items: items}, nil
}

type patchTaskReq struct {
	Status *string `json:"status"`
	Branch *string `json:"branch"`
}

func (s *Server) patchTask(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	taskID, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	var req patchTaskReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if req.Status == nil && req.Branch == nil {
		return 0, nil, errBadRequest("invalid_input", "at least one of status, branch is required")
	}
	if req.Status != nil && !taskStatuses[*req.Status] {
		return 0, nil, errBadRequest("invalid_status", "status must be one of backlog, running, needs_input, review, done, failed")
	}
	if req.Branch != nil {
		if err := checkRef("branch", *req.Branch); err != nil {
			return 0, nil, err
		}
	}
	ctx := r.Context()
	t, err := scanTask(tx.QueryRow(ctx,
		`UPDATE tasks SET
		     status = COALESCE($2, status),
		     branch = COALESCE($3, branch),
		     updated_by = $4,
		     updated_at = now()
		 WHERE id = $1
		 RETURNING `+taskCols,
		taskID, req.Status, req.Branch, oc.Actor))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("task not found")
	}
	if err != nil {
		return 0, nil, err
	}
	details := map[string]any{}
	if req.Status != nil {
		details["status"] = *req.Status
	}
	if req.Branch != nil {
		details["branch"] = *req.Branch
	}
	if err := audit(ctx, tx, oc, "task.update", "task", t.ID, details); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, t, nil
}

// ---- agent runs ------------------------------------------------------------

type createRunReq struct {
	Adapter      string     `json:"adapter"`
	Model        *string    `json:"model"`
	MachineID    *string    `json:"machine_id"`
	StartedAt    *time.Time `json:"started_at"`
	EndedAt      *time.Time `json:"ended_at"`
	ExitReason   *string    `json:"exit_reason"`
	InputTokens  int64      `json:"input_tokens"`
	OutputTokens int64      `json:"output_tokens"`
}

func (s *Server) createRun(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	taskID, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	var req createRunReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := checkText("adapter", req.Adapter, 100, true); err != nil {
		return 0, nil, err
	}
	for field, v := range map[string]*string{"model": req.Model, "machine_id": req.MachineID, "exit_reason": req.ExitReason} {
		if v != nil {
			if err := checkText(field, *v, maxShortTextLen, true); err != nil {
				return 0, nil, err
			}
		}
	}
	if req.InputTokens < 0 || req.OutputTokens < 0 {
		return 0, nil, errBadRequest("invalid_input", "token counts must be >= 0")
	}
	started := time.Now().UTC()
	if req.StartedAt != nil {
		started = *req.StartedAt
	}
	if req.EndedAt != nil && req.EndedAt.Before(started) {
		return 0, nil, errBadRequest("invalid_input", "ended_at must not be before started_at")
	}
	ctx := r.Context()
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tasks WHERE id = $1)`, taskID).Scan(&exists); err != nil {
		return 0, nil, err
	}
	if !exists {
		return 0, nil, errNotFound("task not found")
	}
	var run agentRun
	err = tx.QueryRow(ctx,
		`INSERT INTO agent_runs (org_id, task_id, adapter, model, machine_id, started_at, ended_at,
		                         exit_reason, input_tokens, output_tokens)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id::text, task_id::text, adapter, model, machine_id, started_at, ended_at,
		           exit_reason, input_tokens, output_tokens`,
		taskID, req.Adapter, req.Model, req.MachineID, started, req.EndedAt,
		req.ExitReason, req.InputTokens, req.OutputTokens,
	).Scan(&run.ID, &run.TaskID, &run.Adapter, &run.Model, &run.MachineID, &run.StartedAt,
		&run.EndedAt, &run.ExitReason, &run.InputTokens, &run.OutputTokens)
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "run.create", "agent_run", run.ID, map[string]any{"task_id": taskID, "adapter": run.Adapter}); err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, run, nil
}
