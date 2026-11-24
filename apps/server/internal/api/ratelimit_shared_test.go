package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
)

// Two API instances (replicas) with the postgres store share one budget.
func TestSharedRateLimitAcrossReplicas(t *testing.T) {
	requireDB(t)
	cfg := api.Config{RateLimitStore: "postgres", RateLimit: 0.001, RateBurst: 3}
	a, b := newServer(t, cfg), newServer(t, cfg)
	tok, _ := devToken(t, map[string]any{"org_name": "shared-rl", "user_id": "rae"})
	get := func(base string) (resp, http.Header) {
		return call{base: base, method: "GET", path: "/v1/me", token: tok}.do(t)
	}
	for i, base := range []string{a, b, a} {
		if r, _ := get(base); r.Status != http.StatusOK {
			t.Fatalf("request %d: %d", i, r.Status)
		}
	}
	r, h := get(b)
	expect(t, r, http.StatusTooManyRequests, "rate_limited")
	if h.Get("Retry-After") == "" {
		t.Fatal("no Retry-After")
	}
	if r, _ := get(a); r.Status != http.StatusTooManyRequests {
		t.Fatalf("replica a still allows: %d", r.Status)
	}

	// Another credential has its own bucket.
	other, _ := devToken(t, map[string]any{"org_name": "shared-rl-2", "user_id": "sam"})
	if r, _ := (call{base: b, method: "GET", path: "/v1/me", token: other}).do(t); r.Status != http.StatusOK {
		t.Fatalf("other credential: %d", r.Status)
	}
}

// Failed sign-ins from one IP are limited across replicas too (burst 20).
func TestSharedFailLimitAcrossReplicas(t *testing.T) {
	requireDB(t)
	cfg := api.Config{RateLimitStore: "postgres"}
	a, b := newServer(t, cfg), newServer(t, cfg)
	// The bucket is keyed by IP (127.0.0.1 for every test); empty it afterwards.
	t.Cleanup(func() { _, _ = adminPool.Exec(context.Background(), `DELETE FROM rate_limits`) })
	bad := "kgu_" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	limited := 0
	for i := 0; i < 30; i++ {
		base := a
		if i%2 == 1 {
			base = b
		}
		r, _ := call{base: base, method: "GET", path: "/v1/me", token: bad}.do(t)
		if r.Status == http.StatusTooManyRequests {
			limited++
		}
	}
	// 20 burst + at most a couple refilled during the loop.
	if limited < 7 {
		t.Fatalf("only %d of 30 failed attempts were limited", limited)
	}
}
