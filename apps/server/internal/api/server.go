// Package api implements the Kingu team server's JSON HTTP API.
//
// The server stores task METADATA only (projects, tasks, agent runs, audit
// trail). It must never accept or persist source code, diffs, transcripts or
// secrets.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
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

	// HeaderOrg identifies the caller's org.
	//
	// TODO(auth): dev-only. Replace with OIDC bearer tokens; the org (and the
	// member's role) must come from verified claims + the members table, never
	// from a client-supplied header.
	HeaderOrg = "X-Kingu-Org"

	// HeaderUser optionally names the acting user for audit/created_by.
	//
	// TODO(auth): dev-only, replaced by the OIDC subject.
	HeaderUser = "X-Kingu-User"

	defaultActor = "dev"
)

// Server holds the API's dependencies.
type Server struct {
	pool   *pgxpool.Pool
	logger *slog.Logger
}

// New returns a Server backed by pool.
func New(pool *pgxpool.Pool, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{pool: pool, logger: logger}
}

// Handler returns the fully wired HTTP handler.
//
// TODO(ops): add per-org/per-IP rate limiting before exposing beyond localhost.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)

	mux.Handle("POST /v1/projects", s.org(s.createProject))
	mux.Handle("GET /v1/projects", s.org(s.listProjects))
	mux.Handle("POST /v1/projects/{id}/tasks", s.org(s.createTask))
	mux.Handle("GET /v1/projects/{id}/tasks", s.org(s.listTasks))
	mux.Handle("PATCH /v1/tasks/{id}", s.org(s.patchTask))
	mux.Handle("POST /v1/tasks/{id}/runs", s.org(s.createRun))

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
		Message: "header " + HeaderOrg + " (uuid) is required"}
	errUnknownOrg = &apiError{Status: http.StatusForbidden, Code: "unknown_org",
		Message: "org does not exist or is not accessible"}
	errInternal = &apiError{Status: http.StatusInternalServerError, Code: "internal",
		Message: "internal server error"}
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, e *apiError) {
	writeJSON(w, e.Status, map[string]*apiError{"error": e})
}

// ---- org-scoped handler plumbing -------------------------------------------

type orgCtx struct {
	OrgID string
	Actor string
}

type orgHandler func(r *http.Request, oc orgCtx, tx pgx.Tx) (status int, body any, err error)

// org authenticates the (dev) org header, then runs h inside a transaction
// with app.org_id set so RLS scopes every query to that org.
func (s *Server) org(h orgHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.Header.Get(HeaderOrg)
		if raw == "" {
			writeError(w, errMissingOrg)
			return
		}
		orgID, ok := parseUUID(raw)
		if !ok {
			writeError(w, &apiError{Status: http.StatusUnauthorized, Code: "invalid_org",
				Message: "header " + HeaderOrg + " must be a uuid"})
			return
		}
		actor := defaultActor
		if u := r.Header.Get(HeaderUser); u != "" {
			if err := checkText("X-Kingu-User", u, 255, true); err != nil {
				writeError(w, err)
				return
			}
			actor = u
		}
		oc := orgCtx{OrgID: orgID, Actor: actor}

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
		err := db.WithOrg(r.Context(), s.pool, orgID, func(tx pgx.Tx) error {
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
