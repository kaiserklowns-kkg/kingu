// Package api implements the Kingu team server's JSON HTTP API.
//
// The server stores task METADATA only (projects, tasks, agent runs, audit
// trail, event feed). It must never accept or persist source code, diffs,
// transcripts or secrets.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

const (
	// MaxBodyBytes caps every request body.
	MaxBodyBytes = 64 << 10

	// HeaderOrg identifies the caller's org. Honoured only when Config.Dev is
	// set (KINGU_DEV=1); otherwise callers authenticate with a bearer token.
	HeaderOrg = "X-Kingu-Org"

	// HeaderUser optionally names the acting user for audit/created_by.
	// Dev-only, like HeaderOrg.
	HeaderUser = "X-Kingu-User"

	defaultActor = "dev"
)

// Config tunes the server. The zero value is production-safe (no dev header,
// no dev token endpoint, default limits).
type Config struct {
	// Dev enables the X-Kingu-Org/X-Kingu-User headers and POST /v1/dev/tokens.
	Dev bool
	// RateLimit is the sustained requests/second per credential (default 20).
	RateLimit float64
	// RateBurst is the bucket size per credential (default 40).
	RateBurst int
	// Heartbeat is the SSE keep-alive interval (default 15s).
	Heartbeat time.Duration
	// MaxStreams caps concurrent SSE streams per credential (default 4).
	MaxStreams int
	// PruneInterval is how often expired org_events are deleted (default 10m).
	PruneInterval time.Duration
}

func (c Config) withDefaults() Config {
	if c.RateLimit <= 0 {
		c.RateLimit = 20
	}
	if c.RateBurst <= 0 {
		c.RateBurst = 40
	}
	if c.Heartbeat <= 0 {
		c.Heartbeat = 15 * time.Second
	}
	if c.MaxStreams <= 0 {
		c.MaxStreams = 4
	}
	if c.PruneInterval <= 0 {
		c.PruneInterval = 10 * time.Minute
	}
	return c
}

// Server holds the API's dependencies.
type Server struct {
	pool    *pgxpool.Pool
	logger  *slog.Logger
	cfg     Config
	auth    []Authenticator
	limiter *rateLimiter
	// failLimiter throttles failed authentication attempts per client IP.
	failLimiter *rateLimiter
	broker      *broker
	streams     *streamCounter
}

// New returns a Server backed by pool.
func New(pool *pgxpool.Pool, logger *slog.Logger, cfg Config) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	cfg = cfg.withDefaults()
	s := &Server{
		pool:        pool,
		logger:      logger,
		cfg:         cfg,
		limiter:     newRateLimiter(cfg.RateLimit, cfg.RateBurst),
		failLimiter: newRateLimiter(1, 20),
		broker:      newBroker(pool, logger),
		streams:     &streamCounter{n: map[string]int{}},
	}
	// TODO(auth/OIDC): prepend an OIDC Authenticator here (see auth.go).
	s.auth = []Authenticator{&tokenAuthenticator{pool: pool}}
	if cfg.Dev {
		s.auth = append(s.auth, devHeaderAuthenticator{})
	}
	return s
}

// Start runs the background workers (LISTEN/NOTIFY fan-out for /v1/events and
// event retention) until ctx is done. Without it SSE clients still receive
// events, but only at heartbeat granularity.
func (s *Server) Start(ctx context.Context) {
	go s.broker.run(ctx)
	go s.pruneLoop(ctx)
}

// Handler returns the fully wired HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)

	mux.Handle("GET /v1/me", s.org(s.me))
	mux.Handle("POST /v1/projects", s.org(s.createProject))
	mux.Handle("GET /v1/projects", s.org(s.listProjects))
	mux.Handle("POST /v1/projects/{id}/tasks", s.org(s.createTask))
	mux.Handle("GET /v1/projects/{id}/tasks", s.org(s.listTasks))
	mux.Handle("GET /v1/tasks", s.org(s.listOrgTasks))
	mux.Handle("PATCH /v1/tasks/{id}", s.org(s.patchTask))
	mux.Handle("PUT /v1/tasks/{id}/sync", s.org(s.syncTask))
	mux.Handle("POST /v1/tasks/{id}/runs", s.org(s.createRun))
	mux.Handle("PUT /v1/tasks/{id}/runs/{run}/sync", s.org(s.syncRun))
	mux.Handle("GET /v1/runs", s.org(s.listRuns))
	mux.Handle("GET /v1/snaps", s.org(s.listSnaps))
	mux.Handle("PUT /v1/snaps/{id}", s.org(s.putSnap))
	mux.Handle("DELETE /v1/snaps/{id}", s.org(s.deleteSnap))
	mux.HandleFunc("GET /v1/events", s.handleEvents)
	if s.cfg.Dev {
		mux.HandleFunc("POST /v1/dev/tokens", s.handleDevMintToken)
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, errNotFound("route not found"))
	})
	return s.recoverer(s.logRequests(mux))
}

// ---- errors ---------------------------------------------------------------

type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func errBadRequest(code, msg string) *apiError {
	return &apiError{Status: http.StatusBadRequest, Code: code, Message: msg}
}
func errNotFound(msg string) *apiError {
	return &apiError{Status: http.StatusNotFound, Code: "not_found", Message: msg}
}

