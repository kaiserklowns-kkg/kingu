package api_test

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
)

// fakeIdP serves discovery and a JWKS, and signs ID tokens.
type fakeIdP struct {
	srv *httptest.Server
	rsa *rsa.PrivateKey
	ec  *ecdsa.PrivateKey
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func newIdP(t *testing.T) *fakeIdP {
	t.Helper()
	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ek, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIdP{rsa: rk, ec: ek}
	mux := http.NewServeMux()
	idp.srv = httptest.NewServer(mux)
	t.Cleanup(idp.srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"issuer": idp.srv.URL, "jwks_uri": idp.srv.URL + "/jwks"})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		pad := func(b []byte) []byte { return append(make([]byte, 32-len(b)), b...) }
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{
			{"kty": "RSA", "kid": "r1", "use": "sig", "n": b64u(rk.N.Bytes()), "e": b64u(big.NewInt(int64(rk.E)).Bytes())},
			{"kty": "EC", "kid": "e1", "crv": "P-256", "x": b64u(pad(ek.X.Bytes())), "y": b64u(pad(ek.Y.Bytes()))},
		}})
	})
	return idp
}

func (idp *fakeIdP) claims(email string) map[string]any {
	now := time.Now().Unix()
	return map[string]any{"iss": idp.srv.URL, "aud": "kingu-web", "sub": "sub-" + email,
		"email": email, "email_verified": true, "iat": now, "exp": now + 3600}
}

func (idp *fakeIdP) sign(t *testing.T, alg, kid string, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": alg, "kid": kid, "typ": "JWT"})
	p, _ := json.Marshal(claims)
	in := b64u(h) + "." + b64u(p)
	d := sha256.Sum256([]byte(in))
	var sig []byte
	switch alg {
	case "RS256":
		s, err := rsa.SignPKCS1v15(rand.Reader, idp.rsa, crypto.SHA256, d[:])
		if err != nil {
			t.Fatal(err)
		}
		sig = s
	case "ES256":
		r, s, err := ecdsa.Sign(rand.Reader, idp.ec, d[:])
		if err != nil {
			t.Fatal(err)
		}
		sig = append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	default:
		sig = []byte("x")
	}
	return in + "." + b64u(sig)
}

func with(m map[string]any, k string, v any) map[string]any {
	out := map[string]any{}
	for kk, vv := range m {
		out[kk] = vv
	}
	if v == nil {
		delete(out, k)
	} else {
		out[k] = v
	}
	return out
}

