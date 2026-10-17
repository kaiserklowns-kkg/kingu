package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

// Integration tests run against a throwaway PostgreSQL cluster created with
// initdb in a temp dir. It listens only on a Unix socket inside that dir
// (listen_addresses=''), so no existing cluster, data directory or TCP port
// of the user is touched. Tests skip if the PostgreSQL binaries are absent.

var (
	skipReason string
	appPool    *pgxpool.Pool // non-superuser role: RLS enforced
	adminPool  *pgxpool.Pool // superuser: used only to seed orgs
	ts         *httptest.Server
)

func TestMain(m *testing.M) {
	cleanup, err := setup()
	if err != nil {
		fmt.Fprintln(os.Stderr, "integration setup failed:", err)
		cleanup()
		os.Exit(1)
	}
	code := m.Run()
	cleanup()
	os.Exit(code)
}

func findPGBin() (string, bool) {
	candidates := []string{os.Getenv("KINGU_PG_BIN"), "/opt/homebrew/opt/postgresql@16/bin"}
	if p, err := exec.LookPath("pg_ctl"); err == nil {
		candidates = append(candidates, filepath.Dir(p))
	}
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		ok := true
		for _, b := range []string{"initdb", "pg_ctl", "postgres"} {
			if fi, err := os.Stat(filepath.Join(dir, b)); err != nil || fi.IsDir() {
				ok = false
				break
			}
		}
		if ok {
			return dir, true
		}
	}
	return "", false
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func setup() (cleanup func(), err error) {
	var cleanups []func()
	cleanup = func() {
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
	}
	bin, ok := findPGBin()
	if !ok {
		skipReason = "PostgreSQL binaries (initdb, pg_ctl, postgres) not found; set KINGU_PG_BIN"
		return cleanup, nil
	}
	// Short base dir: Unix socket paths are limited to ~103 bytes on macOS.
	dir, err := os.MkdirTemp("", "kpg")
	if err != nil {
		return cleanup, err
	}
	cleanups = append(cleanups, func() { _ = os.RemoveAll(dir) })
	dataDir := filepath.Join(dir, "data")
	port, err := freePort()
	if err != nil {
		return cleanup, err
	}

	// Isolate from any PG* env pointing at the user's real cluster.
	env := []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C", "TZ=UTC"}
	runCmd := func(name string, args ...string) error {
		cmd := exec.Command(filepath.Join(bin, name), args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s: %w\n%s", name, err, out)
		}
		return nil
	}
	if err := runCmd("initdb", "-D", dataDir, "-U", "postgres", "-A", "trust",
		"-E", "UTF8", "--no-locale", "--no-sync"); err != nil {
		return cleanup, err
	}
	opts := fmt.Sprintf("-k %s -c listen_addresses='' -p %d -c fsync=off -c synchronous_commit=off -c full_page_writes=off", dir, port)
	if err := runCmd("pg_ctl", "-D", dataDir, "-o", opts, "-l", filepath.Join(dir, "pg.log"), "-w", "-t", "60", "start"); err != nil {
		if b, rerr := os.ReadFile(filepath.Join(dir, "pg.log")); rerr == nil {
			err = fmt.Errorf("%w\n%s", err, b)
		}
		return cleanup, err
	}
	cleanups = append(cleanups, func() {
		_ = runCmd("pg_ctl", "-D", dataDir, "-m", "immediate", "-w", "stop")
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dsn := func(user, dbname string) string {
		return fmt.Sprintf("host=%s port=%d user=%s dbname=%s sslmode=disable", dir, port, user, dbname)
	}

	bootstrap, err := pgxpool.New(ctx, dsn("postgres", "postgres"))
	if err != nil {
		return cleanup, err
	}
	for _, stmt := range []string{
		`CREATE ROLE kingu_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
		`CREATE DATABASE kingu OWNER kingu_app`,
	} {
		if _, err := bootstrap.Exec(ctx, stmt); err != nil {
			bootstrap.Close()
			return cleanup, fmt.Errorf("%s: %w", stmt, err)
		}
	}
	bootstrap.Close()

	appPool, err = db.Open(ctx, dsn("kingu_app", "kingu"))
	if err != nil {
		return cleanup, err
	}
	cleanups = append(cleanups, appPool.Close)
	if err := db.CheckRole(ctx, appPool); err != nil {
		return cleanup, err
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := db.Migrate(ctx, appPool, logger); err != nil {
		return cleanup, err
	}
	adminPool, err = db.Open(ctx, dsn("postgres", "kingu"))
	if err != nil {
		return cleanup, err
	}
	cleanups = append(cleanups, adminPool.Close)

	srv := api.New(appPool, logger, api.Config{Dev: true, Heartbeat: 300 * time.Millisecond})
	bgCtx, stopBg := context.WithCancel(context.Background())
	cleanups = append(cleanups, stopBg)
	srv.Start(bgCtx)
	ts = httptest.NewServer(srv.Handler())
	cleanups = append(cleanups, ts.Close)
	return cleanup, nil
}

func requireDB(t *testing.T) {
	t.Helper()
	if skipReason != "" {
		t.Skip(skipReason)
	}
}

// newOrg seeds an org as superuser (no org-creation endpoint in the spike).
func newOrg(t *testing.T, name string) string {
	t.Helper()
	var id string
	if err := adminPool.QueryRow(context.Background(),
		`INSERT INTO orgs (name) VALUES ($1) RETURNING id::text`, name).Scan(&id); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	return id
}

type resp struct {
	Status int
	Body   map[string]any
}

func do(t *testing.T, method, path, org string, body any) resp {
	t.Helper()
	var rdr io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rdr = strings.NewReader(b)
	case []byte:
		rdr = bytes.NewReader(b)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, ts.URL+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if rdr != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if org != "" {
		req.Header.Set(api.HeaderOrg, org)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := resp{Status: res.StatusCode}
	if err := json.NewDecoder(res.Body).Decode(&out.Body); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("%s %s: decode response: %v", method, path, err)
	}
	return out
}

func expect(t *testing.T, r resp, status int, errCode string) {
	t.Helper()
	if r.Status != status {
		t.Fatalf("status = %d, want %d; body=%v", r.Status, status, r.Body)
	}
	if errCode != "" {
		e, _ := r.Body["error"].(map[string]any)
		if e == nil || e["code"] != errCode {
			t.Fatalf("error code = %v, want %q; body=%v", e, errCode, r.Body)
		}
		if msg, _ := e["message"].(string); msg == "" {
			t.Fatalf("error message empty; body=%v", r.Body)
		}
	}
}

func items(t *testing.T, r resp) []map[string]any {
	t.Helper()
	raw, ok := r.Body["items"].([]any)
	if !ok {
		t.Fatalf("no items in %v", r.Body)
	}
	out := make([]map[string]any, len(raw))
	for i, v := range raw {
		out[i] = v.(map[string]any)
	}
	return out
}

func createProject(t *testing.T, org, name string) string {
	t.Helper()
	r := do(t, "POST", "/v1/projects", org, map[string]any{
		"name": name, "repo_url": "https://github.com/acme/" + name + ".git",
	})
	expect(t, r, http.StatusCreated, "")
	return r.Body["id"].(string)
}

func TestHealth(t *testing.T) {
	requireDB(t)
	r := do(t, "GET", "/health", "", nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["database"] != "ok" {
		t.Fatalf("health body = %v", r.Body)
	}
}

func TestProjectTaskLifecycle(t *testing.T) {
	requireDB(t)
	org := newOrg(t, "acme")
	projectID := createProject(t, org, "kingu")

	r := do(t, "GET", "/v1/projects", org, nil)
	expect(t, r, http.StatusOK, "")
	if ps := items(t, r); len(ps) != 1 || ps[0]["id"] != projectID || ps[0]["default_base_ref"] != "main" {
		t.Fatalf("projects = %v", ps)
	}

	r = do(t, "POST", "/v1/projects/"+projectID+"/tasks", org, map[string]any{"title": "Add RLS spike"})
	expect(t, r, http.StatusCreated, "")
	taskID := r.Body["id"].(string)
	if r.Body["status"] != "backlog" || r.Body["source"] != "manual" || r.Body["created_by"] != "dev" {
		t.Fatalf("task = %v", r.Body)
	}

	r = do(t, "POST", "/v1/projects/"+projectID+"/tasks", org, map[string]any{
		"title": "Imported", "source": "github", "external_ref": "acme/kingu#12",
	})
	expect(t, r, http.StatusCreated, "")
	// Same external ref again -> conflict.
	r = do(t, "POST", "/v1/projects/"+projectID+"/tasks", org, map[string]any{
		"title": "Imported again", "source": "github", "external_ref": "acme/kingu#12",
	})
	expect(t, r, http.StatusConflict, "conflict")

	r = do(t, "PATCH", "/v1/tasks/"+taskID, org, map[string]any{"status": "running", "branch": "kingu/add-rls-spike"})
	expect(t, r, http.StatusOK, "")
	if r.Body["status"] != "running" || r.Body["branch"] != "kingu/add-rls-spike" {
		t.Fatalf("patched task = %v", r.Body)
	}
	r = do(t, "PATCH", "/v1/tasks/"+taskID, org, map[string]any{"status": "review"})
	expect(t, r, http.StatusOK, "")
	if r.Body["branch"] != "kingu/add-rls-spike" {
		t.Fatalf("branch lost on status-only patch: %v", r.Body)
	}

	r = do(t, "POST", "/v1/tasks/"+taskID+"/runs", org, map[string]any{
		"adapter": "claude-code", "model": "opus", "machine_id": "mbp-1",
		"started_at": "2026-10-17T10:00:00Z", "ended_at": "2026-10-17T10:05:00Z",
		"exit_reason": "completed", "input_tokens": 1200, "output_tokens": 340,
	})
	expect(t, r, http.StatusCreated, "")
	if r.Body["task_id"] != taskID || r.Body["input_tokens"] != float64(1200) {
		t.Fatalf("run = %v", r.Body)
	}

	r = do(t, "GET", "/v1/projects/"+projectID+"/tasks", org, nil)
	expect(t, r, http.StatusOK, "")
	tl := items(t, r)
	if len(tl) != 2 {
		t.Fatalf("tasks = %v", tl)
	}
	var found bool
	for _, tk := range tl {
		if tk["id"] == taskID {
			found = true
			if tk["status"] != "review" {
				t.Fatalf("listed task status = %v", tk["status"])
			}
		}
	}
	if !found {
		t.Fatalf("task %s missing from list %v", taskID, tl)
	}
	r = do(t, "GET", "/v1/projects/"+projectID+"/tasks?status=review", org, nil)
	expect(t, r, http.StatusOK, "")
	if got := items(t, r); len(got) != 1 || got[0]["id"] != taskID {
		t.Fatalf("filtered tasks = %v", got)
	}

	// Audit trail was written for every mutation (2 tasks + project + 2 patches + run).
	var n int
	if err := adminPool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE org_id = $1`, org).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 6 {
		t.Fatalf("audit rows = %d, want 6", n)
	}
}

func TestRLSIsolation(t *testing.T) {
	requireDB(t)
	orgA := newOrg(t, "org-a")
	orgB := newOrg(t, "org-b")
	projB := createProject(t, orgB, "secret-b")
	r := do(t, "POST", "/v1/projects/"+projB+"/tasks", orgB, map[string]any{"title": "B task"})
	expect(t, r, http.StatusCreated, "")
	taskB := r.Body["id"].(string)
	createProject(t, orgA, "a-proj")

	// HTTP layer: A sees only its own data; B's ids look nonexistent.
	r = do(t, "GET", "/v1/projects", orgA, nil)
	expect(t, r, http.StatusOK, "")
	for _, p := range items(t, r) {
		if p["org_id"] != orgA {
			t.Fatalf("org A sees foreign project %v", p)
		}
	}
	expect(t, do(t, "GET", "/v1/projects/"+projB+"/tasks", orgA, nil), http.StatusNotFound, "not_found")
	expect(t, do(t, "POST", "/v1/projects/"+projB+"/tasks", orgA, map[string]any{"title": "inject"}), http.StatusNotFound, "not_found")
	expect(t, do(t, "PATCH", "/v1/tasks/"+taskB, orgA, map[string]any{"status": "done"}), http.StatusNotFound, "not_found")
	expect(t, do(t, "POST", "/v1/tasks/"+taskB+"/runs", orgA, map[string]any{"adapter": "x"}), http.StatusNotFound, "not_found")

	// B's task is unchanged.
	r = do(t, "GET", "/v1/projects/"+projB+"/tasks", orgB, nil)
	expect(t, r, http.StatusOK, "")
	if got := items(t, r); len(got) != 1 || got[0]["status"] != "backlog" {
		t.Fatalf("org B tasks = %v", got)
	}

	// Database layer: the policies themselves, independent of handler checks.
	ctx := context.Background()
	var count int
	if err := db.WithOrg(ctx, appPool, orgA, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM projects WHERE id = $1`, projB).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return fmt.Errorf("org A can see org B project")
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE org_id = $1`, orgB).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return fmt.Errorf("org A can see org B tasks")
		}
		tag, err := tx.Exec(ctx, `UPDATE tasks SET status = 'done' WHERE id = $1`, taskB)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 0 {
			return fmt.Errorf("org A updated org B task")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Writing a row tagged with another org violates WITH CHECK.
	err := db.WithOrg(ctx, appPool, orgA, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO projects (org_id, name, repo_url) VALUES ($1, 'x', 'https://e.com/x')`, orgB)
		return err
	})
	if err == nil || !strings.Contains(err.Error(), "row-level security") {
		t.Fatalf("cross-org insert err = %v, want RLS violation", err)
	}
	// Without app.org_id set, nothing is visible (fail closed).
	if err := appPool.QueryRow(ctx, `SELECT count(*) FROM projects`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("unscoped query sees %d projects, want 0", count)
	}
	// Audit log is append-only.
	err = db.WithOrg(ctx, appPool, orgB, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM audit_log`)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 0 {
			return fmt.Errorf("deleted %d audit rows", tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMissingOrInvalidOrg(t *testing.T) {
	requireDB(t)
	expect(t, do(t, "GET", "/v1/projects", "", nil), http.StatusUnauthorized, "missing_org")
	expect(t, do(t, "POST", "/v1/projects", "", map[string]any{"name": "x", "repo_url": "https://e.com/x"}),
		http.StatusUnauthorized, "missing_org")
	expect(t, do(t, "GET", "/v1/projects", "not-a-uuid", nil), http.StatusUnauthorized, "invalid_org")
	expect(t, do(t, "GET", "/v1/projects", "00000000-0000-0000-0000-000000000000", nil), http.StatusForbidden, "unknown_org")
}

func TestValidation(t *testing.T) {
	requireDB(t)
	org := newOrg(t, "validation")
	projectID := createProject(t, org, "v")
	tasksPath := "/v1/projects/" + projectID + "/tasks"
	r := do(t, "POST", tasksPath, org, map[string]any{"title": "ok"})
	expect(t, r, http.StatusCreated, "")
	taskID := r.Body["id"].(string)

	cases := []struct {
		name, method, path string
		body               any
		status             int
		code               string
	}{
		{"title too long", "POST", tasksPath, map[string]any{"title": strings.Repeat("a", 301)}, 400, "invalid_input"},
		{"title max ok", "POST", tasksPath, map[string]any{"title": strings.Repeat("é", 300)}, 201, ""},
		{"title missing", "POST", tasksPath, map[string]any{}, 400, "invalid_input"},
		{"title blank", "POST", tasksPath, map[string]any{"title": "   "}, 400, "invalid_input"},
		{"bad status on create", "POST", tasksPath, map[string]any{"title": "t", "status": "wip"}, 400, "invalid_status"},
		{"bad source", "POST", tasksPath, map[string]any{"title": "t", "source": "gitlab", "external_ref": "1"}, 400, "invalid_input"},
		{"github needs external_ref", "POST", tasksPath, map[string]any{"title": "t", "source": "github"}, 400, "invalid_input"},
		{"unknown field", "POST", tasksPath, map[string]any{"title": "t", "diff": "secret"}, 400, "unknown_field"},
		{"malformed json", "POST", tasksPath, `{"title":`, 400, "invalid_json"},
		{"trailing json", "POST", tasksPath, `{"title":"a"}{"title":"b"}`, 400, "invalid_json"},
		{"body too large", "POST", tasksPath, `{"title":"` + strings.Repeat("a", api.MaxBodyBytes) + `"}`, 413, "body_too_large"},
		{"bad project id", "POST", "/v1/projects/nope/tasks", map[string]any{"title": "t"}, 400, "invalid_input"},
		{"missing project", "POST", "/v1/projects/11111111-1111-1111-1111-111111111111/tasks", map[string]any{"title": "t"}, 404, "not_found"},
		{"patch bad status", "PATCH", "/v1/tasks/" + taskID, map[string]any{"status": "finished"}, 400, "invalid_status"},
		{"patch empty", "PATCH", "/v1/tasks/" + taskID, map[string]any{}, 400, "invalid_input"},
		{"patch bad branch", "PATCH", "/v1/tasks/" + taskID, map[string]any{"branch": "feat..x"}, 400, "invalid_input"},
		{"patch unknown field", "PATCH", "/v1/tasks/" + taskID, map[string]any{"title": "x"}, 400, "unknown_field"},
		{"run negative tokens", "POST", "/v1/tasks/" + taskID + "/runs", map[string]any{"adapter": "a", "input_tokens": -1}, 400, "invalid_input"},
		{"run ended before start", "POST", "/v1/tasks/" + taskID + "/runs",
			map[string]any{"adapter": "a", "started_at": "2026-10-17T10:00:00Z", "ended_at": "2026-10-17T09:00:00Z"}, 400, "invalid_input"},
		{"run missing adapter", "POST", "/v1/tasks/" + taskID + "/runs", map[string]any{}, 400, "invalid_input"},
		{"project creds in url", "POST", "/v1/projects", map[string]any{"name": "c", "repo_url": "https://user:tok@github.com/a/b"}, 400, "invalid_input"},
		{"project bad scheme", "POST", "/v1/projects", map[string]any{"name": "c", "repo_url": "ftp://e.com/x"}, 400, "invalid_input"},
		{"project scp url ok", "POST", "/v1/projects", map[string]any{"name": "scp", "repo_url": "git@github.com:acme/x.git"}, 201, ""},
		{"project duplicate", "POST", "/v1/projects", map[string]any{"name": "v", "repo_url": "https://e.com/x"}, 409, "conflict"},
		{"bad limit", "GET", "/v1/projects?limit=0", nil, 400, "invalid_input"},
		{"unknown route", "GET", "/v1/nope", nil, 404, "not_found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, do(t, tc.method, tc.path, org, tc.body), tc.status, tc.code)
		})
	}

	t.Run("wrong content type", func(t *testing.T) {
		req, _ := http.NewRequest("POST", ts.URL+tasksPath, strings.NewReader(`{"title":"x"}`))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set(api.HeaderOrg, org)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnsupportedMediaType {
			t.Fatalf("status = %d", res.StatusCode)
		}
	})
}

func TestCheckRoleRejectsSuperuser(t *testing.T) {
	requireDB(t)
	if err := db.CheckRole(context.Background(), adminPool); !errors.Is(err, db.ErrRLSBypass) {
		t.Fatalf("CheckRole(superuser) = %v, want ErrRLSBypass", err)
	}
}
