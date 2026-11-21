package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestOIDCKeyRotationAndRefetchLimit(t *testing.T) {
	var (
		mu    sync.Mutex
		kid   = "k1"
		down  bool
		calls int
	)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if down {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"issuer": srv.URL, "jwks_uri": srv.URL + "/jwks"})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{
			{"kty": "RSA", "kid": kid, "n": enc(key.N.Bytes()), "e": enc(big.NewInt(int64(key.E)).Bytes())},
		}})
	})

	a := newOIDCAuthenticator(nil, OIDCConfig{Issuer: srv.URL, Audience: "c", OrgID: "6f8ed8c4-c25c-4d76-8d03-26ca308af11c"})
	now := time.Unix(1_800_000_000, 0)
	a.now = func() time.Time { return now }
	ctx := context.Background()
	set := func(f func()) { mu.Lock(); f(); mu.Unlock() }

	if _, err := a.key(ctx, "k1"); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	set(func() { kid = "k2" }) // the IdP rotates its key
	now = now.Add(10 * time.Second)
	if _, err := a.key(ctx, "k2"); err == nil {
		t.Fatal("refetched within the minimum interval")
	}
	now = now.Add(25 * time.Second)
	if _, err := a.key(ctx, "k2"); err != nil {
		t.Fatalf("rotated key not picked up: %v", err)
	}
	before := calls
	for i := 0; i < 20; i++ { // unknown kids cannot make it hammer the IdP
		_, _ = a.key(ctx, "nope")
	}
	if calls != before {
		t.Fatalf("unknown kids caused %d fetches", calls-before)
	}

	// A known key keeps working while the IdP is down, even once stale.
	set(func() { down = true })
	now = now.Add(2 * time.Hour)
	if _, err := a.key(ctx, "k2"); err != nil {
		t.Fatalf("stale key refused while IdP down: %v", err)
	}
	now = now.Add(time.Minute)
	if _, err := a.key(ctx, "k9"); err == nil || err.(*apiError).Code != "oidc_unavailable" {
		t.Fatalf("unknown key while down = %v", err)
	}
}
