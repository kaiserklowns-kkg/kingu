package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

func skillBody(commit string) map[string]any {
	return map[string]any{
		"description":    "Fill PDF forms when the user asks",
		"git_url":        "https://github.com/acme/skills.git",
		"git_ref":        "main",
		"path":           "skills/pdf",
		"commit_sha":     strings.Repeat(commit, 40),
		"content_sha256": strings.Repeat("b", 64),
		"note":           "ใช้กับเอกสาร PDF ของทีม",
	}
}

func TestTeamSkillsSharing(t *testing.T) {
	requireDB(t)
	owner, org := devToken(t, map[string]any{"org_name": "skills-roles", "user_id": "olive"})
	dev, _ := devToken(t, map[string]any{"org_id": org, "user_id": "dan", "role": "dev"})
	dev2, _ := devToken(t, map[string]any{"org_id": org, "user_id": "dee", "role": "dev"})
	viewer, _ := devToken(t, map[string]any{"org_id": org, "user_id": "vic", "role": "viewer"})

	// Any member who can write shares; the server records who.
	r := authed(t, dev, "PUT", "/v1/skills/pdf", skillBody("a"))
	expect(t, r, http.StatusCreated, "")
	if r.Body["shared_by"] != "dan" || r.Body["path"] != "skills/pdf" || r.Body["commit_sha"] != strings.Repeat("a", 40) {
		t.Fatalf("put = %v", r.Body)
	}
	// Viewers read but never write.
	r = authed(t, viewer, "GET", "/v1/skills", nil)
	expect(t, r, http.StatusOK, "")
	if got := items(t, r); len(got) != 1 || got[0]["skill_name"] != "pdf" || got[0]["git_ref"] != "main" {
		t.Fatalf("list = %v", got)
	}
	expect(t, authed(t, viewer, "PUT", "/v1/skills/notes", skillBody("a")), http.StatusForbidden, "forbidden")
	expect(t, authed(t, viewer, "DELETE", "/v1/skills/pdf", nil), http.StatusForbidden, "forbidden")

	// The sharer updates their skill; another dev may not replace or remove it, an owner may.
	body := skillBody("c")
	delete(body, "git_ref")
	delete(body, "note")
	body["path"] = ""
	r = authed(t, dev, "PUT", "/v1/skills/pdf", body)
	expect(t, r, http.StatusOK, "")
	if r.Body["git_ref"] != nil || r.Body["note"] != nil || r.Body["path"] != "" {
		t.Fatalf("update = %v", r.Body)
	}
	expect(t, authed(t, dev2, "PUT", "/v1/skills/pdf", skillBody("d")), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev2, "DELETE", "/v1/skills/pdf", nil), http.StatusForbidden, "forbidden")
	r = authed(t, owner, "PUT", "/v1/skills/pdf", skillBody("e"))
	expect(t, r, http.StatusOK, "")
	if r.Body["shared_by"] != "olive" {
		t.Fatalf("owner replace = %v", r.Body)
	}
	expect(t, authed(t, owner, "DELETE", "/v1/skills/pdf", nil), http.StatusOK, "")
	expect(t, authed(t, owner, "DELETE", "/v1/skills/pdf", nil), http.StatusNotFound, "not_found")

	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, org, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action IN ('skill.share', 'skill.unshare')`).Scan(&n); err != nil {
			return err
		}
		if n != 4 {
			return fmt.Errorf("audit rows = %d, want 4", n)
		}
		// Events for open Skills views: 3 shares (create, update, owner's replace) + the removal.
		rows, err := tx.Query(ctx, `SELECT kind, payload::text FROM org_events WHERE kind LIKE 'skill.%'`)
		if err != nil {
			return err
		}
		defer rows.Close()
		kinds := map[string]int{}
		for rows.Next() {
			var kind, payload string
			if err := rows.Scan(&kind, &payload); err != nil {
				return err
			}
			kinds[kind]++
			if !strings.Contains(payload, `"skill_name": "pdf"`) || strings.Contains(payload, "note") || strings.Contains(payload, "git_url") {
				return fmt.Errorf("event payload = %s", payload)
			}
		}
		if kinds["skill.shared"] != 3 || kinds["skill.removed"] != 1 {
			return fmt.Errorf("event kinds = %v", kinds)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTeamSkillsRLSIsolation(t *testing.T) {
	requireDB(t)
	tokA, _ := devToken(t, map[string]any{"org_name": "skills-a", "user_id": "a"})
	tokB, _ := devToken(t, map[string]any{"org_name": "skills-b", "user_id": "b"})
	expect(t, authed(t, tokB, "PUT", "/v1/skills/secret", skillBody("a")), http.StatusCreated, "")
	if got := items(t, authed(t, tokA, "GET", "/v1/skills", nil)); len(got) != 0 {
		t.Fatalf("org A sees org B skills: %v", got)
	}
	expect(t, authed(t, tokA, "DELETE", "/v1/skills/secret", nil), http.StatusNotFound, "not_found")
	expect(t, authed(t, tokA, "PUT", "/v1/skills/secret", skillBody("f")), http.StatusCreated, "")
	if got := items(t, authed(t, tokB, "GET", "/v1/skills", nil)); len(got) != 1 || got[0]["commit_sha"] != strings.Repeat("a", 40) {
		t.Fatalf("org B skills = %v", got)
	}
}

func TestTeamSkillsValidation(t *testing.T) {
	requireDB(t)
	tok, _ := devToken(t, map[string]any{"org_name": "skills-validate", "user_id": "val"})
	with := func(k string, v any) map[string]any {
		b := skillBody("a")
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
		{"uppercase name", "/v1/skills/Pdf", skillBody("a"), "invalid_input"},
		{"double hyphen", "/v1/skills/a--b", skillBody("a"), "invalid_input"},
		{"trailing hyphen", "/v1/skills/a-", skillBody("a"), "invalid_input"},
		{"name too long", "/v1/skills/" + strings.Repeat("a", 65), skillBody("a"), "invalid_input"},
		{"file url", "/v1/skills/pdf", with("git_url", "file:///tmp/x.git"), "invalid_input"},
		{"local path", "/v1/skills/pdf", with("git_url", "/tmp/x.git"), "invalid_input"},
		{"creds in url", "/v1/skills/pdf", with("git_url", "https://user:tok@github.com/a/b.git"), "invalid_input"},
		{"dotdot path", "/v1/skills/pdf", with("path", "skills/../../x"), "invalid_input"},
		{"absolute path", "/v1/skills/pdf", with("path", "/etc"), "invalid_input"},
		{"backslash path", "/v1/skills/pdf", with("path", "a\\b"), "invalid_input"},
		{"short commit", "/v1/skills/pdf", with("commit_sha", strings.Repeat("a", 39)), "invalid_input"},
		{"bad sha256", "/v1/skills/pdf", with("content_sha256", strings.Repeat("g", 64)), "invalid_input"},
		{"missing description", "/v1/skills/pdf", with("description", nil), "invalid_input"},
		{"long description", "/v1/skills/pdf", with("description", strings.Repeat("x", 1025)), "invalid_input"},
		{"token in description", "/v1/skills/pdf", with("description", "use ghp_"+strings.Repeat("x", 30)), "content_not_allowed"},
		{"bad ref", "/v1/skills/pdf", with("git_ref", "a..b"), "invalid_input"},
		{"files field", "/v1/skills/pdf", with("files", []string{"SKILL.md"}), "unknown_field"},
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
	expect(t, authed(t, tok, "PUT", "/v1/skills/pdf", with("git_url", "git@github.com:acme/skills.git")), http.StatusCreated, "")
}