var (
	errMissingOrg = &apiError{Status: http.StatusUnauthorized, Code: "missing_org",
		Message: "Authorization: Bearer token or (dev) header " + HeaderOrg + " is required"}
	errUnknownOrg = &apiError{Status: http.StatusForbidden, Code: "unknown_org",
		Message: "org does not exist or is not accessible"}
	errInternal = &apiError{Status: http.StatusInternalServerError, Code: "internal",
		Message: "internal server error"}
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, e *apiError) {
	writeJSON(w, e.Status, map[string]*apiError{"error": e})
}

// ---- authentication, rate limiting, org-scoped handler plumbing ------------

type orgCtx struct {
	OrgID string
	Actor string
	P     *Principal
}

type orgHandler func(r *http.Request, oc orgCtx, tx pgx.Tx) (status int, body any, err error)

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// authenticate resolves the caller and applies the per-credential rate limit.
// On failure it has already written the error response.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	var p *Principal
	for _, a := range s.auth {
		got, err := a.Authenticate(r.Context(), r)
		if err != nil {
			e := s.toAPIError(r, err)
			if e.Status == http.StatusUnauthorized {
				// Slow down token guessing from one address.
				if ok, wait := s.failLimiter.allow("ip:" + clientIP(r)); !ok {
					writeRateLimited(w, wait)
					return nil, false
				}
			}
			writeError(w, e)
			return nil, false
		}
		if got != nil {
			p = got
			break
		}
	}
	if p == nil {
		if s.cfg.Dev {
			writeError(w, errMissingOrg)
		} else {
			writeError(w, errMissingCredentials)
		}
		return nil, false
	}
	if ok, wait := s.limiter.allow(p.Key); !ok {
		writeRateLimited(w, wait)
		return nil, false
	}
	return p, true
}

func writeRateLimited(w http.ResponseWriter, wait time.Duration) {
	secs := max(int(math.Ceil(wait.Seconds())), 1)
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeError(w, &apiError{Status: http.StatusTooManyRequests, Code: "rate_limited",
		Message: "too many requests; retry later"})
}

// org authenticates the caller, then runs h inside a transaction with
// app.org_id set so RLS scopes every query to the caller's org.
func (s *Server) org(h orgHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !p.canWrite() {
			writeError(w, errForbidden)
			return
		}
		oc := orgCtx{OrgID: p.OrgID, Actor: p.UserID, P: p}

		// Read the (capped) body before opening a transaction so a slow
		// client can never hold a database transaction open.
		if r.Body != nil {
			buf, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
			if err != nil {
				var maxErr *http.MaxBytesError
				if errors.As(err, &maxErr) {
					writeError(w, &apiError{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large",
						Message: fmt.Sprintf("request body exceeds %d bytes", MaxBodyBytes)})
					return
				}
				writeError(w, errBadRequest("invalid_body", "could not read request body"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(buf))
		}

		var (
			status int
			body   any
		)
		err := db.WithOrg(r.Context(), s.pool, oc.OrgID, func(tx pgx.Tx) error {
			var exists bool
			// RLS on orgs only exposes the row whose id == app.org_id.
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM orgs)`).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return errUnknownOrg
			}
			var err error
			status, body, err = h(r, oc, tx)
			return err
		})
		if err != nil {
			writeError(w, s.toAPIError(r, err))
			return
		}
		writeJSON(w, status, body)
	})
}

func (s *Server) toAPIError(r *http.Request, err error) *apiError {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return &apiError{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large", Message: "request body too large"}
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return &apiError{Status: http.StatusConflict, Code: "conflict", Message: "resource already exists"}
		case "23514", "23502", "22001": // check / not-null / string too long
			return errBadRequest("invalid_input", "input violates a database constraint")
		case "23503": // foreign_key_violation
			return errNotFound("referenced resource not found")
		}
	}
	if errors.Is(err, context.Canceled) {
		return &apiError{Status: 499, Code: "canceled", Message: "request canceled"}
	}
	s.logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	return errInternal
}

// decodeJSON strictly decodes a single JSON object from the request body.
// The body has already been read and size-capped by (*Server).org.
func decodeJSON(r *http.Request, dst any) error {
	ct := r.Header.Get("Content-Type")
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil || mt != "application/json" {
		return &apiError{Status: http.StatusUnsupportedMediaType, Code: "unsupported_media_type",
			Message: "Content-Type must be application/json"}
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return errBadRequest("invalid_json", "request body is empty")
		}
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return err
		}
		msg := err.Error()
		if strings.HasPrefix(msg, "json: unknown field") {
			return errBadRequest("unknown_field", strings.TrimPrefix(msg, "json: "))
		}
		return errBadRequest("invalid_json", "request body is not valid JSON for this endpoint")
	}
	if dec.More() {
		return errBadRequest("invalid_json", "request body must contain a single JSON object")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errBadRequest("invalid_json", "trailing data after JSON object")
	}
	return nil
}

func audit(ctx context.Context, tx pgx.Tx, oc orgCtx, action, targetType, targetID string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO audit_log (org_id, actor, action, target_type, target_id, details)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5)`,
		oc.Actor, action, targetType, targetID, details)
	return err
}

// ---- middleware ------------------------------------------------------------

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach Flush/SetWriteDeadline (SSE).
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.logger.Info("http request", "method", r.Method, "path", r.URL.Path,
			"status", rec.status, "duration", time.Since(start))
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.logger.Error("panic in handler", "method", r.Method, "path", r.URL.Path, "panic", v)
				writeError(w, errInternal)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---- health ----------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		s.logger.Warn("health: database ping failed", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "degraded", "database": "unreachable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "database": "ok"})
}