func TestOIDCBearerAndSession(t *testing.T) {
	requireDB(t)
	idp := newIdP(t)
	owner, orgID := devToken(t, map[string]any{"org_name": "oidc-org", "user_id": "olivia@acme.test"})
	expect(t, authed(t, owner, "PUT", "/v1/members/vic@acme.test", map[string]any{"role": "viewer"}), http.StatusCreated, "")
	base := newServer(t, api.Config{OIDC: &api.OIDCConfig{Issuer: idp.srv.URL, Audience: "kingu-web", OrgID: orgID}})
	get := func(tok string) resp {
		r, _ := call{base: base, method: "GET", path: "/v1/me", token: tok}.do(t)
		return r
	}

	good := idp.claims("Olivia@acme.test") // email is compared lowercased
	for _, alg := range []struct{ alg, kid string }{{"RS256", "r1"}, {"ES256", "e1"}} {
		r := get(idp.sign(t, alg.alg, alg.kid, good))
		expect(t, r, http.StatusOK, "")
		if r.Body["user_id"] != "olivia@acme.test" || r.Body["role"] != "owner" || r.Body["org_id"] != orgID {
			t.Fatalf("%s me = %v", alg.alg, r.Body)
		}
	}

	expect(t, get(idp.sign(t, "RS256", "r1", idp.claims("stranger@acme.test"))), http.StatusForbidden, "not_a_member")
	bad := map[string]string{
		"wrong audience":   idp.sign(t, "RS256", "r1", with(good, "aud", "other")),
		"wrong issuer":     idp.sign(t, "RS256", "r1", with(good, "iss", "https://evil.test")),
		"expired":          idp.sign(t, "RS256", "r1", with(good, "exp", time.Now().Add(-time.Hour).Unix())),
		"no exp":           idp.sign(t, "RS256", "r1", with(good, "exp", nil)),
		"not yet valid":    idp.sign(t, "RS256", "r1", with(good, "nbf", time.Now().Add(time.Hour).Unix())),
		"unverified email": idp.sign(t, "RS256", "r1", with(good, "email_verified", false)),
		"alg none":         idp.sign(t, "none", "r1", good),
		"alg HS256":        idp.sign(t, "HS256", "r1", good),
		"unknown kid":      idp.sign(t, "RS256", "zz", good),
		"key/alg mismatch": idp.sign(t, "ES256", "r1", good),
		"tampered":         strings.Replace(idp.sign(t, "RS256", "r1", good), ".", ".e30", 1),
	}
	for name, tok := range bad {
		if r := get(tok); r.Status != http.StatusUnauthorized {
			t.Errorf("%s: status %d body %v", name, r.Status, r.Body)
		}
	}
	// A PAT still works on the same server.
	expect(t, get(owner), http.StatusOK, "")

	// Session exchange: a viewer's ID token becomes a 12h Kingu token.
	vic := idp.sign(t, "RS256", "r1", idp.claims("vic@acme.test"))
	r, _ := call{base: base, method: "POST", path: "/v1/auth/session", token: vic}.do(t)
	expect(t, r, http.StatusCreated, "")
	sess := r.Body["token"].(string)
	exp, _ := time.Parse(time.RFC3339, r.Body["expires_at"].(string))
	if d := time.Until(exp); d < 11*time.Hour || d > 13*time.Hour || r.Body["user_id"] != "vic@acme.test" {
		t.Fatalf("session = %v (expires in %v)", r.Body, d)
	}
	if me := get(sess); me.Body["role"] != "viewer" {
		t.Fatalf("session me = %v", me.Body)
	}
	r, _ = call{base: base, method: "POST", path: "/v1/auth/session", token: owner}.do(t)
	expect(t, r, http.StatusBadRequest, "invalid_input")

	// Removing the member stops both kinds of credential.
	expect(t, authed(t, owner, "DELETE", "/v1/members/vic@acme.test", nil), http.StatusOK, "")
	expect(t, get(vic), http.StatusForbidden, "not_a_member")
	expect(t, get(sess), http.StatusUnauthorized, "invalid_token")
}

func TestOIDCConfigValidate(t *testing.T) {
	ok := api.OIDCConfig{Issuer: "https://login.example.com", Audience: "c", OrgID: "6f8ed8c4-c25c-4d76-8d03-26ca308af11c"}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]api.OIDCConfig{
		"http issuer": {Issuer: "http://login.example.com", Audience: "c", OrgID: ok.OrgID},
		"no audience": {Issuer: ok.Issuer, OrgID: ok.OrgID},
		"bad org":     {Issuer: ok.Issuer, Audience: "c", OrgID: "x"},
		"bad claim":   {Issuer: ok.Issuer, Audience: "c", OrgID: ok.OrgID, UserClaim: "name"},
		"lead join":   {Issuer: ok.Issuer, Audience: "c", OrgID: ok.OrgID, AutoJoinRole: "lead"},
		"bad domain":  {Issuer: ok.Issuer, Audience: "c", OrgID: ok.OrgID, AutoJoinRole: "dev", AutoJoinDomains: []string{"@Acme.com"}},
	} {
		if c.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	loop := api.OIDCConfig{Issuer: "http://127.0.0.1:9999", Audience: "c", OrgID: ok.OrgID}
	if err := loop.Validate(); err != nil {
		t.Errorf("loopback http refused: %v", err)
	}
}

