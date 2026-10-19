package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

const artID = "0123456789abcdef"

func artifactBody(title, html string, version int) map[string]any {
	return map[string]any{
		"title": title, "description": "สรุปผล benchmark", "format": "html", "version": version, "html": html,
	}
}

const pageHTML = "<!doctype html><title>Bench</title><h1>ผลการทดสอบ</h1><script>console.log(1)</script>"

func TestArtifactShareRolesAndUpdates(t *testing.T) {
	requireDB(t)
	owner, org := devToken(t, map[string]any{"org_name": "artifacts-roles", "user_id": "olive"})
	lead, _ := devToken(t, map[string]any{"org_id": org, "user_id": "leo", "role": "lead"})
	dev, _ := devToken(t, map[string]any{"org_id": org, "user_id": "dan", "role": "dev"})
	dev2, _ := devToken(t, map[string]any{"org_id": org, "user_id": "dora", "role": "dev"})
	viewer, _ := devToken(t, map[string]any{"org_id": org, "user_id": "vic", "role": "viewer"})

	// A dev shares: 201, server-computed hash and size, no html echoed.
	r := authed(t, dev, "PUT", "/v1/artifacts/"+artID, artifactBody("Bench", pageHTML, 1))
	expect(t, r, http.StatusCreated, "")
	sum := sha256.Sum256([]byte(pageHTML))
	if r.Body["shared_by"] != "dan" || r.Body["sha256"] != hex.EncodeToString(sum[:]) ||
		r.Body["size_bytes"] != float64(len(pageHTML)) || r.Body["version"] != float64(1) || r.Body["format"] != "html" {
		t.Fatalf("put = %v", r.Body)
	}
	if _, ok := r.Body["html"]; ok {
		t.Fatalf("put echoes html: %v", r.Body)
	}

	// Viewers read (list without html, get with html) but never write.
	r = authed(t, viewer, "GET", "/v1/artifacts", nil)
	expect(t, r, http.StatusOK, "")
	got := items(t, r)
	if len(got) != 1 || got[0]["artifact_id"] != artID || got[0]["title"] != "Bench" || got[0]["description"] != "สรุปผล benchmark" {
		t.Fatalf("list = %v", got)
	}
	if _, ok := got[0]["html"]; ok {
		t.Fatalf("list carries html: %v", got[0])
	}
	r = authed(t, viewer, "GET", "/v1/artifacts/"+artID, nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["html"] != pageHTML || r.Body["shared_by"] != "dan" {
		t.Fatalf("get = %v", r.Body)
	}
	expect(t, authed(t, viewer, "GET", "/v1/artifacts/ffffffffffffffff", nil), http.StatusNotFound, "not_found")
	expect(t, authed(t, viewer, "PUT", "/v1/artifacts/"+artID, artifactBody("x", pageHTML, 2)), http.StatusForbidden, "forbidden")
	expect(t, authed(t, viewer, "PUT", "/v1/artifacts/1111111111111111", artifactBody("x", pageHTML, 1)), http.StatusForbidden, "forbidden")
	expect(t, authed(t, viewer, "DELETE", "/v1/artifacts/"+artID, nil), http.StatusForbidden, "forbidden")

	// Another dev may not replace or delete someone else's share.
	expect(t, authed(t, dev2, "PUT", "/v1/artifacts/"+artID, artifactBody("Hijack", pageHTML, 9)), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev2, "DELETE", "/v1/artifacts/"+artID, nil), http.StatusForbidden, "forbidden")

	// The sharer updates (200); shared_by stays.
	v2 := pageHTML + "<p>v2</p>"
	r = authed(t, dev, "PUT", "/v1/artifacts/"+artID, artifactBody("Bench v2", v2, 2))
	expect(t, r, http.StatusOK, "")
	if r.Body["version"] != float64(2) || r.Body["size_bytes"] != float64(len(v2)) {
		t.Fatalf("update = %v", r.Body)
	}
	// A lead may too; the original sharer is kept.
	body := artifactBody("Bench v3", v2, 3)
	body["description"] = nil
	body["format"] = "markdown"
	r = authed(t, lead, "PUT", "/v1/artifacts/"+artID, body)
	expect(t, r, http.StatusOK, "")
	if r.Body["shared_by"] != "dan" || r.Body["description"] != nil || r.Body["format"] != "markdown" {
		t.Fatalf("lead update = %v", r.Body)
	}

	// The owner shares another; the list is newest first.
	expect(t, authed(t, owner, "PUT", "/v1/artifacts/aaaaaaaaaaaaaaaa", artifactBody("Owner page", pageHTML, 1)), http.StatusCreated, "")
	got = items(t, authed(t, dev2, "GET", "/v1/artifacts", nil))
	if len(got) != 2 || got[0]["artifact_id"] != "aaaaaaaaaaaaaaaa" {
		t.Fatalf("list order = %v", got)
	}

	// Delete: the owner (admin) removes dan's; dan's own delete of the gone one is 404.
	expect(t, authed(t, owner, "DELETE", "/v1/artifacts/"+artID, nil), http.StatusOK, "")
	expect(t, authed(t, dev, "DELETE", "/v1/artifacts/"+artID, nil), http.StatusNotFound, "not_found")
	r = authed(t, owner, "DELETE", "/v1/artifacts/aaaaaaaaaaaaaaaa", nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["artifact_id"] != "aaaaaaaaaaaaaaaa" || r.Body["deleted"] != true {
		t.Fatalf("delete = %v", r.Body)
	}

	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, org, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action IN ('artifact.share', 'artifact.remove')`).Scan(&n); err != nil {
			return err
		}
		// 4 shares (create, 2 updates, owner's) + 2 removals.
		if n != 6 {
			return fmt.Errorf("audit rows = %d, want 6", n)
		}
		// Events: metadata only, never the page.
		rows, err := tx.Query(ctx, `SELECT kind, payload::text FROM org_events WHERE kind LIKE 'artifact.%'`)
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
			if strings.Contains(payload, `"html":`) || strings.Contains(payload, "<h1>") || strings.Contains(payload, "ผลการทดสอบ") || !strings.Contains(payload, "artifact_id") {
				return fmt.Errorf("event payload = %s", payload)
			}
		}
		if kinds["artifact.shared"] != 4 || kinds["artifact.removed"] != 2 {
			return fmt.Errorf("event kinds = %v", kinds)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestArtifactValidation(t *testing.T) {
	requireDB(t)
	tok, _ := devToken(t, map[string]any{"org_name": "artifacts-validation", "user_id": "val"})
	put := func(id string, body any) resp { return authed(t, tok, "PUT", "/v1/artifacts/"+id, body) }

	expect(t, put("NOT-HEX", artifactBody("x", pageHTML, 1)), http.StatusBadRequest, "invalid_input")
	expect(t, put("0123456789abcde", artifactBody("x", pageHTML, 1)), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, tok, "GET", "/v1/artifacts/xyz", nil), http.StatusBadRequest, "invalid_input")
	expect(t, put(artID, artifactBody("x", "", 1)), http.StatusBadRequest, "invalid_input")
	expect(t, put(artID, artifactBody("", pageHTML, 1)), http.StatusBadRequest, "invalid_input")
	expect(t, put(artID, artifactBody(strings.Repeat("ก", 201), pageHTML, 1)), http.StatusBadRequest, "invalid_input")
	expect(t, put(artID, artifactBody("x", pageHTML, 0)), http.StatusBadRequest, "invalid_input")
	b := artifactBody("x", pageHTML, 1)
	b["format"] = "pdf"
	expect(t, put(artID, b), http.StatusBadRequest, "invalid_input")
	b = artifactBody("x", pageHTML, 1)
	b["description"] = strings.Repeat("a", 1001)
	expect(t, put(artID, b), http.StatusBadRequest, "invalid_input")
	b = artifactBody("x", pageHTML, 1)
	b["assets"] = []string{}
	expect(t, put(artID, b), http.StatusBadRequest, "unknown_field")

	// Over 2 MiB of page (but within the route's body cap): 413.
	expect(t, put(artID, artifactBody("x", strings.Repeat("a", api.MaxArtifactHTMLBytes+1), 1)), http.StatusRequestEntityTooLarge, "body_too_large")
	// Over the route's body cap: 413 before any decoding.
	expect(t, put(artID, artifactBody("x", strings.Repeat("a", api.MaxArtifactBodyBytes+1), 1)), http.StatusRequestEntityTooLarge, "body_too_large")
	// Exactly 2 MiB is fine (well over the 64 KB metadata cap).
	expect(t, put(artID, artifactBody("big", strings.Repeat("a", api.MaxArtifactHTMLBytes), 1)), http.StatusCreated, "")

	// A page that looks like it holds a credential is refused.
	leak := pageHTML + "<script>const token = 'ghp_" + strings.Repeat("A", 36) + "'</script>"
	expect(t, put("bbbbbbbbbbbbbbbb", artifactBody("leak", leak, 1)), http.StatusUnprocessableEntity, "content_not_allowed")
	expect(t, put("bbbbbbbbbbbbbbbb", artifactBody("AKIA"+strings.Repeat("B", 16), pageHTML, 1)), http.StatusUnprocessableEntity, "content_not_allowed")

	// Other routes keep the 64 KB cap.
	expect(t, authed(t, tok, "PUT", "/v1/snaps/go", map[string]any{"name": strings.Repeat("a", api.MaxBodyBytes)}), http.StatusRequestEntityTooLarge, "body_too_large")
}

func TestArtifactRLSIsolation(t *testing.T) {
	requireDB(t)
	tokA, orgA := devToken(t, map[string]any{"org_name": "artifacts-a", "user_id": "a"})
	tokB, orgB := devToken(t, map[string]any{"org_name": "artifacts-b", "user_id": "b"})
	expect(t, authed(t, tokB, "PUT", "/v1/artifacts/"+artID, artifactBody("B secret page", pageHTML, 1)), http.StatusCreated, "")

	if got := items(t, authed(t, tokA, "GET", "/v1/artifacts", nil)); len(got) != 0 {
		t.Fatalf("org A sees org B artifacts: %v", got)
	}
	expect(t, authed(t, tokA, "GET", "/v1/artifacts/"+artID, nil), http.StatusNotFound, "not_found")
	expect(t, authed(t, tokA, "DELETE", "/v1/artifacts/"+artID, nil), http.StatusNotFound, "not_found")
	// The same id in another org is its own share, and B's stays untouched.
	expect(t, authed(t, tokA, "PUT", "/v1/artifacts/"+artID, artifactBody("A page", pageHTML, 5)), http.StatusCreated, "")
	r := authed(t, tokB, "GET", "/v1/artifacts/"+artID, nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["title"] != "B secret page" || r.Body["version"] != float64(1) {
		t.Fatalf("org B artifact = %v", r.Body)
	}

	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, orgA, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM team_artifacts WHERE org_id = $1`, orgB).Scan(&n); err != nil || n != 0 {
			return fmt.Errorf("org A sees %d org B artifacts (err %v)", n, err)
		}
		tag, err := tx.Exec(ctx, `UPDATE team_artifacts SET title = 'x' WHERE org_id = $1`, orgB)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 0 {
			return fmt.Errorf("org A updated %d org B rows", tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
