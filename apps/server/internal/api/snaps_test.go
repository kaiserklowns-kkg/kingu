package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

func snapBody(version string) map[string]any {
	return map[string]any{
		"name": "Go tools", "version": version,
		"git_url": "https://github.com/acme/kingu-go.git", "git_ref": "v1",
		"commit_sha":      strings.Repeat("a", 40),
		"manifest_sha256": strings.Repeat("b", 64),
		"permissions":     map[string]any{"network": false, "fs": "worktree", "secrets": []string{"GO_TOKEN"}},
		"required":        true,
		"note":            "ใช้กับทุก repo Go",
	}
}

func TestSnapCatalogRoles(t *testing.T) {
	requireDB(t)
	owner, org := devToken(t, map[string]any{"org_name": "snaps-roles", "user_id": "olive"})
	lead, _ := devToken(t, map[string]any{"org_id": org, "user_id": "leo", "role": "lead"})
	dev, _ := devToken(t, map[string]any{"org_id": org, "user_id": "dan", "role": "dev"})
	viewer, _ := devToken(t, map[string]any{"org_id": org, "user_id": "vic", "role": "viewer"})

	r := authed(t, owner, "PUT", "/v1/snaps/go", snapBody("1.0.0"))
	expect(t, r, http.StatusCreated, "")
	if r.Body["approved_by"] != "olive" || r.Body["commit_sha"] != strings.Repeat("a", 40) || r.Body["required"] != true {
		t.Fatalf("put = %v", r.Body)
	}
	perms := r.Body["permissions"].(map[string]any)
	if perms["fs"] != "worktree" || perms["network"] != false || len(perms["secrets"].([]any)) != 1 {
		t.Fatalf("permissions = %v", perms)
	}

	// Members (and viewers) read; only owners and leads write.
	for _, tok := range []string{dev, viewer} {
		r = authed(t, tok, "GET", "/v1/snaps", nil)
		expect(t, r, http.StatusOK, "")
		if got := items(t, r); len(got) != 1 || got[0]["snap_id"] != "go" || got[0]["version"] != "1.0.0" {
			t.Fatalf("list = %v", got)
		}
		expect(t, authed(t, tok, "PUT", "/v1/snaps/go", snapBody("6.6.6")), http.StatusForbidden, "forbidden")
		expect(t, authed(t, tok, "PUT", "/v1/snaps/evil", snapBody("1")), http.StatusForbidden, "forbidden")
		expect(t, authed(t, tok, "DELETE", "/v1/snaps/go", nil), http.StatusForbidden, "forbidden")
	}

	// A lead re-approves (pins a new version): same row, updated, 200.
	body := snapBody("1.1.0")
	body["commit_sha"] = strings.Repeat("c", 40)
	delete(body, "git_ref")
	delete(body, "note")
	body["required"] = false
	r = authed(t, lead, "PUT", "/v1/snaps/go", body)
	expect(t, r, http.StatusOK, "")
	if r.Body["approved_by"] != "leo" || r.Body["version"] != "1.1.0" || r.Body["git_ref"] != nil || r.Body["note"] != nil {
		t.Fatalf("re-approve = %v", r.Body)
	}
	r = authed(t, dev, "GET", "/v1/snaps", nil)
	if got := items(t, r); len(got) != 1 || got[0]["commit_sha"] != strings.Repeat("c", 40) || got[0]["required"] != false {
		t.Fatalf("list after re-approve = %v", got)
	}

	expect(t, authed(t, lead, "DELETE", "/v1/snaps/go", nil), http.StatusOK, "")
	expect(t, authed(t, lead, "DELETE", "/v1/snaps/go", nil), http.StatusNotFound, "not_found")
	if got := items(t, authed(t, dev, "GET", "/v1/snaps", nil)); len(got) != 0 {
		t.Fatalf("list after delete = %v", got)
	}

	// Every change is audited.
	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, org, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action IN ('snap.approve', 'snap.remove')`).Scan(&n); err != nil {
			return err
		}
		if n != 3 {
			return fmt.Errorf("audit rows = %d, want 3", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSnapCatalogRLSIsolation(t *testing.T) {
	requireDB(t)
	tokA, orgA := devToken(t, map[string]any{"org_name": "snaps-a", "user_id": "a"})
	tokB, orgB := devToken(t, map[string]any{"org_name": "snaps-b", "user_id": "b"})
	expect(t, authed(t, tokB, "PUT", "/v1/snaps/secret-tool", snapBody("1")), http.StatusCreated, "")

	if got := items(t, authed(t, tokA, "GET", "/v1/snaps", nil)); len(got) != 0 {
		t.Fatalf("org A sees org B snaps: %v", got)
	}
	expect(t, authed(t, tokA, "DELETE", "/v1/snaps/secret-tool", nil), http.StatusNotFound, "not_found")
	// The same id in another org is an independent approval.
	expect(t, authed(t, tokA, "PUT", "/v1/snaps/secret-tool", snapBody("9")), http.StatusCreated, "")
	got := items(t, authed(t, tokB, "GET", "/v1/snaps", nil))
	if len(got) != 1 || got[0]["version"] != "1" {
		t.Fatalf("org B snaps = %v", got)
	}

	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, orgA, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM team_snaps WHERE org_id = $1`, orgB).Scan(&n); err != nil || n != 0 {
			return fmt.Errorf("org A sees %d org B snaps (err %v)", n, err)
		}
		tag, err := tx.Exec(ctx, `UPDATE team_snaps SET version = 'x' WHERE org_id = $1`, orgB)
		if err != nil || tag.RowsAffected() != 0 {
			return fmt.Errorf("org B snaps updatable from A: %v %v", tag, err)
		}
		// In a savepoint: the expected failure would abort the outer transaction.
		sp, err := tx.Begin(ctx)
		if err != nil {
			return err
		}
		defer sp.Rollback(ctx) //nolint:errcheck
		_, err = sp.Exec(ctx,
			`INSERT INTO team_snaps (org_id, snap_id, name, version, git_url, commit_sha, manifest_sha256, approved_by)
			 VALUES ($1, 'planted', 'p', '1', 'https://e.com/p', $2, $3, 'a')`,
			orgB, strings.Repeat("a", 40), strings.Repeat("b", 64))
		if err == nil || !strings.Contains(err.Error(), "row-level security") {
			return fmt.Errorf("cross-org insert: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := appPool.QueryRow(ctx, `SELECT count(*) FROM team_snaps`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("unscoped query sees %d snaps (err %v)", n, err)
	}
}

