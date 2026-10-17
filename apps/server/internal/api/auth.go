package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Principal is the authenticated caller of a request. Every org-scoped query
// runs with app.org_id = OrgID, so RLS limits the caller to that org.
type Principal struct {
	OrgID  string
	UserID string
	Role   string // owner | lead | dev | viewer
	// Key identifies the credential for rate limiting and stream caps
	// ("tok:<token id>" or "dev:<org>:<user>").
	Key string
	// TokenPrefix is the display prefix of the token used, if any.
	TokenPrefix string
}

// canWrite reports whether the principal may mutate data.
func (p *Principal) canWrite() bool { return p.Role != "viewer" }

// Authenticator turns request credentials into a Principal.
//
// Implementations return (nil, nil) when the request carries no credential of
// their kind, so several can be chained; an *apiError means the credential was
// present but rejected.
//
// TODO(auth/OIDC): add an OIDCAuthenticator that verifies `Authorization:
// Bearer <JWT>` against the issuer's JWKS (iss, aud, exp, nbf), maps the
// issuer-scoped subject to members.user_id and derives OrgID from a verified
// org claim (or a per-org issuer). Wire it in New() ahead of the PAT
// authenticator for bearer values that do not start with TokenPrefix.
type Authenticator interface {
	Authenticate(ctx context.Context, r *http.Request) (*Principal, error)
}

// TokenPrefix starts every Kingu personal access token.
const TokenPrefix = "kgu_"

const (
	tokenRandomBytes = 32
	tokenLen         = len(TokenPrefix) + 43 // base64url, no padding, of 32 bytes
	tokenDisplayLen  = len(TokenPrefix) + 8
)

var (
	errMissingCredentials = &apiError{Status: http.StatusUnauthorized, Code: "missing_token",
		Message: "Authorization: Bearer " + TokenPrefix + "... is required"}
	errInvalidToken = &apiError{Status: http.StatusUnauthorized, Code: "invalid_token",
		Message: "token is invalid, expired or revoked"}
	errForbidden = &apiError{Status: http.StatusForbidden, Code: "forbidden",
		Message: "this role may not perform the operation"}
)

// HashToken returns the SHA-256 of the full plaintext token.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// wellFormedToken checks the shape of a PAT without touching the database.
func wellFormedToken(t string) bool {
	if len(t) != tokenLen || !strings.HasPrefix(t, TokenPrefix) {
		return false
	}
	for _, c := range t[len(TokenPrefix):] {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// MintedToken is returned once, at creation; the plaintext is never stored.
type MintedToken struct {
	ID        string     `json:"id"`
	Token     string     `json:"token"`
	Prefix    string     `json:"prefix"`
	OrgID     string     `json:"org_id"`
	UserID    string     `json:"user_id"`
	Role      string     `json:"role"`
	ExpiresAt *time.Time `json:"expires_at"`
}

// MintToken creates a personal access token for (orgID, userID), adding the
// user as a member with role if they are not one yet. The org must exist.
func MintToken(ctx context.Context, pool *pgxpool.Pool, orgID, userID, role, name string, ttl time.Duration) (*MintedToken, error) {
	if role == "" {
		role = "dev"
	}
	var raw [tokenRandomBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, fmt.Errorf("random token: %w", err)
	}
	token := TokenPrefix + base64.RawURLEncoding.EncodeToString(raw[:])
	out := &MintedToken{Token: token, Prefix: token[:tokenDisplayLen], OrgID: orgID, UserID: userID}
	err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, orgID); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM orgs)`).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errUnknownOrg
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO members (org_id, user_id, role) VALUES (app_current_org(), $1, $2)
			 ON CONFLICT (org_id, user_id) DO NOTHING`, userID, role); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT role FROM members WHERE user_id = $1`, userID).Scan(&out.Role); err != nil {
			return err
		}
		var expires *time.Time
		if ttl > 0 {
			t := time.Now().Add(ttl).UTC().Truncate(time.Second)
			expires = &t
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO api_tokens (org_id, user_id, name, token_hash, prefix, expires_at)
			 VALUES (app_current_org(), $1, $2, $3, $4, $5)
			 RETURNING id::text, expires_at`,
			userID, name, HashToken(token), out.Prefix, expires).Scan(&out.ID, &out.ExpiresAt); err != nil {
			return err
		}
		// Audit without the token itself; the prefix is enough to identify it.
		_, err := tx.Exec(ctx,
			`INSERT INTO audit_log (org_id, actor, action, target_type, target_id, details)
			 VALUES (app_current_org(), $1, 'token.create', 'api_token', $2, $3)`,
			userID, out.ID, map[string]any{"prefix": out.Prefix, "name": name})
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// tokenAuthenticator validates `Authorization: Bearer kgu_...` personal
// access tokens against api_tokens (stored hashed) and members.
type tokenAuthenticator struct {
	pool *pgxpool.Pool
}

func bearer(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if h == "" {
		return "", false
	}
	scheme, value, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", true
	}
	return strings.TrimSpace(value), true
}

