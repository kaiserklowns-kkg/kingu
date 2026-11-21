package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServerConfig(t *testing.T) {
	env := map[string]string{
		"KINGU_RATE_LIMIT_STORE": "postgres",
		"KINGU_TRUSTED_PROXIES":  "10.0.0.0/8, 192.168.1.7 ,::1",
	}
	cfg, err := serverConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RateLimitStore != "postgres" || len(cfg.TrustedProxies) != 3 || cfg.TrustedProxies[1].String() != "192.168.1.7/32" || cfg.OIDC != nil || cfg.Dev {
		t.Fatalf("cfg = %+v", cfg)
	}
	for k, v := range map[string]string{
		"KINGU_RATE_LIMIT_STORE": "redis",
		"KINGU_TRUSTED_PROXIES":  "10.0.0.0/8,example.com",
		"KINGU_OIDC_ISSUER":      "http://login.example.com",
	} {
		if _, err := serverConfig(func(key string) string {
			if key == k {
				return v
			}
			return ""
		}); err == nil {
			t.Errorf("%s=%s accepted", k, v)
		}
	}
}

func writeCert(t *testing.T, dir, cn string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{cn}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	_ = os.WriteFile(filepath.Join(dir, "c.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "k.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
}

func TestCertReloader(t *testing.T) {
	dir := t.TempDir()
	cf, kf := filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	if _, err := newCertReloader(cf, ""); err == nil {
		t.Fatal("missing key accepted")
	}
	if _, err := newCertReloader(cf, kf); err == nil {
		t.Fatal("missing files accepted")
	}
	writeCert(t, dir, "one.test")
	c, err := newCertReloader(cf, kf)
	if err != nil {
		t.Fatal(err)
	}
	cn := func(now time.Time) string {
		got, err := c.get(now, false)
		if err != nil {
			t.Fatal(err)
		}
		leaf, _ := x509.ParseCertificate(got.Certificate[0])
		return leaf.Subject.CommonName
	}
	writeCert(t, dir, "two.test")
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(cf, future, future)
	if got := cn(time.Now()); got != "one.test" {
		t.Fatalf("reloaded within a minute: %s", got)
	}
	if got := cn(time.Now().Add(2 * time.Minute)); got != "two.test" {
		t.Fatalf("renewal not picked up: %s", got)
	}
	// A broken renewal keeps the last good pair.
	_ = os.WriteFile(kf, []byte("garbage"), 0o600)
	later := future.Add(time.Hour)
	_ = os.Chtimes(kf, later, later)
	if got := cn(time.Now().Add(10 * time.Minute)); got != "two.test" {
		t.Fatalf("after broken renewal: %s", got)
	}
}

func TestServerConfigAutoJoin(t *testing.T) {
	env := map[string]string{
		"KINGU_OIDC_ISSUER":            "https://login.example.com",
		"KINGU_OIDC_CLIENT_ID":         "kingu-web",
		"KINGU_OIDC_ORG":               "6f8ed8c4-c25c-4d76-8d03-26ca308af11c",
		"KINGU_OIDC_AUTO_JOIN_ROLE":    "dev",
		"KINGU_OIDC_AUTO_JOIN_DOMAINS": " acme.com, ,acme.co.th ",
	}
	cfg, err := serverConfig(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OIDC.AutoJoinRole != "dev" || len(cfg.OIDC.AutoJoinDomains) != 2 || cfg.OIDC.AutoJoinDomains[1] != "acme.co.th" {
		t.Fatalf("auto-join = %q %v", cfg.OIDC.AutoJoinRole, cfg.OIDC.AutoJoinDomains)
	}
	env["KINGU_OIDC_AUTO_JOIN_ROLE"] = "owner"
	if _, err := serverConfig(func(k string) string { return env[k] }); err == nil {
		t.Fatal("owner auto-join accepted")
	}
}
