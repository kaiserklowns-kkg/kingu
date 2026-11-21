package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

// Migrations run as a schema-owning role; the API runs as a role that only
// got data access through db.GrantApp, and everything still works under RLS.
func TestSplitMigrationAndServingRoles(t *testing.T) {
	requireDB(t)
	ctx := context.Background()
	for _, stmt := range []string{
		`CREATE ROLE kingu_owner LOGIN NOSUPERUSER NOBYPASSRLS`,
		`CREATE ROLE kingu_srv LOGIN NOSUPERUSER NOBYPASSRLS`,
		`CREATE DATABASE kingu_split OWNER kingu_owner`,
	} {
		if _, err := adminPool.Exec(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	owner, err := db.Open(ctx, pgDSN("kingu_owner", "kingu_split"))
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	srvPool, err := db.Open(ctx, pgDSN("kingu_srv", "kingu_split"))
	if err != nil {
		t.Fatal(err)
	}
	defer srvPool.Close()
	if err := db.Migrate(ctx, owner, quietLogger()); err != nil {
		t.Fatal(err)
	}
	if err := db.GrantApp(ctx, owner, "kingu_srv"); err != nil {
		t.Fatal(err)
	}
	if err := db.GrantApp(ctx, owner, "kingu_owner"); err != nil { // same role: no-op
		t.Fatal(err)
	}

	// The serving role cannot change the schema or the migration history.
	for _, stmt := range []string{
		`DROP TABLE tasks`, `ALTER TABLE tasks ADD COLUMN x int`, `TRUNCATE audit_log`,
		`DELETE FROM goose_db_version`, `CREATE TABLE evil (id int)`,
	} {
		if _, err := srvPool.Exec(ctx, stmt); err == nil {
			t.Errorf("serving role could run %q", stmt)
		} else if !strings.Contains(err.Error(), "denied") && !strings.Contains(err.Error(), "must be owner") {
			t.Errorf("%q: unexpected error %v", stmt, err)
		}
	}

	// The API works end to end as the serving role, with the shared limiter.
	srv := api.New(srvPool, quietLogger(), api.Config{Dev: true, RateLimitStore: "postgres"})
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srv.Start(sctx)
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	r, _ := call{base: hs.URL, method: "POST", path: "/v1/dev/tokens", body: map[string]any{"org_name": "split", "user_id": "ola"}}.do(t)
	expect(t, r, http.StatusCreated, "")
	tok := r.Body["token"].(string)
	r, _ = call{base: hs.URL, method: "POST", path: "/v1/projects", token: tok, body: map[string]any{"name": "app", "repo_url": "https://github.com/a/app.git"}}.do(t)
	expect(t, r, http.StatusCreated, "")
	proj := r.Body["id"].(string)
	r, _ = call{base: hs.URL, method: "POST", path: "/v1/projects/" + proj + "/tasks", token: tok, body: map[string]any{"title": "t"}}.do(t)
	expect(t, r, http.StatusCreated, "")
	r, _ = call{base: hs.URL, method: "GET", path: "/v1/audit", token: tok}.do(t)
	if n := len(items(t, r)); n < 3 {
		t.Fatalf("audit = %d entries", n)
	}
	if _, err := db.PruneEvents(ctx, srvPool); err != nil {
		t.Fatalf("pruner as serving role: %v", err)
	}
	// Tables are still forced under RLS for the serving role: no org, no rows.
	var n int
	if err := srvPool.QueryRow(ctx, `SELECT count(*) FROM tasks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tasks visible without an org: %d %v", n, err)
	}
	srvPool.Close()
	owner.Close()
	_, _ = adminPool.Exec(ctx, `DROP DATABASE kingu_split WITH (FORCE)`)
}
