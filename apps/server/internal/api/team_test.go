package api_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

// ---- helpers ----------------------------------------------------------------

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// newServer starts an extra API instance (own config, own limiter/broker).
func newServer(t *testing.T, cfg api.Config) string {
	t.Helper()
	srv := api.New(appPool, quietLogger(), cfg)
	ctx, cancel := context.WithCancel(context.Background())
	srv.Start(ctx)
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { hs.Close(); cancel() })
	return hs.URL
}

type call struct {
	base, method, path, token string
	headers                   map[string]string
	body                      any
}

func (c call) do(t *testing.T) (resp, http.Header) {
	t.Helper()
	var rdr io.Reader
	switch b := c.body.(type) {
	case nil:
	case string:
		rdr = strings.NewReader(b)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(buf)
	}
	base := c.base
	if base == "" {
		base = ts.URL
	}
	req, err := http.NewRequest(c.method, base+c.path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if rdr != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := resp{Status: res.StatusCode}
	if err := json.NewDecoder(res.Body).Decode(&out.Body); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("%s %s: decode: %v", c.method, c.path, err)
	}
	return out, res.Header
}

func authed(t *testing.T, token, method, path string, body any) resp {
	t.Helper()
	r, _ := call{method: method, path: path, token: token, body: body}.do(t)
	return r
}

// devToken mints a token through POST /v1/dev/tokens.
func devToken(t *testing.T, body map[string]any) (token, orgID string) {
	t.Helper()
	r, _ := call{method: "POST", path: "/v1/dev/tokens", body: body}.do(t)
	expect(t, r, http.StatusCreated, "")
	return r.Body["token"].(string), r.Body["org_id"].(string)
}

func syncBody(project, title, status string, updated time.Time) map[string]any {
	return map[string]any{
		"project_id": project, "title": title, "status": status,
		"branch": "kingu/sync-test", "agent": "claude-code", "model": "opus",
		"diff_stats": map[string]any{"additions": 12, "deletions": 3, "files_changed": 2},
		"started_at": "2026-10-17T09:00:00Z",
		"updated_at": updated.UTC().Format(time.RFC3339Nano),
	}
}

type sseMsg struct {
	ID, Event, Data, Comment string
}

// openStream connects to /v1/events and returns parsed messages.
func openStream(t *testing.T, base, token string, headers map[string]string) (<-chan sseMsg, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		cancel()
		t.Fatalf("events status %d: %s", res.StatusCode, b)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type %q", ct)
	}
	ch := make(chan sseMsg, 64)
	go func() {
		defer close(ch)
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		var m sseMsg
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if m != (sseMsg{}) {
					ch <- m
				}
				m = sseMsg{}
			case strings.HasPrefix(line, ":"):
				m.Comment = strings.TrimSpace(line[1:])
			case strings.HasPrefix(line, "id: "):
				m.ID = line[4:]
			case strings.HasPrefix(line, "event: "):
				m.Event = line[7:]
			case strings.HasPrefix(line, "data: "):
				m.Data = line[6:]
			}
		}
	}()
	return ch, cancel
}

// waitFor returns the first message matching pred within d.
func waitFor(t *testing.T, ch <-chan sseMsg, d time.Duration, pred func(sseMsg) bool) sseMsg {
	t.Helper()
	timeout := time.After(d)
	for {
		select {
		case m, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed")
			}
			if pred(m) {
				return m
			}
		case <-timeout:
			t.Fatalf("no matching event within %v", d)
		}
	}
}

func eventData(t *testing.T, m sseMsg) map[string]any {
	t.Helper()
	var ev map[string]any
	if err := json.Unmarshal([]byte(m.Data), &ev); err != nil {
		t.Fatalf("event data %q: %v", m.Data, err)
	}
	return ev
}

// ---- auth -------------------------------------------------------------------