func TestSnapCatalogValidation(t *testing.T) {
	requireDB(t)
	tok, _ := devToken(t, map[string]any{"org_name": "snaps-validate", "user_id": "val"})
	with := func(k string, v any) map[string]any {
		b := snapBody("1")
		if v == nil {
			delete(b, k)
		} else {
			b[k] = v
		}
		return b
	}
	cases := []struct {
		name, path string
		body       any
		code       string
	}{
		{"uppercase id", "/v1/snaps/Go", snapBody("1"), "invalid_input"},
		{"id too long", "/v1/snaps/" + strings.Repeat("a", 41), snapBody("1"), "invalid_input"},
		{"id leading dash", "/v1/snaps/-go", snapBody("1"), "invalid_input"},
		{"http url", "/v1/snaps/go", with("git_url", "http://github.com/a/b.git"), "invalid_input"},
		{"file url", "/v1/snaps/go", with("git_url", "file:///tmp/x.git"), "invalid_input"},
		{"local path", "/v1/snaps/go", with("git_url", "/tmp/x.git"), "invalid_input"},
		{"ext transport", "/v1/snaps/go", with("git_url", "ext::sh -c touch% /tmp/p"), "invalid_input"},
		{"creds in url", "/v1/snaps/go", with("git_url", "https://user:tok@github.com/a/b.git"), "invalid_input"},
		{"dash url", "/v1/snaps/go", with("git_url", "-oProxyCommand=x@h:p"), "invalid_input"},
		{"short commit", "/v1/snaps/go", with("commit_sha", strings.Repeat("a", 39)), "invalid_input"},
		{"upper commit", "/v1/snaps/go", with("commit_sha", strings.Repeat("A", 40)), "invalid_input"},
		{"bad sha256", "/v1/snaps/go", with("manifest_sha256", strings.Repeat("g", 64)), "invalid_input"},
		{"missing sha256", "/v1/snaps/go", with("manifest_sha256", nil), "invalid_input"},
		{"missing permissions", "/v1/snaps/go", with("permissions", nil), "invalid_input"},
		{"bad fs", "/v1/snaps/go", with("permissions", map[string]any{"fs": "root"}), "invalid_input"},
		{"secret value", "/v1/snaps/go", with("permissions", map[string]any{"secrets": []string{"ghp_" + strings.Repeat("x", 30) + " value"}}), "invalid_input"},
		{"unknown permission", "/v1/snaps/go", with("permissions", map[string]any{"exec": true}), "unknown_field"},
		{"code field", "/v1/snaps/go", with("code", "fn main() {}"), "unknown_field"},
		{"bad ref", "/v1/snaps/go", with("git_ref", "a..b"), "invalid_input"},
		{"blank name", "/v1/snaps/go", with("name", " "), "invalid_input"},
		{"multiline note", "/v1/snaps/go", with("note", "a\nb"), "invalid_input"},
		{"token in note", "/v1/snaps/go", with("note", "use ghp_"+strings.Repeat("x", 30)), "content_not_allowed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := authed(t, tok, "PUT", c.path, c.body)
			if r.Status/100 != 4 {
				t.Fatalf("status %d; body %v", r.Status, r.Body)
			}
			e, _ := r.Body["error"].(map[string]any)
			if e == nil || e["code"] != c.code {
				t.Fatalf("error = %v, want %s", r.Body, c.code)
			}
		})
	}
	expect(t, authed(t, tok, "PUT", "/v1/snaps/go", with("git_url", "git@github.com:acme/go.git")), http.StatusCreated, "")
	expect(t, authed(t, tok, "PUT", "/v1/snaps/go2", with("git_url", "ssh://git@github.com/acme/go.git")), http.StatusCreated, "")
	expect(t, authed(t, tok, "DELETE", "/v1/snaps/Bad", nil), http.StatusBadRequest, "invalid_input")
}

