package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	// MaxSyncBodyBytes caps PUT /v1/tasks/{id}/sync bodies: metadata only.
	MaxSyncBodyBytes = 8 << 10
	// MaxSyncFieldBytes is the largest string accepted anywhere in a sync
	// body. Anything longer is treated as file contents and rejected.
	MaxSyncFieldBytes = 2 << 10

	maxDiffLines = 100_000_000
	maxDiffFiles = 1_000_000
)

var (
	clientTaskIDRe = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

	// Shapes of content that must never reach the server: diffs/patches,
	// PEM blocks and well-known credential formats.
	contentMarkers = []string{"diff --git", "\n@@ ", "@@ -", "+++ b/", "--- a/", "-----BEGIN", "\x00"}
	secretRe       = regexp.MustCompile(`(?i)(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|` + TokenPrefix + `[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)`)
)

type diffStats struct {
	Additions    int `json:"additions"`
	Deletions    int `json:"deletions"`
	FilesChanged int `json:"files_changed"`
}

type syncTaskReq struct {
	ProjectID  string     `json:"project_id"`
	Title      string     `json:"title"`
	Status     string     `json:"status"`
	Branch     *string    `json:"branch"`
	Agent      *string    `json:"agent"`
	Model      *string    `json:"model"`
	DiffStats  *diffStats `json:"diff_stats"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	// Source is the issue tracker the task came from (manual when absent);
	// ExternalRef names the issue there ("acme/app#42", "ENG-123").
	Source      *string `json:"source"`
	ExternalRef *string `json:"external_ref"`
	// UpdatedAt is the client's clock for this state; older states than the
	// stored one are ignored, so retries and reordering are harmless.
	UpdatedAt *time.Time `json:"updated_at"`
}

// source is the task's source, defaulting to manual.
func (req *syncTaskReq) source() string {
	if req.Source == nil {
		return "manual"
	}
	return *req.Source
}

type syncTaskResp struct {
	Task task `json:"task"`
	// Created is true when this call inserted the task.
	Created bool `json:"created"`
	// Applied is false when the call changed nothing (identical or stale).
	Applied bool `json:"applied"`
}

var errContent = &apiError{Status: http.StatusUnprocessableEntity, Code: "content_not_allowed",
	Message: "sync accepts task metadata only; a field looks like file contents, a diff or a secret"}

// screenContent walks every JSON string in the body (keys included) and
// rejects values that look like file contents or credentials.
func screenContent(v any) *apiError {
	switch x := v.(type) {
	case string:
		if len(x) > MaxSyncFieldBytes || strings.Count(x, "\n") > 0 {
			return errContent
		}
		for _, m := range contentMarkers {
			if strings.Contains(x, m) {
				return errContent
			}
		}
		if secretRe.MatchString(x) {
			return errContent
		}
	case map[string]any:
		for k, e := range x {
			if err := screenContent(k); err != nil {
				return err
			}
			if err := screenContent(e); err != nil {
				return err
			}
		}
	case []any:
		// No sync field is an array.
		return errBadRequest("invalid_input", "arrays are not allowed in a sync body")
	}
	return nil
}

func (req *syncTaskReq) validate(now time.Time) *apiError {
	if _, ok := parseUUID(req.ProjectID); !ok {
		return errBadRequest("invalid_input", "project_id must be a uuid")
	}
	if err := checkText("title", req.Title, maxTitleLen, true); err != nil {
		return err
	}
	if !taskStatuses[req.Status] {
		return errBadRequest("invalid_status", "status must be one of backlog, running, needs_input, review, done, failed")
	}
	if req.Branch != nil {
		if err := checkRef("branch", *req.Branch); err != nil {
			return err
		}
	}
	if req.Agent != nil {
		if err := checkText("agent", *req.Agent, 100, true); err != nil {
			return err
		}
	}
	if req.Model != nil {
		if err := checkText("model", *req.Model, maxShortTextLen, true); err != nil {
			return err
		}
	}
	if err := checkSource(req.source(), req.ExternalRef); err != nil {
		return err
	}
	if d := req.DiffStats; d != nil {
		if d.Additions < 0 || d.Deletions < 0 || d.FilesChanged < 0 ||
			d.Additions > maxDiffLines || d.Deletions > maxDiffLines || d.FilesChanged > maxDiffFiles {
			return errBadRequest("invalid_input", "diff_stats values must be non-negative and bounded")
		}
	}
	if req.UpdatedAt == nil || req.UpdatedAt.IsZero() {
		return errBadRequest("invalid_input", "updated_at is required")
	}
	// Generous skew allowance, but a far-future clock would freeze the task.
	if err := checkClockRange(now, map[string]*time.Time{"updated_at": req.UpdatedAt, "started_at": req.StartedAt, "finished_at": req.FinishedAt}); err != nil {
		return err
	}
	if req.StartedAt != nil && req.FinishedAt != nil && req.FinishedAt.Before(*req.StartedAt) {
		return errBadRequest("invalid_input", "finished_at must not be before started_at")
	}
	return nil
}

// decodeSyncBody size-caps and content-screens a sync body, then strictly
// decodes it into dst.
func decodeSyncBody(r *http.Request, dst any) error {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if len(raw) > MaxSyncBodyBytes {
		return &apiError{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large",
			Message: "sync body exceeds 8 KiB; send metadata only"}
	}
	// Screen generically first so even unknown fields are never echoed or
	// logged if they carry content.
	var generic any
	if json.Unmarshal(raw, &generic) == nil {
		if _, ok := generic.(map[string]any); ok {
			if err := screenContent(generic); err != nil {
				return err
			}
		}
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return decodeJSON(r, dst)
}

// checkClockRange rejects far-future (would freeze the row) and pre-2000 times.
func checkClockRange(now time.Time, times map[string]*time.Time) *apiError {
	limit := now.Add(24 * time.Hour)
	for name, t := range times {
		if t != nil && (t.After(limit) || t.Year() < 2000) {
			return errBadRequest("invalid_input", name+" is out of range")
		}
	}
	return nil
}

// syncTask is PUT /v1/tasks/{id}/sync, where {id} is the desktop's
// client_task_id. It upserts the task keyed by (project_id, client_task_id).
func (s *Server) syncTask(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	clientID := r.PathValue("id")
	if !clientTaskIDRe.MatchString(clientID) {
		return 0, nil, errBadRequest("invalid_input", "client task id must match [A-Za-z0-9._:-]{1,128}")
	}
	var req syncTaskReq
	if err := decodeSyncBody(r, &req); err != nil {
		return 0, nil, err
	}
	if err := req.validate(time.Now()); err != nil {
		return 0, nil, err
	}
	projectID, _ := parseUUID(req.ProjectID)
	if err := projectVisible(r, tx, projectID); err != nil {
		return 0, nil, err
	}
	var d diffStats
	if req.DiffStats != nil {
		d = *req.DiffStats
	}
	ctx := r.Context()
	var (
		t       task
		created bool
	)
	row := tx.QueryRow(ctx,
		`INSERT INTO tasks (org_id, project_id, client_task_id, title, status, branch, agent, model,
		                    additions, deletions, files_changed, started_at, finished_at,
		                    client_updated_at, created_by, updated_by, source, external_ref)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15, $16)
		 ON CONFLICT (project_id, client_task_id) WHERE client_task_id IS NOT NULL DO UPDATE SET
		     title = EXCLUDED.title, status = EXCLUDED.status, branch = EXCLUDED.branch,
		     agent = EXCLUDED.agent, model = EXCLUDED.model,
		     additions = EXCLUDED.additions, deletions = EXCLUDED.deletions,
		     files_changed = EXCLUDED.files_changed,
		     started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
		     source = EXCLUDED.source, external_ref = EXCLUDED.external_ref,
		     client_updated_at = EXCLUDED.client_updated_at,
		     updated_by = EXCLUDED.updated_by, updated_at = now()
		 WHERE (tasks.client_updated_at IS NULL OR tasks.client_updated_at <= EXCLUDED.client_updated_at)
		   AND (tasks.title, tasks.status, tasks.branch, tasks.agent, tasks.model, tasks.additions,
		        tasks.deletions, tasks.files_changed, tasks.started_at, tasks.finished_at,
		        tasks.source, tasks.external_ref)
		       IS DISTINCT FROM
		       (EXCLUDED.title, EXCLUDED.status, EXCLUDED.branch, EXCLUDED.agent, EXCLUDED.model,
		        EXCLUDED.additions, EXCLUDED.deletions, EXCLUDED.files_changed,
		        EXCLUDED.started_at, EXCLUDED.finished_at, EXCLUDED.source, EXCLUDED.external_ref)
		 RETURNING `+taskCols+`, (xmax = 0)`,
		projectID, clientID, req.Title, req.Status, req.Branch, req.Agent, req.Model,
		d.Additions, d.Deletions, d.FilesChanged, req.StartedAt, req.FinishedAt, req.UpdatedAt, oc.Actor,
		req.source(), req.ExternalRef)
	err := row.Scan(append(t.scanDest(), &created)...)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Identical or stale: nothing changed, report the stored state.
		t, err = scanTask(tx.QueryRow(ctx,
			`SELECT `+taskCols+` FROM tasks WHERE project_id = $1 AND client_task_id = $2`, projectID, clientID))
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, syncTaskResp{Task: t}, nil
	case err != nil:
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "task.sync", "task", t.ID, map[string]any{
		"project_id": projectID, "status": t.Status, "created": created,
	}); err != nil {
		return 0, nil, err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	return status, syncTaskResp{Task: t, Created: created, Applied: true}, nil
}

// ---- run sync -----------------------------------------------------------------

type syncRunReq struct {
	ProjectID string  `json:"project_id"`
	Adapter   string  `json:"adapter"`
	Model     *string `json:"model"`
	// ExitReason is how the run ended (or "idle" after a turn while the
	// session stays open).
	ExitReason   *string    `json:"exit_reason"`
	StartedAt    *time.Time `json:"started_at"`
	EndedAt      *time.Time `json:"ended_at"`
	InputTokens  int64      `json:"input_tokens"`
	OutputTokens int64      `json:"output_tokens"`
	CostUSD      *float64   `json:"cost_usd"`
	// UpdatedAt is the client's clock for this state (see syncTaskReq).
	UpdatedAt *time.Time `json:"updated_at"`
}

type syncRunResp struct {
	Run     agentRun `json:"run"`
	Created bool     `json:"created"`
	Applied bool     `json:"applied"`
}

// errTaskNotSynced tells the desktop to retry the run after the task's own
// sync has landed (both go through the same outbox, tasks first).
var errTaskNotSynced = &apiError{Status: http.StatusConflict, Code: "task_not_synced",
	Message: "the run's task has not been synced yet; sync the task first"}

func (req *syncRunReq) validate(now time.Time) *apiError {
	if _, ok := parseUUID(req.ProjectID); !ok {
		return errBadRequest("invalid_input", "project_id must be a uuid")
	}
	if err := checkText("adapter", req.Adapter, 100, true); err != nil {
		return err
	}
	for field, v := range map[string]*string{"model": req.Model, "exit_reason": req.ExitReason} {
		if v != nil {
			if err := checkText(field, *v, maxShortTextLen, true); err != nil {
				return err
			}
		}
	}
	if err := checkUsage(req.InputTokens, req.OutputTokens, req.CostUSD); err != nil {
		return err
	}
	if req.StartedAt == nil || req.StartedAt.IsZero() {
		return errBadRequest("invalid_input", "started_at is required")
	}
	if req.UpdatedAt == nil || req.UpdatedAt.IsZero() {
		return errBadRequest("invalid_input", "updated_at is required")
	}
	if err := checkClockRange(now, map[string]*time.Time{"updated_at": req.UpdatedAt, "started_at": req.StartedAt, "ended_at": req.EndedAt}); err != nil {
		return err
	}
	if req.EndedAt != nil && req.EndedAt.Before(*req.StartedAt) {
		return errBadRequest("invalid_input", "ended_at must not be before started_at")
	}
	return nil
}

// syncRun is PUT /v1/tasks/{id}/runs/{run}/sync, where {id} is the desktop's
// client_task_id and {run} its client_run_id. It upserts the run keyed by
// (task, client_run_id); like task sync, older states are ignored.
func (s *Server) syncRun(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	clientTaskID, clientRunID := r.PathValue("id"), r.PathValue("run")
	if !clientTaskIDRe.MatchString(clientTaskID) || !clientTaskIDRe.MatchString(clientRunID) {
		return 0, nil, errBadRequest("invalid_input", "client task and run ids must match [A-Za-z0-9._:-]{1,128}")
	}
	var req syncRunReq
	if err := decodeSyncBody(r, &req); err != nil {
		return 0, nil, err
	}
	if err := req.validate(time.Now()); err != nil {
		return 0, nil, err
	}
	projectID, _ := parseUUID(req.ProjectID)
	if err := projectVisible(r, tx, projectID); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var taskID string
	err := tx.QueryRow(ctx, `SELECT id::text FROM tasks WHERE project_id = $1 AND client_task_id = $2`,
		projectID, clientTaskID).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errTaskNotSynced
	}
	if err != nil {
		return 0, nil, err
	}
	var (
		run     agentRun
		created bool
	)
	err = tx.QueryRow(ctx,
		`INSERT INTO agent_runs (org_id, task_id, client_run_id, adapter, model, started_at, ended_at,
		                         exit_reason, input_tokens, output_tokens, cost_usd, created_by, client_updated_at)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 ON CONFLICT (task_id, client_run_id) WHERE client_run_id IS NOT NULL DO UPDATE SET
		     adapter = EXCLUDED.adapter, model = EXCLUDED.model,
		     started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
		     exit_reason = EXCLUDED.exit_reason,
		     input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
		     cost_usd = EXCLUDED.cost_usd, client_updated_at = EXCLUDED.client_updated_at
		 WHERE (agent_runs.client_updated_at IS NULL OR agent_runs.client_updated_at <= EXCLUDED.client_updated_at)
		   AND (agent_runs.adapter, agent_runs.model, agent_runs.started_at, agent_runs.ended_at,
		        agent_runs.exit_reason, agent_runs.input_tokens, agent_runs.output_tokens, agent_runs.cost_usd)
		       IS DISTINCT FROM
		       (EXCLUDED.adapter, EXCLUDED.model, EXCLUDED.started_at, EXCLUDED.ended_at,
		        EXCLUDED.exit_reason, EXCLUDED.input_tokens, EXCLUDED.output_tokens, EXCLUDED.cost_usd)
		 RETURNING `+runCols+`, (xmax = 0)`,
		taskID, clientRunID, req.Adapter, req.Model, req.StartedAt, req.EndedAt, req.ExitReason,
		req.InputTokens, req.OutputTokens, req.CostUSD, oc.Actor, req.UpdatedAt,
	).Scan(append(run.scanDest(), &created)...)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Identical or stale: report the stored state.
		if err := tx.QueryRow(ctx, `SELECT `+runCols+` FROM agent_runs WHERE task_id = $1 AND client_run_id = $2`,
			taskID, clientRunID).Scan(run.scanDest()...); err != nil {
			return 0, nil, err
		}
		return http.StatusOK, syncRunResp{Run: run}, nil
	case err != nil:
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "run.sync", "agent_run", run.ID, map[string]any{
		"task_id": taskID, "adapter": run.Adapter, "created": created,
	}); err != nil {
		return 0, nil, err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	return status, syncRunResp{Run: run, Created: created, Applied: true}, nil
}

// ---- read endpoints for the dashboard ----------------------------------------

type meResp struct {
	OrgID       string `json:"org_id"`
	OrgName     string `json:"org_name"`
	UserID      string `json:"user_id"`
	Role        string `json:"role"`
	TokenPrefix string `json:"token_prefix,omitempty"`
}

func (s *Server) me(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	out := meResp{OrgID: oc.OrgID, UserID: oc.Actor, Role: oc.P.Role, TokenPrefix: oc.P.TokenPrefix}
	if err := tx.QueryRow(r.Context(), `SELECT name FROM orgs`).Scan(&out.OrgName); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, out, nil
}

// listOrgTasks is GET /v1/tasks?project_id=&status=&limit=, newest change first.
func (s *Server) listOrgTasks(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	limit, err := parseLimit(r)
	if err != nil {
		return 0, nil, err
	}
	q := r.URL.Query()
	projectID := q.Get("project_id")
	if projectID != "" {
		id, ok := parseUUID(projectID)
		if !ok {
			return 0, nil, errBadRequest("invalid_input", "project_id must be a uuid")
		}
		projectID = id
	}
	status := q.Get("status")
	if status != "" && !taskStatuses[status] {
		return 0, nil, errBadRequest("invalid_status", "status must be one of backlog, running, needs_input, review, done, failed")
	}
	rows, err := tx.Query(r.Context(),
		`SELECT `+taskCols+` FROM tasks
		 WHERE ($1 = '' OR project_id::text = $1) AND ($2 = '' OR status = $2)
		 ORDER BY updated_at DESC, id LIMIT $3`, projectID, status, limit)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (task, error) { return scanTask(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[task]{Items: items}, nil
}

type runListItem struct {
	agentRun
	ProjectID   string  `json:"project_id"`
	ProjectName string  `json:"project_name"`
	TaskTitle   string  `json:"task_title"`
	Source      string  `json:"source"`
	ExternalRef *string `json:"external_ref"`
}

// listRuns is GET /v1/runs?task_id=&limit=, newest first.
func (s *Server) listRuns(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	limit, err := parseLimit(r)
	if err != nil {
		return 0, nil, err
	}
	taskID := r.URL.Query().Get("task_id")
	if taskID != "" {
		id, ok := parseUUID(taskID)
		if !ok {
			return 0, nil, errBadRequest("invalid_input", "task_id must be a uuid")
		}
		taskID = id
	}
	rows, err := tx.Query(r.Context(),
		`SELECT r.id::text, r.task_id::text, r.adapter, r.model, r.machine_id, r.started_at, r.ended_at,
		        r.exit_reason, r.input_tokens, r.output_tokens, r.cost_usd::float8, r.created_by, r.client_run_id,
		        t.project_id::text, p.name, t.title, t.source, t.external_ref
		   FROM agent_runs r JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = t.project_id
		  WHERE ($1 = '' OR r.task_id::text = $1)
		  ORDER BY r.started_at DESC, r.id LIMIT $2`, taskID, limit)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (runListItem, error) {
		var it runListItem
		err := row.Scan(append(it.scanDest(), &it.ProjectID, &it.ProjectName, &it.TaskTitle, &it.Source, &it.ExternalRef)...)
		return it, err
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[runListItem]{Items: items}, nil
}