func TestDevTokenAndBearerAuth(t *testing.T) {
	requireDB(t)
	tok, org := devToken(t, map[string]any{"org_name": "token-org", "user_id": "alice"})
	if !strings.HasPrefix(tok, api.TokenPrefix) || len(tok) != 47 {
		t.Fatalf("token shape %q", tok)
	}
	r := authed(t, tok, "GET", "/v1/me", nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["user_id"] != "alice" || r.Body["org_id"] != org || r.Body["role"] != "owner" || r.Body["org_name"] != "token-org" {
		t.Fatalf("me = %v", r.Body)
	}

	// Stored hashed, never in plaintext.
	sum := sha256.Sum256([]byte(tok))
	var n int
	if err := adminPool.QueryRow(context.Background(),
		`SELECT count(*) FROM api_tokens WHERE token_hash = $1 AND prefix = $2`, sum[:], tok[:12]).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("hashed token rows = %d", n)
	}
	if err := adminPool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE details::text LIKE '%' || $1 || '%'`, tok).Scan(&n); err != nil || n != 0 {
		t.Fatalf("plaintext token in audit log: n=%d err=%v", n, err)
	}

	// Bad credentials.
	expect(t, authed(t, "kgu_"+strings.Repeat("A", 43), "GET", "/v1/me", nil), http.StatusUnauthorized, "invalid_token")
	expect(t, authed(t, "not-a-token", "GET", "/v1/me", nil), http.StatusUnauthorized, "invalid_token")
	r, _ = call{method: "GET", path: "/v1/me", headers: map[string]string{"Authorization": "Basic Zm9vOmJhcg=="}}.do(t)
	expect(t, r, http.StatusUnauthorized, "invalid_token")

	// Second token for an existing org; viewer role is read-only.
	viewer, _ := devToken(t, map[string]any{"org_id": org, "user_id": "vic", "role": "viewer"})
	expect(t, authed(t, viewer, "GET", "/v1/projects", nil), http.StatusOK, "")
	expect(t, authed(t, viewer, "POST", "/v1/projects", map[string]any{"name": "x", "repo_url": "https://e.com/x"}), http.StatusForbidden, "forbidden")

	// Revoked and expired tokens stop working.
	if _, err := adminPool.Exec(context.Background(), `UPDATE api_tokens SET revoked_at = now() WHERE token_hash = $1`, sum[:]); err != nil {
		t.Fatal(err)
	}
	expect(t, authed(t, tok, "GET", "/v1/me", nil), http.StatusUnauthorized, "invalid_token")
	vs := sha256.Sum256([]byte(viewer))
	if _, err := adminPool.Exec(context.Background(), `UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, vs[:]); err != nil {
		t.Fatal(err)
	}
	expect(t, authed(t, viewer, "GET", "/v1/me", nil), http.StatusUnauthorized, "invalid_token")

	// Dev endpoint validation.
	r, _ = call{method: "POST", path: "/v1/dev/tokens", body: map[string]any{"org_id": "00000000-0000-0000-0000-000000000000", "user_id": "x"}}.do(t)
	expect(t, r, http.StatusForbidden, "unknown_org")
	r, _ = call{method: "POST", path: "/v1/dev/tokens", body: map[string]any{"org_name": "x", "user_id": "x", "admin": true}}.do(t)
	expect(t, r, http.StatusBadRequest, "unknown_field")
}