func TestSnapCatalogEvents(t *testing.T) {
	requireDB(t)
	base := newServer(t, api.Config{Heartbeat: time.Hour})
	tok, _ := devToken(t, map[string]any{"org_name": "snaps-sse", "user_id": "sam"})
	ch, stop := openStream(t, base, tok, nil)
	defer stop()
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "connected" })

	expect(t, authed(t, tok, "PUT", "/v1/snaps/go", snapBody("1.0.0")), http.StatusCreated, "")
	m := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if m.Event != "snap.updated" {
		t.Fatalf("event = %+v", m)
	}
	data := eventData(t, m)["data"].(map[string]any)
	if data["snap_id"] != "go" || data["version"] != "1.0.0" || data["git_url"] != nil {
		t.Fatalf("event data = %v", data)
	}
	expect(t, authed(t, tok, "DELETE", "/v1/snaps/go", nil), http.StatusOK, "")
	m = waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if m.Event != "snap.removed" || eventData(t, m)["data"].(map[string]any)["snap_id"] != "go" {
		t.Fatalf("event = %+v", m)
	}
}

// The desktop resumes with Last-Event-ID after a dropped connection: snap changes made while it
// was away are replayed in order, each with the id to resume from next time.
func TestSnapCatalogEventsResume(t *testing.T) {
	requireDB(t)
	base := newServer(t, api.Config{Heartbeat: time.Hour})
	tok, _ := devToken(t, map[string]any{"org_name": "snaps-resume", "user_id": "sam"})
	ch, stop := openStream(t, base, tok, nil)
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "connected" })
	expect(t, authed(t, tok, "PUT", "/v1/snaps/go", snapBody("1.0.0")), http.StatusCreated, "")
	first := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	stop()
	if first.Event != "snap.updated" || first.ID == "" {
		t.Fatalf("first = %+v", first)
	}

	expect(t, authed(t, tok, "PUT", "/v1/snaps/go", snapBody("1.1.0")), http.StatusOK, "")
	expect(t, authed(t, tok, "DELETE", "/v1/snaps/go", nil), http.StatusOK, "")

	ch, stop = openStream(t, base, tok, map[string]string{"Last-Event-ID": first.ID})
	defer stop()
	a := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	b := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if a.Event != "snap.updated" || eventData(t, a)["data"].(map[string]any)["version"] != "1.1.0" ||
		b.Event != "snap.removed" || eventData(t, b)["data"].(map[string]any)["snap_id"] != "go" {
		t.Fatalf("replay = %+v / %+v", a, b)
	}
	var ids [3]int64
	for i, m := range []sseMsg{first, a, b} {
		if _, err := fmt.Sscan(m.ID, &ids[i]); err != nil {
			t.Fatalf("id %q: %v", m.ID, err)
		}
	}
	if !(ids[0] < ids[1] && ids[1] < ids[2]) {
		t.Fatalf("ids not increasing: %v", ids)
	}
}
