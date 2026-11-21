package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
)

// serverConfig reads the API's settings from the environment.
func serverConfig(getenv func(string) string) (api.Config, error) {
	cfg := api.Config{Dev: getenv("KINGU_DEV") == "1"}
	switch store := getenv("KINGU_RATE_LIMIT_STORE"); store {
	case "", "memory", "postgres":
		cfg.RateLimitStore = store
	default:
		return cfg, fmt.Errorf("KINGU_RATE_LIMIT_STORE must be memory or postgres, not %q", store)
	}
	proxies, err := parseProxies(getenv("KINGU_TRUSTED_PROXIES"))
	if err != nil {
		return cfg, err
	}
	cfg.TrustedProxies = proxies
	if issuer := getenv("KINGU_OIDC_ISSUER"); issuer != "" {
		o := &api.OIDCConfig{
			Issuer:    issuer,
			Audience:  getenv("KINGU_OIDC_CLIENT_ID"),
			OrgID:     getenv("KINGU_OIDC_ORG"),
			UserClaim: getenv("KINGU_OIDC_USER_CLAIM"),
			// Off unless set: viewer or dev for identities that are not members yet.
			AutoJoinRole: strings.TrimSpace(getenv("KINGU_OIDC_AUTO_JOIN_ROLE")),
		}
		for _, d := range strings.Split(getenv("KINGU_OIDC_AUTO_JOIN_DOMAINS"), ",") {
			if d = strings.TrimSpace(d); d != "" {
				o.AutoJoinDomains = append(o.AutoJoinDomains, d)
			}
		}
		if err := o.Validate(); err != nil {
			return cfg, fmt.Errorf("OIDC config: %w", err)
		}
		cfg.OIDC = o
	}
	return cfg, nil
}

// parseProxies reads comma-separated CIDRs or single addresses.
func parseProxies(v string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if p, err := netip.ParsePrefix(part); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(part)
		if err != nil {
			return nil, fmt.Errorf("KINGU_TRUSTED_PROXIES: %q is not an IP or CIDR", part)
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
	}
	return out, nil
}

// certReloader serves the certificate in certFile/keyFile and picks up a
// renewed pair (certbot, cert-manager) without a restart: it re-reads the
// files at most once a minute when their modification time changed.
type certReloader struct {
	certFile, keyFile string

	mu      sync.Mutex
	cert    *tls.Certificate
	mod     time.Time
	checked time.Time
}

func newCertReloader(certFile, keyFile string) (*certReloader, error) {
	if certFile == "" || keyFile == "" {
		return nil, errors.New("KINGU_TLS_CERT and KINGU_TLS_KEY must be set together")
	}
	c := &certReloader{certFile: certFile, keyFile: keyFile}
	if _, err := c.get(time.Now(), true); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *certReloader) get(now time.Time, force bool) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && now.Sub(c.checked) < time.Minute {
		return c.cert, nil
	}
	c.checked = now
	mod := latestMod(c.certFile, c.keyFile)
	if !force && !mod.After(c.mod) {
		return c.cert, nil
	}
	pair, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
	if err != nil {
		if c.cert != nil {
			return c.cert, nil // half-written renewal: keep serving the old pair
		}
		return nil, fmt.Errorf("load TLS certificate: %w", err)
	}
	c.cert, c.mod = &pair, mod
	return c.cert, nil
}

func latestMod(files ...string) time.Time {
	var t time.Time
	for _, f := range files {
		if fi, err := os.Stat(f); err == nil && fi.ModTime().After(t) {
			t = fi.ModTime()
		}
	}
	return t
}

func (c *certReloader) tlsConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return c.get(time.Now(), false)
		},
	}
}
