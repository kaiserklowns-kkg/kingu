package api_test

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

// adminOrg makes an org whose owner token is returned with tokens for a lead,
// a dev and a viewer (minted by the owner through POST /v1/tokens).
func adminOrg(t *testing.T, name string) (owner, lead, dev, viewer, orgID string) {
	t.Helper()
	owner, orgID = devToken(t, map[string]any{"org_name": name, "user_id": "olivia"})
	tok := map[string]string{}
	for _, m := range []struct{ user, role string }{{"leo", "lead"}, {"dana", "dev"}, {"vic", "viewer"}} {
		expect(t, authed(t, owner, "PUT", "/v1/members/"+m.user, map[string]any{"role": m.role}), http.StatusCreated, "")
		r := authed(t, owner, "POST", "/v1/tokens", map[string]any{"name": "laptop", "user_id": m.user})
		expect(t, r, http.StatusCreated, "")
		tok[m.user] = r.Body["token"].(string)
	}
	return owner, tok["leo"], tok["dana"], tok["vic"], orgID
}

func TestTokenManagement(t *testing.T) {
	requireDB(t)
	owner, _, dev, viewer, _ := adminOrg(t, "tokens-org")

	// A viewer may mint and revoke their own tokens, nobody else's.
	r := authed(t, viewer, "POST", "/v1/tokens", map[string]any{"name": "ci", "ttl_hours": 1})
	expect(t, r, http.StatusCreated, "")
	ci := r.Body["id"].(string)
	if r.Body["name"] != "ci" || r.Body["user_id"] != "vic" || r.Body["expires_at"] == nil {
		t.Fatalf("minted = %v", r.Body)
	}
	expect(t, authed(t, viewer, "POST", "/v1/tokens", map[string]any{"name": "x", "user_id": "dana"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev, "POST", "/v1/tokens", map[string]any{"name": "x", "user_id": "vic"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, owner, "POST", "/v1/tokens", map[string]any{"name": "x", "user_id": "nobody"}), http.StatusNotFound, "not_found")
	expect(t, authed(t, viewer, "POST", "/v1/tokens", map[string]any{"name": ""}), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, viewer, "POST", "/v1/tokens", map[string]any{"name": "x", "ttl_hours": 9000}), http.StatusBadRequest, "invalid_input")

	// Default TTL is 90 days; 0 means no expiry.
	r = authed(t, dev, "POST", "/v1/tokens", map[string]any{"name": "default"})
	expect(t, r, http.StatusCreated, "")
	exp, _ := time.Parse(time.RFC3339, r.Body["expires_at"].(string))
	if d := time.Until(exp); d < 89*24*time.Hour || d > 91*24*time.Hour {
		t.Fatalf("default expiry in %v", d)
	}
	r = authed(t, dev, "POST", "/v1/tokens", map[string]any{"name": "forever", "ttl_hours": 0})
	expect(t, r, http.StatusCreated, "")
	if r.Body["expires_at"] != nil {
		t.Fatalf("ttl 0 expires: %v", r.Body)
	}

	// Listing: own tokens, current one marked; ?all and ?user_id are owner-only.
	list := items(t, authed(t, viewer, "GET", "/v1/tokens", nil))
	if len(list) != 2 {
		t.Fatalf("viewer tokens = %v", list)
	}
	current := 0
	for _, tk := range list {
		if tk["user_id"] != "vic" {
			t.Fatalf("foreign token listed: %v", tk)
		}
		if tk["current"] == true {
			current++
		}
	}
	if current != 1 {
		t.Fatalf("current tokens = %d", current)
	}
	expect(t, authed(t, dev, "GET", "/v1/tokens?all=true", nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev, "GET", "/v1/tokens?user_id=vic", nil), http.StatusForbidden, "forbidden")
	if n := len(items(t, authed(t, owner, "GET", "/v1/tokens?user_id=vic", nil))); n != 2 {
		t.Fatalf("owner sees %d of vic's tokens", n)
	}
	if n := len(items(t, authed(t, owner, "GET", "/v1/tokens?all=true", nil))); n != 7 {
		t.Fatalf("all tokens = %d, want 7", n)
	}

	// Another member's token looks missing to a non-owner.
	expect(t, authed(t, dev, "DELETE", "/v1/tokens/"+ci, nil), http.StatusNotFound, "not_found")
	r = authed(t, viewer, "DELETE", "/v1/tokens/"+ci, nil)
	expect(t, r, http.StatusOK, "")
	if r.Body["revoked_at"] == nil {
		t.Fatalf("not revoked: %v", r.Body)
	}
	expect(t, authed(t, viewer, "DELETE", "/v1/tokens/"+ci, nil), http.StatusOK, "") // idempotent

	// The owner revokes the viewer's laptop token: it stops working at once.
	var laptop string
	for _, tk := range items(t, authed(t, viewer, "GET", "/v1/tokens", nil)) {
		if tk["current"] == true {
			laptop = tk["id"].(string)
		}
	}
	expect(t, authed(t, owner, "DELETE", "/v1/tokens/"+laptop, nil), http.StatusOK, "")
	expect(t, authed(t, viewer, "GET", "/v1/me", nil), http.StatusUnauthorized, "invalid_token")

	// Revocations are audited once each.
	a := items(t, authed(t, owner, "GET", "/v1/audit?action=token.revoke", nil))
	if len(a) != 2 {
		t.Fatalf("token.revoke audit = %v", a)
	}
	if a[0]["actor"] != "olivia" || a[0]["details"].(map[string]any)["user_id"] != "vic" {
		t.Fatalf("latest revoke = %v", a[0])
	}
}

func TestMemberManagement(t *testing.T) {
	requireDB(t)
	owner, lead, dev, viewer, _ := adminOrg(t, "members-org")

	list := items(t, authed(t, viewer, "GET", "/v1/members", nil))
	if len(list) != 4 || list[0]["user_id"] != "dana" || list[0]["active_tokens"].(float64) != 1 {
		t.Fatalf("members = %v", list)
	}

	// Leads manage dev/viewer members only; devs and viewers manage nobody.
	expect(t, authed(t, lead, "PUT", "/v1/members/nia", map[string]any{"role": "dev"}), http.StatusCreated, "")
	expect(t, authed(t, lead, "PUT", "/v1/members/nia", map[string]any{"role": "viewer"}), http.StatusOK, "")
	expect(t, authed(t, lead, "PUT", "/v1/members/nia", map[string]any{"role": "lead"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, lead, "PUT", "/v1/members/olivia", map[string]any{"role": "dev"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, lead, "DELETE", "/v1/members/olivia", nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev, "PUT", "/v1/members/zed", map[string]any{"role": "viewer"}), http.StatusForbidden, "forbidden")
	expect(t, authed(t, viewer, "DELETE", "/v1/members/nia", nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, owner, "PUT", "/v1/members/nia", map[string]any{"role": "admin"}), http.StatusBadRequest, "invalid_input")
	expect(t, authed(t, lead, "DELETE", "/v1/members/nia", nil), http.StatusOK, "")
	expect(t, authed(t, lead, "DELETE", "/v1/members/nia", nil), http.StatusNotFound, "not_found")

	// The last owner can neither be demoted nor removed.
	expect(t, authed(t, owner, "PUT", "/v1/members/olivia", map[string]any{"role": "lead"}), http.StatusConflict, "last_owner")
	expect(t, authed(t, owner, "DELETE", "/v1/members/olivia", nil), http.StatusConflict, "last_owner")
	expect(t, authed(t, owner, "PUT", "/v1/members/leo", map[string]any{"role": "owner"}), http.StatusOK, "")
	r := authed(t, lead, "GET", "/v1/me", nil) // role comes from members, so it changes at once
	if r.Body["role"] != "owner" {
		t.Fatalf("leo role = %v", r.Body)
	}
	expect(t, authed(t, lead, "PUT", "/v1/members/olivia", map[string]any{"role": "dev"}), http.StatusOK, "")

	// Removing a member deletes their tokens.
	expect(t, authed(t, lead, "DELETE", "/v1/members/dana", nil), http.StatusOK, "")
	expect(t, authed(t, dev, "GET", "/v1/me", nil), http.StatusUnauthorized, "invalid_token")

	acts := map[string]int{}
	for _, e := range items(t, authed(t, lead, "GET", "/v1/audit?target_type=member", nil)) {
		acts[e["action"].(string)]++
		if e["target_id"] != nil {
			t.Fatalf("member audit has target_id: %v", e)
		}
	}
	if acts["member.add"] != 4 || acts["member.role"] != 3 || acts["member.remove"] != 2 {
		t.Fatalf("member audit = %v", acts)
	}
}

func TestOrgRenameAndProjectRoles(t *testing.T) {
	requireDB(t)
	owner, lead, dev, _, _ := adminOrg(t, "rename-org")
	expect(t, authed(t, lead, "PATCH", "/v1/org", map[string]any{"name": "x"}), http.StatusForbidden, "forbidden")
	r := authed(t, owner, "PATCH", "/v1/org", map[string]any{"name": "Renamed"})
	expect(t, r, http.StatusOK, "")
	if r.Body["name"] != "Renamed" {
		t.Fatalf("org = %v", r.Body)
	}
	if me := authed(t, dev, "GET", "/v1/me", nil); me.Body["org_name"] != "Renamed" {
		t.Fatalf("me = %v", me.Body)
	}

	body := map[string]any{"name": "app", "repo_url": "https://github.com/acme/app.git"}
	expect(t, authed(t, dev, "POST", "/v1/projects", body), http.StatusForbidden, "forbidden")
	expect(t, authed(t, lead, "POST", "/v1/projects", body), http.StatusCreated, "")
}

func TestAuditLogAccessAndFilters(t *testing.T) {
	requireDB(t)
	owner, lead, dev, viewer, _ := adminOrg(t, "audit-org")
	otherOwner, _ := devToken(t, map[string]any{"org_name": "audit-other", "user_id": "mallory"})

	expect(t, authed(t, dev, "GET", "/v1/audit", nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, viewer, "GET", "/v1/audit", nil), http.StatusForbidden, "forbidden")
	all := items(t, authed(t, lead, "GET", "/v1/audit", nil))
	if len(all) == 0 {
		t.Fatal("empty audit log")
	}
	for i := 1; i < len(all); i++ {
		if all[i-1]["id"].(float64) <= all[i]["id"].(float64) {
			t.Fatalf("not newest first: %v", all)
		}
	}
	for _, e := range items(t, authed(t, otherOwner, "GET", "/v1/audit", nil)) {
		if e["actor"] != "mallory" {
			t.Fatalf("other org sees %v", e)
		}
	}
	tokens := items(t, authed(t, owner, "GET", "/v1/audit?action=token.", nil))
	if len(tokens) != 4 { // owner's own dev token + three minted for members
		t.Fatalf("token.* audit = %d", len(tokens))
	}
	if n := len(items(t, authed(t, owner, "GET", "/v1/audit?action=token", nil))); n != 0 {
		t.Fatalf("exact action without dot matched %d", n)
	}
	if n := len(items(t, authed(t, owner, "GET", "/v1/audit?actor=olivia&target_type=member", nil))); n != 3 {
		t.Fatalf("filtered = %d", n)
	}
	expect(t, authed(t, owner, "GET", "/v1/audit?target_id=nope", nil), http.StatusBadRequest, "invalid_input")
}

func TestCursorPagination(t *testing.T) {
	requireDB(t)
	owner, _, _, _, _ := adminOrg(t, "page-org")
	for _, n := range []string{"p1", "p2", "p3", "p4", "p5"} {
		expect(t, authed(t, owner, "POST", "/v1/projects", map[string]any{"name": n, "repo_url": "https://github.com/acme/" + n + ".git"}), http.StatusCreated, "")
	}
	walk := func(path string) []string {
		t.Helper()
		var seen []string
		next := ""
		for pages := 0; ; pages++ {
			if pages > 10 {
				t.Fatalf("%s: too many pages", path)
			}
			p := path
			if next != "" {
				p += "&cursor=" + url.QueryEscape(next)
			}
			r := authed(t, owner, "GET", p, nil)
			expect(t, r, http.StatusOK, "")
			for _, it := range items(t, r) {
				key := it["id"]
				if key == nil {
					key = it["user_id"]
				}
				seen = append(seen, fmt.Sprint(key))
			}
			c, _ := r.Body["next_cursor"].(string)
			if c == "" {
				return seen
			}
			next = c
		}
	}
	check := func(path string, want int) {
		t.Helper()
		got := walk(path)
		uniq := map[string]bool{}
		for _, v := range got {
			uniq[v] = true
		}
		if len(got) != want || len(uniq) != want {
			t.Fatalf("%s: %d items (%d unique), want %d", path, len(got), len(uniq), want)
		}
	}
	check("/v1/projects?limit=2", 5)
	check("/v1/members?limit=3", 4)
	check("/v1/tokens?all=true&limit=1", 4)
	check("/v1/audit?limit=4", len(items(t, authed(t, owner, "GET", "/v1/audit", nil))))

	r := authed(t, owner, "GET", "/v1/projects?limit=5", nil)
	if r.Body["next_cursor"] != nil {
		t.Fatalf("exact page has a cursor: %v", r.Body["next_cursor"])
	}
	expect(t, authed(t, owner, "GET", "/v1/projects?cursor=garbage", nil), http.StatusBadRequest, "invalid_cursor")
	expect(t, authed(t, owner, "GET", "/v1/audit?cursor=eyJpZCI6IngifQ", nil), http.StatusBadRequest, "invalid_cursor") // {"id":"x"}
}

func TestCloseRun(t *testing.T) {
	requireDB(t)
	owner, lead, dev, viewer, _ := adminOrg(t, "close-org")
	r := authed(t, owner, "POST", "/v1/projects", map[string]any{"name": "app", "repo_url": "https://github.com/acme/app.git"})
	expect(t, r, http.StatusCreated, "")
	project := r.Body["id"].(string)
	r = authed(t, dev, "POST", "/v1/projects/"+project+"/tasks", map[string]any{"title": "Fix it"})
	expect(t, r, http.StatusCreated, "")
	task := r.Body["id"].(string)
	started := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	newRun := func(token string) string {
		r := authed(t, token, "POST", "/v1/tasks/"+task+"/runs", map[string]any{"adapter": "claude-code", "started_at": started})
		expect(t, r, http.StatusCreated, "")
		return r.Body["id"].(string)
	}

	mine := newRun(dev)
	expect(t, authed(t, viewer, "POST", "/v1/runs/"+mine+"/close", nil), http.StatusForbidden, "forbidden")
	ownerRun := newRun(owner)
	expect(t, authed(t, dev, "POST", "/v1/runs/"+ownerRun+"/close", nil), http.StatusForbidden, "forbidden")
	expect(t, authed(t, dev, "POST", "/v1/runs/"+mine+"/close", map[string]any{"ended_at": "2000-01-01T00:00:00Z"}), http.StatusBadRequest, "invalid_input")

	r = authed(t, dev, "POST", "/v1/runs/"+mine+"/close", nil) // no body
	expect(t, r, http.StatusOK, "")
	if r.Body["ended_at"] == nil || r.Body["exit_reason"] != "closed" {
		t.Fatalf("closed run = %v", r.Body)
	}
	expect(t, authed(t, dev, "POST", "/v1/runs/"+mine+"/close", nil), http.StatusConflict, "run_closed")

	r = authed(t, lead, "POST", "/v1/runs/"+ownerRun+"/close", map[string]any{"exit_reason": "crashed", "cost_usd": 1.5, "output_tokens": 10})
	expect(t, r, http.StatusOK, "")
	if r.Body["exit_reason"] != "crashed" || r.Body["cost_usd"].(float64) != 1.5 || r.Body["output_tokens"].(float64) != 10 {
		t.Fatalf("lead closed = %v", r.Body)
	}
	expect(t, authed(t, owner, "POST", "/v1/runs/00000000-0000-4000-8000-000000000000/close", nil), http.StatusNotFound, "not_found")
	if n := len(items(t, authed(t, owner, "GET", "/v1/audit?action=run.close", nil))); n != 2 {
		t.Fatalf("run.close audit = %d", n)
	}
}