func TestOIDCAutoJoin(t *testing.T) {
	requireDB(t)
	idp := newIdP(t)
	owner, orgID := devToken(t, map[string]any{"org_name": "oidc-join", "user_id": "olivia@acme.test"})
	base := newServer(t, api.Config{OIDC: &api.OIDCConfig{Issuer: idp.srv.URL, Audience: "kingu-web", OrgID: orgID, AutoJoinRole: "dev", AutoJoinDomains: []string{"acme.test"}}})
	do := func(method, path, tok string) resp {
		r, _ := call{base: base, method: method, path: path, token: tok}.do(t)
		return r
	}

	newcomer := idp.sign(t, "RS256", "r1", idp.claims("dana@acme.test"))
	// Only the sign-in exchange joins: other calls are still refused.
	expect(t, do("GET", "/v1/me", newcomer), http.StatusForbidden, "not_a_member")
	r := do("POST", "/v1/auth/session", newcomer)
	expect(t, r, http.StatusCreated, "")
	if me := do("GET", "/v1/me", r.Body["token"].(string)); me.Body["role"] != "dev" {
		t.Fatalf("joined as %v", me.Body)
	}
	// The join is audited; signing in again joins nothing new.
	expect(t, do("POST", "/v1/auth/session", newcomer), http.StatusCreated, "")
	a := do("GET", "/v1/audit?action=member.add", owner)
	expect(t, a, http.StatusOK, "")
	items := a.Body["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["details"].(map[string]any)["via"] != "oidc auto-join" {
		t.Fatalf("audit = %v", items)
	}
	// Another domain, or an unverified email, does not join.
	expect(t, do("POST", "/v1/auth/session", idp.sign(t, "RS256", "r1", idp.claims("eve@other.test"))), http.StatusForbidden, "not_a_member")
	expect(t, do("POST", "/v1/auth/session", idp.sign(t, "RS256", "r1", with(idp.claims("sam@acme.test"), "email_verified", false))), http.StatusUnauthorized, "invalid_token")
	// An existing member keeps the role they were given.
	expect(t, authed(t, owner, "PUT", "/v1/members/vic@acme.test", map[string]any{"role": "viewer"}), http.StatusCreated, "")
	r = do("POST", "/v1/auth/session", idp.sign(t, "RS256", "r1", idp.claims("vic@acme.test")))
	if me := do("GET", "/v1/me", r.Body["token"].(string)); me.Body["role"] != "viewer" {
		t.Fatalf("member role changed: %v", me.Body)
	}
}

func TestOIDCSeveralProviders(t *testing.T) {
	requireDB(t)
	a, b := newIdP(t), newIdP(t)
	ownerA, orgA := devToken(t, map[string]any{"org_name": "oidc-a", "user_id": "ann@a.test"})
	ownerB, orgB := devToken(t, map[string]any{"org_name": "oidc-b", "user_id": "ben@b.test"})
	base := newServer(t, api.Config{
		OIDC:          &api.OIDCConfig{Issuer: a.srv.URL, Audience: "kingu-web", OrgID: orgA},
		OIDCProviders: []api.OIDCConfig{{Issuer: b.srv.URL, Audience: "kingu-web", OrgID: orgB}},
	})
	get := func(tok string) resp {
		r, _ := call{base: base, method: "GET", path: "/v1/me", token: tok}.do(t)
		return r
	}
	// Each issuer's token lands in its own org.
	if r := get(a.sign(t, "RS256", "r1", a.claims("ann@a.test"))); r.Status != http.StatusOK || r.Body["org_id"] != orgA {
		t.Fatalf("issuer A: %d %v", r.Status, r.Body)
	}
	if r := get(b.sign(t, "ES256", "e1", b.claims("ben@b.test"))); r.Status != http.StatusOK || r.Body["org_id"] != orgB {
		t.Fatalf("issuer B: %d %v", r.Status, r.Body)
	}
	// A member of one org is not one of the other's.
	expect(t, get(b.sign(t, "RS256", "r1", b.claims("ann@a.test"))), http.StatusForbidden, "not_a_member")
	// Claiming B's issuer with A's key, or an issuer nobody configured, is refused.
	if r := get(a.sign(t, "RS256", "r1", with(a.claims("ben@b.test"), "iss", b.srv.URL))); r.Status != http.StatusUnauthorized {
		t.Errorf("forged issuer: %d %v", r.Status, r.Body)
	}
	if r := get(a.sign(t, "RS256", "r1", with(a.claims("ann@a.test"), "iss", "https://evil.test"))); r.Status != http.StatusUnauthorized {
		t.Errorf("unknown issuer: %d %v", r.Status, r.Body)
	}
	// PATs still work.
	expect(t, get(ownerA), http.StatusOK, "")
	expect(t, get(ownerB), http.StatusOK, "")
}

func TestOIDCValidateProviders(t *testing.T) {
	org := "6f8ed8c4-c25c-4d76-8d03-26ca308af11c"
	one := api.OIDCConfig{Issuer: "https://a.example.com", Audience: "c", OrgID: org}
	two := api.OIDCConfig{Issuer: "https://b.example.com", Audience: "c", OrgID: org}
	if err := api.ValidateProviders([]api.OIDCConfig{one, two}); err != nil {
		t.Fatal(err)
	}
	if api.ValidateProviders([]api.OIDCConfig{one, one}) == nil {
		t.Error("duplicate issuer accepted")
	}
	if api.ValidateProviders([]api.OIDCConfig{one, {Issuer: "https://c.example.com", OrgID: org}}) == nil {
		t.Error("invalid provider accepted")
	}
}
