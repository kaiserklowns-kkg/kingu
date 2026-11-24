package api

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Project and task management for the dashboard: read one, edit, delete.

// getProject is GET /v1/projects/{id}.
func (s *Server) getProject(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	p, err := scanProject(tx.QueryRow(r.Context(), `SELECT `+projectCols+` FROM projects WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("project not found")
	}
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, p, nil
}

type patchProjectReq struct {
	Name           *string `json:"name"`
	RepoURL        *string `json:"repo_url"`
	DefaultBaseRef *string `json:"default_base_ref"`
}

// patchProject is PATCH /v1/projects/{id} (owners and leads).
func (s *Server) patchProject(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	var req patchProjectReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if req.Name == nil && req.RepoURL == nil && req.DefaultBaseRef == nil {
		return 0, nil, errBadRequest("invalid_input", "at least one of name, repo_url, default_base_ref is required")
	}
	details := map[string]any{}
	if req.Name != nil {
		if err := checkText("name", *req.Name, maxProjectNameLen, true); err != nil {
			return 0, nil, err
		}
		details["name"] = *req.Name
	}
	if req.RepoURL != nil {
		if err := checkRepoURL(*req.RepoURL); err != nil {
			return 0, nil, err
		}
		details["repo_url"] = *req.RepoURL
	}
	if req.DefaultBaseRef != nil {
		if err := checkRef("default_base_ref", *req.DefaultBaseRef); err != nil {
			return 0, nil, err
		}
		details["default_base_ref"] = *req.DefaultBaseRef
	}
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	ctx := r.Context()
	p, err := scanProject(tx.QueryRow(ctx,
		`UPDATE projects SET name = COALESCE($2, name), repo_url = COALESCE($3, repo_url),
		        default_base_ref = COALESCE($4, default_base_ref), updated_at = now()
		  WHERE id = $1 RETURNING `+projectCols,
		id, req.Name, req.RepoURL, req.DefaultBaseRef))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("project not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "project.update", "project", p.ID, details); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, p, nil
}

// deleteProject is DELETE /v1/projects/{id} (owners). Its tasks and runs go
// with it; each task emits task.deleted. Desktops that still sync into the
// project get 404 until they are pointed at another one.
func (s *Server) deleteProject(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	if !oc.P.isOwner() {
		return 0, nil, errForbidden
	}
	ctx := r.Context()
	var (
		name  string
		tasks int
	)
	err = tx.QueryRow(ctx,
		`DELETE FROM projects WHERE id = $1
		 RETURNING name, (SELECT count(*) FROM tasks WHERE project_id = $1)::int`, id).Scan(&name, &tasks)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("project not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "project.delete", "project", id, map[string]any{"name": name, "tasks": tasks}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"id": id, "deleted": true, "tasks": tasks}, nil
}

type taskDetail struct {
	task
	ProjectName string `json:"project_name"`
}

// getTask is GET /v1/tasks/{id} with its project's name. Its runs come from
// GET /v1/runs?task_id=.
func (s *Server) getTask(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	var t taskDetail
	err = tx.QueryRow(r.Context(),
		`SELECT `+taskCols+`, (SELECT name FROM projects p WHERE p.id = tasks.project_id) FROM tasks WHERE id = $1`, id).
		Scan(append(t.scanDest(), &t.ProjectName)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("task not found")
	}
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, t, nil
}

// deleteTask is DELETE /v1/tasks/{id} (owners and leads) with its runs. A
// task a desktop syncs comes back on its next change.
func (s *Server) deleteTask(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	ctx := r.Context()
	var title, project string
	err = tx.QueryRow(ctx, `DELETE FROM tasks WHERE id = $1 RETURNING title, project_id::text`, id).Scan(&title, &project)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("task not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "task.delete", "task", id, map[string]any{"title": title, "project_id": project}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"id": id, "deleted": true}, nil
}