func TestProductionModeRequiresToken(t *testing.T) {
	requireDB(t)
	base := newServer(t, api.Config{})
	org := newOrg(t, "prod-mode")

	r, _ := call{base: base, method: "GET", path: "/v1/projects", headers: map[string]string{api.HeaderOrg: org}}.do(t)
	expect(t, r, http.StatusUnauthorized, "missing_token")
	r, _ = call{base: base, method: "POST", path: "/v1/dev/tokens", body: map[string]any{"org_id": org, "user_id": "x"}}.do(t)
	expect(t, r, http.StatusNotFound, "not_found")

	minted, err := api.MintToken(context.Background(), appPool, org, "bob", "dev", "test", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	r, _ = call{base: base, method: "GET", path: "/v1/me", token: minted.Token}.do(t)
	expect(t, r, http.StatusOK, "")
	if r.Body["user_id"] != "bob" || r.Body["role"] != "dev" {
		t.Fatalf("me = %v", r.Body)
	}
	// The dev header cannot override the token's org.
	other := newOrg(t, "prod-mode-other")
	r, _ = call{base: base, method: "GET", path: "/v1/me", token: minted.Token, headers: map[string]string{api.HeaderOrg: other}}.do(t)
	expect(t, r, http.StatusOK, "")
	if r.Body["org_id"] != org {
		t.Fatalf("header changed org: %v", r.Body)
	}
}

func TestTokenRLSIsolation(t *testing.T) {
	requireDB(t)
	tokA, orgA := devToken(t, map[string]any{"org_name": "iso-a", "user_id": "a"})
	tokB, orgB := devToken(t, map[string]any{"org_name": "iso-b", "user_id": "b"})
	r := authed(t, tokB, "POST", "/v1/projects", map[string]any{"name": "b-secret", "repo_url": "https://e.com/b"})
	expect(t, r, http.StatusCreated, "")
	projB := r.Body["id"].(string)
	expect(t, authed(t, tokB, "PUT", "/v1/tasks/b-1/sync", syncBody(projB, "B task", "running", time.Now())), http.StatusCreated, "")

	r = authed(t, tokA, "GET", "/v1/projects", nil)
	expect(t, r, http.StatusOK, "")
	if len(items(t, r)) != 0 {
		t.Fatalf("org A sees projects: %v", r.Body)
	}
	r = authed(t, tokA, "GET", "/v1/tasks", nil)
	expect(t, r, http.StatusOK, "")
	if len(items(t, r)) != 0 {
		t.Fatalf("org A sees tasks: %v", r.Body)
	}
	expect(t, authed(t, tokA, "PUT", "/v1/tasks/b-1/sync", syncBody(projB, "hijack", "done", time.Now())), http.StatusNotFound, "not_found")
	r = authed(t, tokB, "GET", "/v1/tasks", nil)
	if got := items(t, r); len(got) != 1 || got[0]["title"] != "B task" {
		t.Fatalf("org B tasks = %v", got)
	}

	// Database layer: tokens and events are org-scoped too.
	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, orgA, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM api_tokens WHERE org_id = $1`, orgB).Scan(&n); err != nil || n != 0 {
			return fmt.Errorf("org A sees %d org B tokens (err %v)", n, err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM org_events WHERE org_id = $1`, orgB).Scan(&n); err != nil || n != 0 {
			return fmt.Errorf("org A sees %d org B events (err %v)", n, err)
		}
		tag, err := tx.Exec(ctx, `DELETE FROM org_events`)
		if err != nil || tag.RowsAffected() != 0 {
			return fmt.Errorf("org events deletable: %v %v", tag, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := appPool.QueryRow(ctx, `SELECT count(*) FROM api_tokens`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("unscoped token query sees %d rows (err %v)", n, err)
	}
}

// ---- sync -------------------------------------------------------------------

func TestSyncIdempotentUpsert(t *testing.T) {
	requireDB(t)
	tok, org := devToken(t, map[string]any{"org_name": "sync-org", "user_id": "carol"})
	r := authed(t, tok, "POST", "/v1/projects", map[string]any{"name": "app", "repo_url": "https://e.com/app"})
	expect(t, r, http.StatusCreated, "")
	proj := r.Body["id"].(string)
	path := "/v1/tasks/task-42/sync"
	t0 := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)

	counts := func() (audits, events int) {
		ctx := context.Background()
		_ = adminPool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE org_id = $1 AND action = 'task.sync'`, org).Scan(&audits)
		_ = adminPool.QueryRow(ctx, `SELECT count(*) FROM org_events WHERE org_id = $1`, org).Scan(&events)
		return
	}

	r = authed(t, tok, "PUT", path, syncBody(proj, "Add login page", "running", t0))
	expect(t, r, http.StatusCreated, "")
	task := r.Body["task"].(map[string]any)
	if r.Body["created"] != true || r.Body["applied"] != true || task["client_task_id"] != "task-42" ||
		task["additions"] != float64(12) || task["agent"] != "claude-code" || task["updated_by"] != "carol" || task["created_by"] != "carol" {
		t.Fatalf("sync create = %v", r.Body)
	}
	id := task["id"]
	a1, e1 := counts()

	// Exact retry: no change, no audit row, no event.
	r = authed(t, tok, "PUT", path, syncBody(proj, "Add login page", "running", t0))
	expect(t, r, http.StatusOK, "")
	if r.Body["applied"] != false || r.Body["task"].(map[string]any)["id"] != id {
		t.Fatalf("retry = %v", r.Body)
	}
	if a2, e2 := counts(); a2 != a1 || e2 != e1 {
		t.Fatalf("retry wrote audit %d->%d events %d->%d", a1, a2, e1, e2)
	}

	// Newer state applies.
	r = authed(t, tok, "PUT", path, syncBody(proj, "Add login page", "review", t0.Add(time.Minute)))
	expect(t, r, http.StatusOK, "")
	if r.Body["applied"] != true || r.Body["task"].(map[string]any)["status"] != "review" {
		t.Fatalf("update = %v", r.Body)
	}
	// Stale state (older client clock) is ignored.
	r = authed(t, tok, "PUT", path, syncBody(proj, "Add login page", "running", t0.Add(30*time.Second)))
	expect(t, r, http.StatusOK, "")
	if r.Body["applied"] != false || r.Body["task"].(map[string]any)["status"] != "review" {
		t.Fatalf("stale = %v", r.Body)
	}
	r = authed(t, tok, "GET", "/v1/tasks?project_id="+proj, nil)
	if got := items(t, r); len(got) != 1 || got[0]["status"] != "review" {
		t.Fatalf("tasks = %v", got)
	}

	mut := func(f func(m map[string]any)) map[string]any {
		b := syncBody(proj, "ok", "running", t0.Add(time.Hour))
		f(b)
		return b
	}
	cases := []struct {
		name   string
		path   string
		body   any
		status int
		code   string
	}{
		{"unknown field", path, mut(func(m map[string]any) { m["diff"] = "x" }), 400, "unknown_field"},
		{"unknown nested field", path, mut(func(m map[string]any) {
			m["diff_stats"] = map[string]any{"additions": 1, "patch": "x"}
		}), 400, "unknown_field"},
		{"bad status", path, mut(func(m map[string]any) { m["status"] = "wip" }), 400, "invalid_status"},
		{"title too long", path, mut(func(m map[string]any) { m["title"] = strings.Repeat("a", 301) }), 400, "invalid_input"},
		{"field over 2KB", path, mut(func(m map[string]any) { m["model"] = strings.Repeat("a", 2100) }), 422, "content_not_allowed"},
		{"multi-line", path, mut(func(m map[string]any) { m["title"] = "line1\nline2" }), 422, "content_not_allowed"},
		{"diff in title", path, mut(func(m map[string]any) { m["title"] = "diff --git a/x b/x" }), 422, "content_not_allowed"},
		{"secret in title", path, mut(func(m map[string]any) { m["title"] = "use ghp_" + strings.Repeat("a", 36) }), 422, "content_not_allowed"},
		{"pem", path, mut(func(m map[string]any) { m["agent"] = "-----BEGIN PRIVATE KEY-----" }), 422, "content_not_allowed"},
		{"array", path, mut(func(m map[string]any) { m["title"] = []string{"a"} }), 400, "invalid_input"},
		{"body over 8KB", path, mut(func(m map[string]any) {
			for i := range 6 {
				m[fmt.Sprintf("pad%d", i)] = strings.Repeat("a", 1500)
			}
		}), 413, "body_too_large"},
		{"negative stats", path, mut(func(m map[string]any) { m["diff_stats"] = map[string]any{"additions": -1} }), 400, "invalid_input"},
		{"missing updated_at", path, mut(func(m map[string]any) { delete(m, "updated_at") }), 400, "invalid_input"},
		{"far future", path, mut(func(m map[string]any) { m["updated_at"] = "2099-01-01T00:00:00Z" }), 400, "invalid_input"},
		{"finished before started", path, mut(func(m map[string]any) { m["finished_at"] = "2026-10-17T08:00:00Z" }), 400, "invalid_input"},
		{"bad branch", path, mut(func(m map[string]any) { m["branch"] = "a..b" }), 400, "invalid_input"},
		{"bad client id", "/v1/tasks/has%20space/sync", mut(func(map[string]any) {}), 400, "invalid_input"},
		{"bad project", path, mut(func(m map[string]any) { m["project_id"] = "nope" }), 400, "invalid_input"},
		{"missing project", path, mut(func(m map[string]any) { m["project_id"] = "11111111-1111-1111-1111-111111111111" }), 404, "not_found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, authed(t, tok, "PUT", tc.path, tc.body), tc.status, tc.code)
		})
	}
}

// ---- events -----------------------------------------------------------------

func TestEventsNotifyDriven(t *testing.T) {
	requireDB(t)
	// Heartbeat (and its catch-up fallback) far beyond the wait below, so the
	// event can only arrive through LISTEN/NOTIFY.
	base := newServer(t, api.Config{Heartbeat: time.Hour})
	tok, _ := devToken(t, map[string]any{"org_name": "sse-org", "user_id": "dave"})
	other, _ := devToken(t, map[string]any{"org_name": "sse-other", "user_id": "eve"})
	proj := authed(t, tok, "POST", "/v1/projects", map[string]any{"name": "p", "repo_url": "https://e.com/p"}).Body["id"].(string)
	projOther := authed(t, other, "POST", "/v1/projects", map[string]any{"name": "p", "repo_url": "https://e.com/p"}).Body["id"].(string)

	ch, stop := openStream(t, base, tok, nil)
	defer stop()
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "connected" })

	// Another org's change must not appear; ours must, within the NOTIFY path.
	expect(t, authed(t, other, "PUT", "/v1/tasks/o-1/sync", syncBody(projOther, "Other org task", "running", time.Now())), http.StatusCreated, "")
	expect(t, authed(t, tok, "PUT", "/v1/tasks/t-1/sync", syncBody(proj, "Live task", "running", time.Now())), http.StatusCreated, "")
	m := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if m.Event != "task.created" || m.ID == "" {
		t.Fatalf("first event = %+v", m)
	}
	ev := eventData(t, m)
	data := ev["data"].(map[string]any)
	if data["title"] != "Live task" || data["client_task_id"] != "t-1" || data["additions"] != float64(12) {
		t.Fatalf("event = %v", ev)
	}

	// A run on the task is pushed too.
	taskID := data["id"].(string)
	expect(t, authed(t, tok, "POST", "/v1/tasks/"+taskID+"/runs", map[string]any{"adapter": "claude-code", "model": "opus"}), http.StatusCreated, "")
	m = waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if m.Event != "run.created" {
		t.Fatalf("second event = %+v", m)
	}
	r := authed(t, tok, "GET", "/v1/runs", nil)
	if runs := items(t, r); len(runs) != 1 || runs[0]["task_title"] != "Live task" {
		t.Fatalf("runs = %v", runs)
	}
}

func TestEventsHeartbeatAndReplay(t *testing.T) {
	requireDB(t)
	tok, org := devToken(t, map[string]any{"org_name": "replay-org", "user_id": "fay"})
	proj := authed(t, tok, "POST", "/v1/projects", map[string]any{"name": "p", "repo_url": "https://e.com/p"}).Body["id"].(string)

	// Shared test server: 300ms heartbeat.
	ch, stop := openStream(t, ts.URL, tok, nil)
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "ping" })
	expect(t, authed(t, tok, "PUT", "/v1/tasks/r-1/sync", syncBody(proj, "First", "running", time.Now())), http.StatusCreated, "")
	first := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event == "task.created" })
	stop()

	// Changes while disconnected are replayed from Last-Event-ID.
	expect(t, authed(t, tok, "PUT", "/v1/tasks/r-1/sync", syncBody(proj, "First", "done", time.Now().Add(time.Second))), http.StatusOK, "")
	expect(t, authed(t, tok, "PUT", "/v1/tasks/r-2/sync", syncBody(proj, "Second", "running", time.Now())), http.StatusCreated, "")
	ch, stop = openStream(t, ts.URL, tok, map[string]string{"Last-Event-ID": first.ID})
	a := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	b := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	stop()
	if a.Event != "task.updated" || eventData(t, a)["data"].(map[string]any)["status"] != "done" ||
		b.Event != "task.created" || eventData(t, b)["data"].(map[string]any)["title"] != "Second" {
		t.Fatalf("replay = %+v / %+v", a, b)
	}

	// Without Last-Event-ID there is no replay: only new events.
	ch, stop = openStream(t, ts.URL, tok, nil)
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "ping" })
	stop()

	// Retention: expired events are pruned; resuming from a pruned id resets.
	ctx := context.Background()
	var oldID int64
	if err := adminPool.QueryRow(ctx,
		`INSERT INTO org_events (org_id, kind, payload, created_at)
		 VALUES ($1, 'task.updated', '{}', now() - interval '100 hours') RETURNING id`, org).Scan(&oldID); err != nil {
		t.Fatal(err)
	}
	if n, err := db.PruneEvents(ctx, appPool); err != nil || n < 1 {
		t.Fatalf("prune: n=%d err=%v", n, err)
	}
	var left int
	_ = adminPool.QueryRow(ctx, `SELECT count(*) FROM org_events WHERE org_id = $1`, org).Scan(&left)
	if left != 3 {
		t.Fatalf("events left after prune = %d, want 3 recent", left)
	}
	ch, stop = openStream(t, ts.URL, tok, map[string]string{"Last-Event-ID": fmt.Sprint(oldID)})
	defer stop()
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event == "reset" })

	r, _ := call{method: "GET", path: "/v1/events", token: tok, headers: map[string]string{"Last-Event-ID": "abc"}}.do(t)
	expect(t, r, http.StatusBadRequest, "invalid_input")
	r, _ = call{method: "GET", path: "/v1/events"}.do(t)
	expect(t, r, http.StatusUnauthorized, "missing_org")
}

// ---- rate limiting ----------------------------------------------------------

func TestRateLimitPerToken(t *testing.T) {
	requireDB(t)
	base := newServer(t, api.Config{RateLimit: 0.5, RateBurst: 3})
	tokA, org := devToken(t, map[string]any{"org_name": "rl-org", "user_id": "gus"})
	tokB, _ := devToken(t, map[string]any{"org_id": org, "user_id": "hal"})

	for i := range 3 {
		r, _ := call{base: base, method: "GET", path: "/v1/me", token: tokA}.do(t)
		expect(t, r, http.StatusOK, "")
		_ = i
	}
	r, h := call{base: base, method: "GET", path: "/v1/me", token: tokA}.do(t)
	expect(t, r, http.StatusTooManyRequests, "rate_limited")
	if h.Get("Retry-After") == "" {
		t.Fatal("missing Retry-After")
	}
	// Buckets are per token.
	r, _ = call{base: base, method: "GET", path: "/v1/me", token: tokB}.do(t)
	expect(t, r, http.StatusOK, "")
}
