package api_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

// snapZip builds a package from name/body pairs.
func snapZip(t *testing.T, files ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i+1 < len(files); i += 2 {
		w, err := zw.Create(files[i])
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(files[i+1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sumHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func publishBody(pkg []byte) map[string]any {
	return map[string]any{
		"name":           "Go tools",
		"description":    "ตัวช่วย Go ของทีม",
		"sha256":         strings.Repeat("d", 64),
		"permissions":    map[string]any{"network": false, "fs": "worktree", "secrets": []string{"GO_TOKEN"}},
		"package":        base64.StdEncoding.EncodeToString(pkg),
		"package_sha256": sumHex(pkg),
	}
}

func goodPackage(t *testing.T, extra string) []byte {
	return snapZip(t, "snap.toml", "id = \"go\"\nversion = \"1.0.0\"\n", "bin/run.sh", "echo "+extra)
}

// download fetches a package raw (the shared helpers decode JSON).
func download(t *testing.T, token, path string) (int, http.Header, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, res.Header, b
}

func TestSnapLibraryPublishFlow(t *testing.T) {
	requireDB(t)
	owner, org := devToken(t, map[string]any{"org_name": "snaplib-roles", "user_id": "olive"})
	lead, _ := devToken(t, map[string]any{"org_id": org, "user_id": "leo", "role": "lead"})
	dev, _ := devToken(t, map[string]any{"org_id": org, "user_id": "dan", "role": "dev"})
	viewer, _ := devToken(t, map[string]any{"org_id": org, "user_id": "vic", "role": "viewer"})

	pkg := goodPackage(t, "1")
	const v1 = "/v1/snap-library/go/versions/1.0.0"
	r := authed(t, owner, "PUT", v1, publishBody(pkg))
	expect(t, r, http.StatusCreated, "")
	if r.Body["snap_id"] != "go" || r.Body["version"] != "1.0.0" || r.Body["published_by"] != "olive" ||
		r.Body["package_sha256"] != sumHex(pkg) || r.Body["package_size"] != float64(len(pkg)) ||
		r.Body["sha256"] != strings.Repeat("d", 64) || r.Body["yanked"] != false ||
		r.Body["yanked_by"] != nil || r.Body["yanked_at"] != nil || r.Body["yank_reason"] != nil {
		t.Fatalf("publish = %v", r.Body)
	}
	if _, has := r.Body["package"]; has {
		t.Fatalf("publish response carries the package: %v", r.Body)
	}
	if perms := r.Body["permissions"].(map[string]any); perms["fs"] != "worktree" || len(perms["secrets"].([]any)) != 1 {
		t.Fatalf("permissions = %v", perms)
	}

	// Same bytes again: idempotent 200, the stored row (published_by unchanged).
	r = authed(t, lead, "PUT", v1, publishBody(pkg))
	expect(t, r, http.StatusOK, "")
	if r.Body["published_by"] != "olive" || r.Body["package_sha256"] != sumHex(pkg) {
		t.Fatalf("republish = %v", r.Body)
	}
	// Other bytes under a published version: immutable.
	expect(t, authed(t, owner, "PUT", v1, publishBody(goodPackage(t, "other"))), http.StatusConflict, "conflict")

	// A lead publishes a second version.
	pkg2 := goodPackage(t, "2")
	expect(t, authed(t, lead, "PUT", "/v1/snap-library/go/versions/1.1.0", publishBody(pkg2)), http.StatusCreated, "")
	expect(t, authed(t, lead, "PUT", "/v1/snap-library/alpha/versions/0.1.0+b.1", publishBody(pkg2)), http.StatusCreated, "")

	// Members and viewers list and download; they cannot publish or yank.
	for _, tok := range []string{dev, viewer} {
		got := items(t, authed(t, tok, "GET", "/v1/snap-library", nil))
		if len(got) != 3 || got[0]["snap_id"] != "alpha" || got[1]["version"] != "1.1.0" || got[2]["version"] != "1.0.0" {
			t.Fatalf("list = %v", got)
		}
		for _, it := range got {
			if _, has := it["package"]; has {
				t.Fatalf("list carries a package: %v", it)
			}
		}
		status, h, body := download(t, tok, v1+"/package")
		if status != http.StatusOK || !bytes.Equal(body, pkg) || h.Get("Content-Type") != "application/zip" ||
			h.Get("X-Kingu-Package-Sha256") != sumHex(pkg) || h.Get("X-Kingu-Snap-Sha256") != strings.Repeat("d", 64) {
			t.Fatalf("download = %d %v (%d bytes)", status, h, len(body))
		}
		expect(t, authed(t, tok, "PUT", "/v1/snap-library/go/versions/9.9.9", publishBody(pkg)), http.StatusForbidden, "forbidden")
		expect(t, authed(t, tok, "POST", v1+"/yank", map[string]any{"yanked": true}), http.StatusForbidden, "forbidden")
	}
	expect(t, authed(t, dev, "GET", "/v1/snap-library/go/versions/7.0.0/package", nil), http.StatusNotFound, "not_found")
	expect(t, authed(t, dev, "GET", "/v1/snap-library/nope/versions/1.0.0/package", nil), http.StatusNotFound, "not_found")
	expect(t, authed(t, dev, "GET", "/v1/snap-library/Go/versions/1.0.0/package", nil), http.StatusBadRequest, "invalid_input")

	// Yank: stays listed and downloadable, marked yanked.
	r = authed(t, lead, "POST", v1+"/yank", map[string]any{"yanked": true, "reason": "breaks on Go 1.27"})
	expect(t, r, http.StatusOK, "")
	if r.Body["yanked"] != true || r.Body["yanked_by"] != "leo" || r.Body["yank_reason"] != "breaks on Go 1.27" || r.Body["yanked_at"] == nil {
		t.Fatalf("yank = %v", r.Body)
	}
	got := items(t, authed(t, viewer, "GET", "/v1/snap-library", nil))
	if got[2]["version"] != "1.0.0" || got[2]["yanked"] != true || got[1]["yanked"] != false {
		t.Fatalf("list after yank = %v", got)
	}
	if status, _, body := download(t, viewer, v1+"/package"); status != http.StatusOK || !bytes.Equal(body, pkg) {
		t.Fatalf("yanked download = %d", status)
	}
	// Republishing a yanked version's bytes still returns the stored (yanked) row.
	if r = authed(t, owner, "PUT", v1, publishBody(pkg)); r.Status != http.StatusOK || r.Body["yanked"] != true {
		t.Fatalf("republish yanked = %v", r)
	}
	expect(t, authed(t, owner, "POST", v1+"/yank", map[string]any{"yanked": true, "reason": "a\nb"}), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, owner, "POST", v1+"/yank", map[string]any{"yanked": true, "reason": strings.Repeat("a", 201)}), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, owner, "POST", v1+"/yank", map[string]any{"reason": "x"}), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, owner, "POST", "/v1/snap-library/go/versions/7.0.0/yank", map[string]any{"yanked": true}), http.StatusNotFound, "not_found")

	r = authed(t, owner, "POST", v1+"/yank", map[string]any{"yanked": false})
	expect(t, r, http.StatusOK, "")
	if r.Body["yanked"] != false || r.Body["yanked_by"] != nil || r.Body["yanked_at"] != nil || r.Body["yank_reason"] != nil {
		t.Fatalf("unyank = %v", r.Body)
	}
	if got := items(t, authed(t, dev, "GET", "/v1/snap-library", nil)); got[2]["yanked"] != false {
		t.Fatalf("list after unyank = %v", got)
	}

	// Audit: 3 publishes (not the idempotent or refused ones), a yank, an unyank; metadata only.
	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, org, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT action, details::text FROM audit_log
			WHERE action LIKE 'snap.%' ORDER BY id`)
		if err != nil {
			return err
		}
		var actions []string
		for rows.Next() {
			var action, details string
			if err := rows.Scan(&action, &details); err != nil {
				return err
			}
			if strings.Contains(details, "package\"") || strings.Contains(details, base64.StdEncoding.EncodeToString(pkg)[:20]) {
				return fmt.Errorf("audit details carry the package: %s", details)
			}
			actions = append(actions, action)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		want := "snap.publish snap.publish snap.publish snap.yank snap.unyank"
		if strings.Join(actions, " ") != want {
			return fmt.Errorf("audit = %v, want %s", actions, want)
		}
		// The event feed: metadata only, never the package.
		var payloads []string
		evRows, err := tx.Query(ctx, `SELECT kind || ' ' || payload::text FROM org_events
			WHERE kind IN ('snap.published', 'snap.yanked') ORDER BY id`)
		if err != nil {
			return err
		}
		payloads, err = pgx.CollectRows(evRows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if len(payloads) != 5 {
			return fmt.Errorf("events = %v", payloads)
		}
		for _, p := range payloads {
			if strings.Contains(p, "package") || strings.Contains(p, "permissions") {
				return fmt.Errorf("event carries content: %s", p)
			}
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(strings.SplitN(payloads[0], " ", 2)[1]), &payload); err != nil {
			return err
		}
		if len(payload) != 6 || payload["snap_id"] != "go" || payload["version"] != "1.0.0" ||
			payload["sha256"] != strings.Repeat("d", 64) || payload["published_by"] != "olive" || payload["yanked"] != false {
			return fmt.Errorf("publish payload = %v", payload)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSnapLibraryEvents(t *testing.T) {
	requireDB(t)
	base := newServer(t, api.Config{Heartbeat: time.Hour})
	tok, _ := devToken(t, map[string]any{"org_name": "snaplib-sse", "user_id": "sam"})
	ch, stop := openStream(t, base, tok, nil)
	defer stop()
	waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Comment == "connected" })

	expect(t, authed(t, tok, "PUT", "/v1/snap-library/go/versions/1.0.0", publishBody(goodPackage(t, "e"))), http.StatusCreated, "")
	m := waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	data := eventData(t, m)["data"].(map[string]any)
	if m.Event != "snap.published" || data["snap_id"] != "go" || data["version"] != "1.0.0" || data["package"] != nil {
		t.Fatalf("event = %+v", m)
	}
	expect(t, authed(t, tok, "POST", "/v1/snap-library/go/versions/1.0.0/yank", map[string]any{"yanked": true}), http.StatusOK, "")
	m = waitFor(t, ch, 3*time.Second, func(m sseMsg) bool { return m.Event != "" })
	if m.Event != "snap.yanked" || eventData(t, m)["data"].(map[string]any)["yanked"] != true {
		t.Fatalf("event = %+v", m)
	}
}

func TestSnapLibraryRLSIsolation(t *testing.T) {
	requireDB(t)
	tokA, orgA := devToken(t, map[string]any{"org_name": "snaplib-a", "user_id": "a"})
	tokB, orgB := devToken(t, map[string]any{"org_name": "snaplib-b", "user_id": "b"})
	pkgB := goodPackage(t, "b")
	const path = "/v1/snap-library/secret-tool/versions/1.0.0"
	expect(t, authed(t, tokB, "PUT", path, publishBody(pkgB)), http.StatusCreated, "")

	if got := items(t, authed(t, tokA, "GET", "/v1/snap-library", nil)); len(got) != 0 {
		t.Fatalf("org A sees org B versions: %v", got)
	}
	expect(t, authed(t, tokA, "GET", path+"/package", nil), http.StatusNotFound, "not_found")
	expect(t, authed(t, tokA, "POST", path+"/yank", map[string]any{"yanked": true}), http.StatusNotFound, "not_found")
	// The same id and version in another org is independent (other bytes, no conflict).
	pkgA := goodPackage(t, "a")
	expect(t, authed(t, tokA, "PUT", path, publishBody(pkgA)), http.StatusCreated, "")
	if _, _, body := download(t, tokB, path+"/package"); !bytes.Equal(body, pkgB) {
		t.Fatal("org B package changed")
	}

	ctx := context.Background()
	err := db.WithOrg(ctx, appPool, orgA, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM team_snap_versions WHERE org_id = $1`, orgB).Scan(&n); err != nil || n != 0 {
			return fmt.Errorf("org A sees %d org B versions (err %v)", n, err)
		}
		tag, err := tx.Exec(ctx, `UPDATE team_snap_versions SET yanked = true WHERE org_id = $1`, orgB)
		if err != nil || tag.RowsAffected() != 0 {
			return fmt.Errorf("org B versions updatable from A: %v %v", tag, err)
		}
		sp, err := tx.Begin(ctx)
		if err != nil {
			return err
		}
		defer sp.Rollback(ctx) //nolint:errcheck
		_, err = sp.Exec(ctx,
			`INSERT INTO team_snap_versions (org_id, snap_id, version, name, sha256, package, package_sha256,
			                                 package_size, published_by)
			 VALUES ($1, 'planted', '1', 'p', $2, '\x00'::bytea, $2, 1, 'a')`,
			orgB, strings.Repeat("a", 64))
		if err == nil || !strings.Contains(err.Error(), "row-level security") {
			return fmt.Errorf("cross-org insert: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := appPool.QueryRow(ctx, `SELECT count(*) FROM team_snap_versions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("unscoped query sees %d versions (err %v)", n, err)
	}
}

func TestSnapLibraryValidation(t *testing.T) {
	requireDB(t)
	tok, _ := devToken(t, map[string]any{"org_name": "snaplib-validate", "user_id": "val"})
	good := goodPackage(t, "v")
	with := func(k string, v any) map[string]any {
		b := publishBody(good)
		if v == nil {
			delete(b, k)
		} else {
			b[k] = v
		}
		return b
	}
	pkgOf := func(pkg []byte) map[string]any { return publishBody(pkg) }
	big := make([]byte, api.MaxSnapPackageBytes+1)
	tooBig := map[string]any{
		"name": "big", "sha256": strings.Repeat("d", 64), "permissions": map[string]any{},
		"package": base64.StdEncoding.EncodeToString(big), "package_sha256": sumHex(big),
	}
	const p = "/v1/snap-library/go/versions/1.0.0"
	cases := []struct {
		name, path string
		body       any
		status     int
		code       string
	}{
		{"uppercase id", "/v1/snap-library/Go/versions/1.0.0", publishBody(good), 400, "invalid_input"},
		{"bad version", "/v1/snap-library/go/versions/-1", publishBody(good), 400, "invalid_input"},
		{"version too long", "/v1/snap-library/go/versions/" + strings.Repeat("1", 65), publishBody(good), 400, "invalid_input"},
		{"missing name", p, with("name", nil), 400, "invalid_input"},
		{"multiline name", p, with("name", "a\nb"), 400, "invalid_input"},
		{"long description", p, with("description", strings.Repeat("a", 501)), 400, "invalid_input"},
		{"token in description", p, with("description", "ghp_"+strings.Repeat("x", 30)), 422, "content_not_allowed"},
		{"bad sha256", p, with("sha256", strings.Repeat("D", 64)), 400, "invalid_input"},
		{"bad package_sha256", p, with("package_sha256", "abc"), 400, "invalid_input"},
		{"sha mismatch", p, with("package_sha256", strings.Repeat("0", 64)), 400, "invalid_input"},
		{"missing permissions", p, with("permissions", nil), 400, "invalid_input"},
		{"array permissions", p, with("permissions", []string{"x"}), 400, "invalid_input"},
		{"secret value", p, with("permissions", map[string]any{"secrets": []string{"ghp_" + strings.Repeat("x", 30) + " value"}}), 400, "invalid_input"},
		{"secret token as name", p, with("permissions", map[string]any{"secrets": []string{"ghp_" + strings.Repeat("x", 30)}}), 422, "content_not_allowed"},
		{"secrets not array", p, with("permissions", map[string]any{"secrets": "GO_TOKEN"}), 400, "invalid_input"},
		{"big permissions", p, with("permissions", map[string]any{"pad": strings.Repeat("a", 9000)}), 400, "invalid_input"},
		{"missing package", p, with("package", nil), 400, "invalid_input"},
		{"not base64", p, with("package", "!!!"), 400, "invalid_input"},
		{"bad zip", p, pkgOf([]byte("not a zip at all")), 400, "invalid_input"},
		{"dotdot entry", p, pkgOf(snapZip(t, "snap.toml", "x", "../evil", "x")), 400, "invalid_input"},
		{"absolute entry", p, pkgOf(snapZip(t, "snap.toml", "x", "/etc/x", "x")), 400, "invalid_input"},
		{"missing snap.toml", p, pkgOf(snapZip(t, "README.md", "x")), 400, "invalid_input"},
		{"too big", p, tooBig, 413, "body_too_large"},
		{"unknown field", p, with("code", "fn main() {}"), 400, "unknown_field"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			expect(t, authed(t, tok, "PUT", c.path, c.body), c.status, c.code)
		})
	}
	if got := items(t, authed(t, tok, "GET", "/v1/snap-library", nil)); len(got) != 0 {
		t.Fatalf("a refused publish was stored: %v", got)
	}
	r := authed(t, tok, "PUT", p, with("description", nil))
	expect(t, r, http.StatusCreated, "")
	if r.Body["description"] != "" {
		t.Fatalf("description = %v", r.Body["description"])
	}
}
