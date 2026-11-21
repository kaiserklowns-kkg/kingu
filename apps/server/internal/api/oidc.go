package api

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OIDC sign-in. An identity provider (Google Workspace, Entra ID, Okta,
// Keycloak, ...) issues an ID token (a signed JWT). The server accepts it as
// `Authorization: Bearer <JWT>` after checking its signature against the
// issuer's JWKS and its iss/aud/exp/nbf claims, then maps one claim (email by
// default) to members.user_id in the configured org. People are not created
// on first sign-in: an owner or lead adds them on the Members page first.
//
// POST /v1/auth/session trades a valid ID token for a short-lived Kingu token,
// which is what the dashboard keeps in its cookie (ID tokens last ~1 hour).

// OIDCConfig enables OIDC bearer tokens for one org.
type OIDCConfig struct {
	// Issuer is the exact `iss` of the provider; discovery reads
	// <Issuer>/.well-known/openid-configuration. Must be https (http only for
	// loopback, for tests and local IdPs).
	Issuer string
	// Audience is the OAuth client id the tokens must be issued to (`aud`).
	Audience string
	// OrgID is the org these identities belong to.
	OrgID string
	// UserClaim is the claim used as members.user_id: "email" (default;
	// requires email_verified) or "sub".
	UserClaim string
	// Client fetches discovery and JWKS (default: 5s timeout).
	Client *http.Client
	// AutoJoinRole lets someone the IdP signed in, who is not a member yet,
	// join the org with this role at their first POST /v1/auth/session:
	// "viewer" or "dev" (never lead or owner); "" (default) keeps members-only.
	AutoJoinRole string
	// AutoJoinDomains limits auto-join to these email domains (lowercase,
	// e.g. "acme.com"); empty allows any identity the IdP issues for the
	// client. With UserClaim "sub" the domain comes from the token's email.
	AutoJoinDomains []string
}

const (
	jwksMaxAge        = time.Hour
	jwksMinRefresh    = 30 * time.Second
	oidcClockLeeway   = time.Minute
	oidcMaxTokenLen   = 16 << 10
	oidcMaxFetchBytes = 1 << 20
	// SessionTokenTTL is the life of a token from POST /v1/auth/session.
	SessionTokenTTL = 12 * time.Hour
)

var errNotMember = &apiError{Status: http.StatusForbidden, Code: "not_a_member",
	Message: "signed in, but not a member of this org; ask an owner or lead to add you"}

// Validate checks the configuration before the server starts.
func (c OIDCConfig) Validate() error {
	u, err := url.Parse(c.Issuer)
	if err != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("OIDC issuer must be an absolute URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname())) {
		return errors.New("OIDC issuer must use https")
	}
	if c.Audience == "" {
		return errors.New("OIDC audience (client id) is required")
	}
	if _, ok := parseUUID(c.OrgID); !ok {
		return errors.New("OIDC org must be an org uuid")
	}
	if c.UserClaim != "" && c.UserClaim != "email" && c.UserClaim != "sub" {
		return errors.New(`OIDC user claim must be "email" or "sub"`)
	}
	if c.AutoJoinRole != "" && c.AutoJoinRole != "viewer" && c.AutoJoinRole != "dev" {
		return errors.New(`OIDC auto-join role must be "viewer" or "dev"`)
	}
	for _, d := range c.AutoJoinDomains {
		if d == "" || d != strings.ToLower(d) || strings.ContainsAny(d, "@ /") || !strings.Contains(d, ".") {
			return fmt.Errorf("OIDC auto-join domain %q must be a lowercase domain like acme.com", d)
		}
	}
	return nil
}

// autoJoins says whether an identity that is not a member may join at
// sign-in: auto-join is on and, when domains are set, its verified email is
// in one of them.
func (c OIDCConfig) autoJoins(claims *idClaims) bool {
	if c.AutoJoinRole == "" {
		return false
	}
	if len(c.AutoJoinDomains) == 0 {
		return true
	}
	email := strings.ToLower(claims.Email)
	at := strings.LastIndexByte(email, '@')
	if !claims.EmailVerified.v || at < 1 {
		return false
	}
	return slices.Contains(c.AutoJoinDomains, email[at+1:])
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type oidcAuthenticator struct {
	cfg  OIDCConfig
	org  string
	pool *pgxpool.Pool
	// multi: one of several providers, so a token of another issuer is not
	// this one's to refuse.
	multi bool

	mu        sync.Mutex
	keys      map[string]crypto.PublicKey
	fetchedAt time.Time
	triedAt   time.Time
	now       func() time.Time
}

func newOIDCAuthenticator(pool *pgxpool.Pool, cfg OIDCConfig) *oidcAuthenticator {
	if cfg.UserClaim == "" {
		cfg.UserClaim = "email"
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 5 * time.Second}
	}
	org, _ := parseUUID(cfg.OrgID)
	return &oidcAuthenticator{cfg: cfg, org: org, pool: pool, now: time.Now}
}

// issuerOf reads a JWT's `iss` without checking anything else: with several
// identity providers each authenticator takes only its own issuer's tokens
// (the one that does verifies everything).
func issuerOf(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > oidcMaxTokenLen {
		return ""
	}
	pb, err := b64(parts[1])
	if err != nil {
		return ""
	}
	var c struct {
		Iss string `json:"iss"`
	}
	if json.Unmarshal(pb, &c) != nil {
		return ""
	}
	return c.Iss
}

// ValidateProviders checks several providers together: each valid, and no
// issuer twice (a token's issuer picks its org).
func ValidateProviders(ps []OIDCConfig) error {
	seen := map[string]bool{}
	for _, p := range ps {
		if err := p.Validate(); err != nil {
			return fmt.Errorf("%s: %w", p.Issuer, err)
		}
		if seen[p.Issuer] {
			return fmt.Errorf("OIDC issuer %s is configured twice", p.Issuer)
		}
		seen[p.Issuer] = true
	}
	return nil
}

// looksLikeJWT: three base64url segments; PATs never contain dots.
func looksLikeJWT(t string) bool {
	return !strings.HasPrefix(t, TokenPrefix) && strings.Count(t, ".") == 2
}

func (a *oidcAuthenticator) Authenticate(ctx context.Context, r *http.Request) (*Principal, error) {
	tok, present := bearer(r)
	if !present || !looksLikeJWT(tok) {
		return nil, nil
	}
	// Another provider's token: the next authenticator takes it.
	if a.multi && issuerOf(tok) != a.cfg.Issuer {
		return nil, nil
	}
	claims, err := a.verify(ctx, tok)
	if err != nil {
		return nil, err
	}
	user, err := a.userID(claims)
	if err != nil {
		return nil, err
	}
	p := &Principal{OrgID: a.org, UserID: user, Key: "oidc:" + claims.Subject, Via: "oidc"}
	err = pgx.BeginTxFunc(ctx, a.pool, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, a.org); err != nil {
			return err
		}
		err := tx.QueryRow(ctx, `SELECT role FROM members WHERE user_id = $1`, user).Scan(&p.Role)
		if errors.Is(err, pgx.ErrNoRows) {
			// Only the sign-in exchange joins; every other call with the ID token
			// of a non-member is still refused.
			if r.Method == http.MethodPost && r.URL.Path == "/v1/auth/session" && a.cfg.autoJoins(claims) {
				p.Role = a.cfg.AutoJoinRole
				p.AutoJoin = true
				return nil
			}
			return errNotMember
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (a *oidcAuthenticator) userID(c *idClaims) (string, error) {
	var v string
	if a.cfg.UserClaim == "sub" {
		v = c.Subject
	} else {
		if !c.EmailVerified.v {
			return "", invalidJWT("email is not verified")
		}
		v = strings.ToLower(c.Email)
	}
	if checkText("user", v, 255, true) != nil {
		return "", invalidJWT("missing " + a.cfg.UserClaim + " claim")
	}
	return v, nil
}

func invalidJWT(why string) *apiError {
	return &apiError{Status: http.StatusUnauthorized, Code: "invalid_token", Message: "ID token rejected: " + why}
}

// ---- JWT ---------------------------------------------------------------------

type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

// flexBool accepts true and "true" (some providers send email_verified as a string).
type flexBool struct{ v bool }

func (b *flexBool) UnmarshalJSON(data []byte) error {
	switch string(data) {
	case "true", `"true"`:
		b.v = true
	}
	return nil
}

// audience accepts "aud" as a string or an array of strings.
type audience []string

func (a *audience) UnmarshalJSON(data []byte) error {
	var one string
	if err := json.Unmarshal(data, &one); err == nil {
		*a = audience{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(data, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

type idClaims struct {
	Issuer        string   `json:"iss"`
	Subject       string   `json:"sub"`
	Audience      audience `json:"aud"`
	AZP           string   `json:"azp"`
	Expiry        *float64 `json:"exp"`
	NotBefore     *float64 `json:"nbf"`
	IssuedAt      *float64 `json:"iat"`
	Email         string   `json:"email"`
	EmailVerified flexBool `json:"email_verified"`
	Nonce         string   `json:"nonce"`
}

func b64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

func (a *oidcAuthenticator) verify(ctx context.Context, token string) (*idClaims, error) {
	if len(token) > oidcMaxTokenLen {
		return nil, invalidJWT("too long")
	}
	parts := strings.Split(token, ".")
	hb, err := b64(parts[0])
	if err != nil {
		return nil, invalidJWT("malformed header")
	}
	var h jwtHeader
	if json.Unmarshal(hb, &h) != nil {
		return nil, invalidJWT("malformed header")
	}
	hash, ok := jwtHashes[h.Alg]
	if !ok {
		return nil, invalidJWT("unsupported alg " + h.Alg)
	}
	sig, err := b64(parts[2])
	if err != nil {
		return nil, invalidJWT("malformed signature")
	}
	key, err := a.key(ctx, h.Kid)
	if err != nil {
		return nil, err
	}
	signed := []byte(parts[0] + "." + parts[1])
	if !verifySig(h.Alg, hash, key, signed, sig) {
		return nil, invalidJWT("bad signature")
	}
	pb, err := b64(parts[1])
	if err != nil {
		return nil, invalidJWT("malformed payload")
	}
	var c idClaims
	if json.Unmarshal(pb, &c) != nil {
		return nil, invalidJWT("malformed payload")
	}
	now := a.now()
	switch {
	case c.Issuer != a.cfg.Issuer:
		return nil, invalidJWT("wrong issuer")
	case !c.hasAudience(a.cfg.Audience):
		return nil, invalidJWT("wrong audience")
	case len(c.Audience) > 1 && c.AZP != "" && c.AZP != a.cfg.Audience:
		return nil, invalidJWT("wrong authorized party")
	case c.Expiry == nil || now.After(unix(*c.Expiry).Add(oidcClockLeeway)):
		return nil, invalidJWT("expired")
	case c.NotBefore != nil && now.Add(oidcClockLeeway).Before(unix(*c.NotBefore)):
		return nil, invalidJWT("not yet valid")
	case c.IssuedAt != nil && now.Add(oidcClockLeeway).Before(unix(*c.IssuedAt)):
		return nil, invalidJWT("issued in the future")
	case c.Subject == "":
		return nil, invalidJWT("missing sub")
	}
	return &c, nil
}

func (c *idClaims) hasAudience(want string) bool {
	for _, a := range c.Audience {
		if a == want {
			return true
		}
	}
	return false
}

func unix(f float64) time.Time { return time.Unix(int64(f), 0) }

var jwtHashes = map[string]crypto.Hash{
	"RS256": crypto.SHA256, "RS384": crypto.SHA384, "RS512": crypto.SHA512,
	"PS256": crypto.SHA256, "PS384": crypto.SHA384, "PS512": crypto.SHA512,
	"ES256": crypto.SHA256, "ES384": crypto.SHA384,
}

func digest(h crypto.Hash, data []byte) []byte {
	switch h {
	case crypto.SHA384:
		s := sha512.Sum384(data)
		return s[:]
	case crypto.SHA512:
		s := sha512.Sum512(data)
		return s[:]
	default:
		s := sha256.Sum256(data)
		return s[:]
	}
}

func verifySig(alg string, h crypto.Hash, key crypto.PublicKey, signed, sig []byte) bool {
	d := digest(h, signed)
	switch k := key.(type) {
	case *rsa.PublicKey:
		switch alg[:2] {
		case "RS":
			return rsa.VerifyPKCS1v15(k, h, d, sig) == nil
		case "PS":
			return rsa.VerifyPSS(k, h, d, sig, &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash}) == nil
		}
	case *ecdsa.PublicKey:
		size := (k.Curve.Params().BitSize + 7) / 8
		if alg[:2] != "ES" || len(sig) != 2*size || (alg == "ES256") != (k.Curve == elliptic.P256()) {
			return false
		}
		r, s := new(big.Int).SetBytes(sig[:size]), new(big.Int).SetBytes(sig[size:])
		return ecdsa.Verify(k, d, r, s)
	}
	return false
}

// ---- discovery and JWKS --------------------------------------------------------

// key returns the signing key for kid, refreshing the JWKS when it is stale or
// does not know kid (a rotated key), at most once per jwksMinRefresh.
func (a *oidcAuthenticator) key(ctx context.Context, kid string) (crypto.PublicKey, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	k, known := a.lookup(kid)
	if known && now.Sub(a.fetchedAt) < jwksMaxAge {
		return k, nil
	}
	if now.Sub(a.triedAt) >= jwksMinRefresh {
		a.triedAt = now
		keys, err := a.fetchKeys(ctx)
		if err == nil {
			a.keys, a.fetchedAt = keys, now
			k, known = a.lookup(kid)
		} else if !known {
			return nil, &apiError{Status: http.StatusServiceUnavailable, Code: "oidc_unavailable",
				Message: "could not reach the identity provider"}
		}
	}
	if !known {
		return nil, invalidJWT("unknown signing key")
	}
	return k, nil
}

// lookup finds kid; a token without kid matches only a JWKS with one key.
func (a *oidcAuthenticator) lookup(kid string) (crypto.PublicKey, bool) {
	if kid == "" {
		if len(a.keys) == 1 {
			for _, k := range a.keys {
				return k, true
			}
		}
		return nil, false
	}
	k, ok := a.keys[kid]
	return k, ok
}

func (a *oidcAuthenticator) getJSON(ctx context.Context, u string, dst any) error {
	pu, err := url.Parse(u)
	if err != nil || (pu.Scheme != "https" && !(pu.Scheme == "http" && isLoopback(pu.Hostname()))) {
		return fmt.Errorf("refusing non-https URL %q", u)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	res, err := a.cfg.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", u, res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, oidcMaxFetchBytes)).Decode(dst)
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func (a *oidcAuthenticator) fetchKeys(ctx context.Context) (map[string]crypto.PublicKey, error) {
	var disc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := a.getJSON(ctx, strings.TrimSuffix(a.cfg.Issuer, "/")+"/.well-known/openid-configuration", &disc); err != nil {
		return nil, err
	}
	if disc.Issuer != a.cfg.Issuer {
		return nil, fmt.Errorf("discovery issuer %q does not match %q", disc.Issuer, a.cfg.Issuer)
	}
	var set struct {
		Keys []jwk `json:"keys"`
	}
	if err := a.getJSON(ctx, disc.JWKSURI, &set); err != nil {
		return nil, err
	}
	keys := map[string]crypto.PublicKey{}
	for _, k := range set.Keys {
		if k.Use != "" && k.Use != "sig" {
			continue
		}
		if pk := k.publicKey(); pk != nil {
			keys[k.Kid] = pk
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("JWKS has no usable signing keys")
	}
	return keys, nil
}

func (k jwk) publicKey() crypto.PublicKey {
	switch k.Kty {
	case "RSA":
		n, err1 := b64(k.N)
		e, err2 := b64(k.E)
		if err1 != nil || err2 != nil || len(n) < 256 || len(e) == 0 || len(e) > 4 {
			return nil // also refuses RSA keys under 2048 bits
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	case "EC":
		var curve elliptic.Curve
		switch k.Crv {
		case "P-256":
			curve = elliptic.P256()
		case "P-384":
			curve = elliptic.P384()
		default:
			return nil
		}
		x, err1 := b64(k.X)
		y, err2 := b64(k.Y)
		if err1 != nil || err2 != nil {
			return nil
		}
		pk := &ecdsa.PublicKey{Curve: curve, X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		if !curve.IsOnCurve(pk.X, pk.Y) {
			return nil
		}
		return pk
	}
	return nil
}

// ---- session exchange ------------------------------------------------------------

// createSession is POST /v1/auth/session, authenticated with an OIDC ID
// token: it mints a Kingu token for the same member that expires after
// SessionTokenTTL (or with the ID token's member being removed).
func (s *Server) createSession(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if oc.P.Via != "oidc" {
		return 0, nil, errBadRequest("invalid_input", "sign in with an OIDC ID token; personal tokens use POST /v1/tokens")
	}
	if oc.P.AutoJoin {
		// Someone else may have added them meanwhile: keep that role.
		tag, err := tx.Exec(r.Context(), `INSERT INTO members (org_id, user_id, role) VALUES (app_current_org(), $1, $2) ON CONFLICT DO NOTHING`, oc.Actor, oc.P.Role)
		if err != nil {
			return 0, nil, err
		}
		if tag.RowsAffected() == 1 {
			if err := audit(r.Context(), tx, oc, "member.add", "member", "", map[string]any{"user_id": oc.Actor, "role": oc.P.Role, "via": "oidc auto-join"}); err != nil {
				return 0, nil, err
			}
		}
	}
	minted, err := mintTokenTx(r.Context(), tx, oc.Actor, oc.Actor, "SSO session", SessionTokenTTL)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, createTokenResp{MintedToken: *minted, Name: "SSO session"}, nil
}