func (a *tokenAuthenticator) Authenticate(ctx context.Context, r *http.Request) (*Principal, error) {
	tok, present := bearer(r)
	if !present {
		return nil, nil
	}
	if !wellFormedToken(tok) {
		// TODO(auth/OIDC): JWT bearer tokens go to the OIDC authenticator.
		return nil, errInvalidToken
	}
	hash := hex.EncodeToString(HashToken(tok))
	p := &Principal{}
	err := pgx.BeginTxFunc(ctx, a.pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.token_hash', $1, true)`, hash); err != nil {
			return err
		}
		var (
			id                 string
			lastUsed           *time.Time
			expires, revokedAt *time.Time
		)
		err := tx.QueryRow(ctx,
			`SELECT id::text, org_id::text, user_id, prefix, last_used_at, expires_at, revoked_at
			   FROM api_tokens WHERE token_hash = app_current_token_hash()`).
			Scan(&id, &p.OrgID, &p.UserID, &p.TokenPrefix, &lastUsed, &expires, &revokedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvalidToken
		}
		if err != nil {
			return err
		}
		now := time.Now()
		if revokedAt != nil || (expires != nil && !now.Before(*expires)) {
			return errInvalidToken
		}
		p.Key = "tok:" + id
		// The membership decides the role; a removed member's tokens stop working.
		if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, p.OrgID); err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT role FROM members WHERE user_id = $1`, p.UserID).Scan(&p.Role)
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvalidToken
		}
		if err != nil {
			return err
		}
		if lastUsed == nil || now.Sub(*lastUsed) > time.Minute {
			_, err = tx.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE token_hash = app_current_token_hash()`)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

// devHeaderAuthenticator trusts X-Kingu-Org / X-Kingu-User. Only installed
// when KINGU_DEV=1; never use it on a reachable server.
type devHeaderAuthenticator struct{}

func (devHeaderAuthenticator) Authenticate(_ context.Context, r *http.Request) (*Principal, error) {
	raw := r.Header.Get(HeaderOrg)
	if raw == "" {
		return nil, nil
	}
	orgID, ok := parseUUID(raw)
	if !ok {
		return nil, &apiError{Status: http.StatusUnauthorized, Code: "invalid_org",
			Message: "header " + HeaderOrg + " must be a uuid"}
	}
	actor := defaultActor
	if u := r.Header.Get(HeaderUser); u != "" {
		if err := checkText(HeaderUser, u, 255, true); err != nil {
			return nil, err
		}
		actor = u
	}
	return &Principal{OrgID: orgID, UserID: actor, Role: "owner", Key: "dev:" + orgID + ":" + actor}, nil
}

// ---- dev token minting -------------------------------------------------------

type devTokenReq struct {
	OrgID    string `json:"org_id"`
	OrgName  string `json:"org_name"`
	UserID   string `json:"user_id"`
	Role     string `json:"role"`
	Name     string `json:"name"`
	TTLHours int    `json:"ttl_hours"`
}

var memberRoles = map[string]bool{"owner": true, "lead": true, "dev": true, "viewer": true}

// handleDevMintToken is POST /v1/dev/tokens, registered only when Dev is on.
// It mints a token for an existing org (org_id) or creates a new org
// (org_name) first, which makes local setup possible without psql.
func (s *Server) handleDevMintToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req devTokenReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, s.toAPIError(r, err))
		return
	}
	if err := checkText("user_id", req.UserID, 255, true); err != nil {
		writeError(w, err)
		return
	}
	if req.Role != "" && !memberRoles[req.Role] {
		writeError(w, errBadRequest("invalid_input", "role must be one of owner, lead, dev, viewer"))
		return
	}
	if err := checkText("name", req.Name, 100, false); err != nil {
		writeError(w, err)
		return
	}
	if req.TTLHours < 0 || req.TTLHours > 24*365 {
		writeError(w, errBadRequest("invalid_input", "ttl_hours must be between 0 (no expiry) and 8760"))
		return
	}
	ctx := r.Context()
	orgID := req.OrgID
	switch {
	case req.OrgID != "" && req.OrgName != "":
		writeError(w, errBadRequest("invalid_input", "give either org_id or org_name, not both"))
		return
	case req.OrgID != "":
		id, ok := parseUUID(req.OrgID)
		if !ok {
			writeError(w, errBadRequest("invalid_input", "org_id must be a uuid"))
			return
		}
		orgID = id
	default:
		if err := checkText("org_name", req.OrgName, 200, true); err != nil {
			writeError(w, err)
			return
		}
		var raw [16]byte
		_, _ = rand.Read(raw[:])
		raw[6] = raw[6]&0x0f | 0x40
		raw[8] = raw[8]&0x3f | 0x80
		h := hex.EncodeToString(raw[:])
		orgID = h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
		err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, orgID); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO orgs (id, name) VALUES ($1, $2)`, orgID, req.OrgName)
			return err
		})
		if err != nil {
			writeError(w, s.toAPIError(r, err))
			return
		}
	}
	role := req.Role
	if role == "" {
		role = "owner"
	}
	minted, err := MintToken(ctx, s.pool, orgID, req.UserID, role, req.Name, time.Duration(req.TTLHours)*time.Hour)
	if err != nil {
		writeError(w, s.toAPIError(r, err))
		return
	}
	s.logger.Info("dev token minted", "org", orgID, "user", req.UserID, "prefix", minted.Prefix)
	writeJSON(w, http.StatusCreated, minted)
}
