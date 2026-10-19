package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Team artifacts: pages an agent made that a member explicitly shared with
// the org (one self-contained HTML file, assets inlined), for teammates to
// open read-only. The one place the server keeps content rather than
// metadata: capped at MaxArtifactHTMLBytes and refused when it looks like it
// carries a credential. Lists and events never include the page.

const (
	// MaxArtifactHTMLBytes caps a shared page.
	MaxArtifactHTMLBytes = 2 << 20
	// MaxArtifactBodyBytes caps PUT /v1/artifacts/{id} (the page JSON-escaped, plus metadata).
	MaxArtifactBodyBytes = 3 << 20

	maxArtifactTitleLen = 200
	maxArtifactDescLen  = 1000
	maxArtifactVersion  = 1_000_000
)

// Same rule as the desktop's artifact ids.
var artifactIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

var errArtifactTooLarge = &apiError{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large",
	Message: "html must be at most 2 MiB"}

type teamArtifact struct {
	ArtifactID  string    `json:"artifact_id"`
	Title       string    `json:"title"`
	Description *string   `json:"description"`
	Format      string    `json:"format"`
	Version     int       `json:"version"`
	SizeBytes   int       `json:"size_bytes"`
	SHA256      string    `json:"sha256"`
	SharedBy    string    `json:"shared_by"`
	SharedAt    time.Time `json:"shared_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type teamArtifactWithHTML struct {
	teamArtifact
	HTML string `json:"html"`
}

const teamArtifactCols = `artifact_id, title, description, format, version, size_bytes, sha256, shared_by, shared_at, updated_at`

func scanTeamArtifact(row pgx.Row, extra ...any) (teamArtifact, error) {
	var a teamArtifact
	dst := append([]any{&a.ArtifactID, &a.Title, &a.Description, &a.Format, &a.Version, &a.SizeBytes, &a.SHA256,
		&a.SharedBy, &a.SharedAt, &a.UpdatedAt}, extra...)
	err := row.Scan(dst...)
	return a, err
}

func pathArtifactID(r *http.Request) (string, error) {
	id := r.PathValue("id")
	if !artifactIDRe.MatchString(id) {
		return "", errBadRequest("invalid_input", "artifact id must be 16 lowercase hex characters")
	}
	return id, nil
}

// listArtifacts is GET /v1/artifacts: every member (viewers included), newest first, without the pages.
func (s *Server) listArtifacts(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	rows, err := tx.Query(r.Context(), `SELECT `+teamArtifactCols+` FROM team_artifacts ORDER BY updated_at DESC, artifact_id`)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (teamArtifact, error) { return scanTeamArtifact(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[teamArtifact]{Items: items}, nil
}

// getArtifact is GET /v1/artifacts/{id}: the metadata and the page.
func (s *Server) getArtifact(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathArtifactID(r)
	if err != nil {
		return 0, nil, err
	}
	var html string
	a, err := scanTeamArtifact(tx.QueryRow(r.Context(),
		`SELECT `+teamArtifactCols+`, html FROM team_artifacts WHERE artifact_id = $1`, id), &html)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("artifact not found")
	}
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, teamArtifactWithHTML{teamArtifact: a, HTML: html}, nil
}

type putArtifactReq struct {
	Title       string  `json:"title"`
	Description *string `json:"description"`
	Format      string  `json:"format"`
	Version     int     `json:"version"`
	HTML        string  `json:"html"`
}

func (req *putArtifactReq) validate() *apiError {
	if err := checkText("title", req.Title, maxArtifactTitleLen, true); err != nil {
		return err
	}
	if req.Description != nil {
		if err := checkText("description", *req.Description, maxArtifactDescLen, true); err != nil {
			return err
		}
	}
	if req.Format != "html" && req.Format != "markdown" {
		return errBadRequest("invalid_input", "format must be html or markdown")
	}
	if req.Version < 1 || req.Version > maxArtifactVersion {
		return errBadRequest("invalid_input", "version must be between 1 and 1000000")
	}
	if req.HTML == "" {
		return errBadRequest("invalid_input", "html is required")
	}
	if len(req.HTML) > MaxArtifactHTMLBytes {
		return errArtifactTooLarge
	}
	if !utf8.ValidString(req.HTML) {
		return errBadRequest("invalid_input", "html must be valid UTF-8")
	}
	// A page is code by nature; what the server still refuses is a credential in it.
	for _, text := range []string{req.Title, req.HTML} {
		if secretRe.MatchString(text) {
			return errContent
		}
	}
	if req.Description != nil && secretRe.MatchString(*req.Description) {
		return errContent
	}
	return nil
}

// putArtifact is PUT /v1/artifacts/{id} (any member who may write): shares the
// page, or replaces an earlier share of the same artifact. Only whoever shared
// it, or an owner/lead, may replace it.
func (s *Server) putArtifact(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathArtifactID(r)
	if err != nil {
		return 0, nil, err
	}
	var req putArtifactReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := req.validate(); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var owner string
	err = tx.QueryRow(ctx, `SELECT shared_by FROM team_artifacts WHERE artifact_id = $1 FOR UPDATE`, id).Scan(&owner)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, err
	}
	if exists && owner != oc.Actor && !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	sum := sha256.Sum256([]byte(req.HTML))
	var rowID string
	var row pgx.Row
	if exists {
		// The original sharer stays shared_by; updated_at says when it changed.
		row = tx.QueryRow(ctx,
			`UPDATE team_artifacts SET title = $2, description = $3, format = $4, version = $5, html = $6,
			     sha256 = $7, size_bytes = $8, updated_at = now()
			 WHERE artifact_id = $1
			 RETURNING `+teamArtifactCols+`, id::text`,
			id, req.Title, req.Description, req.Format, req.Version, req.HTML, hex.EncodeToString(sum[:]), len(req.HTML))
	} else {
		row = tx.QueryRow(ctx,
			`INSERT INTO team_artifacts (org_id, artifact_id, title, description, format, version, html, sha256, size_bytes, shared_by)
			 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
			 RETURNING `+teamArtifactCols+`, id::text`,
			id, req.Title, req.Description, req.Format, req.Version, req.HTML, hex.EncodeToString(sum[:]), len(req.HTML), oc.Actor)
	}
	out, err := scanTeamArtifact(row, &rowID)
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "artifact.share", "team_artifact", rowID, map[string]any{
		"artifact_id": id, "version": out.Version, "size_bytes": out.SizeBytes, "sha256": out.SHA256,
	}); err != nil {
		return 0, nil, err
	}
	if exists {
		return http.StatusOK, out, nil
	}
	return http.StatusCreated, out, nil
}

// deleteArtifact is DELETE /v1/artifacts/{id}: whoever shared it, or an owner/lead.
func (s *Server) deleteArtifact(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathArtifactID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var owner string
	err = tx.QueryRow(ctx, `SELECT shared_by FROM team_artifacts WHERE artifact_id = $1 FOR UPDATE`, id).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("artifact not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if owner != oc.Actor && !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	var rowID string
	if err := tx.QueryRow(ctx, `DELETE FROM team_artifacts WHERE artifact_id = $1 RETURNING id::text`, id).Scan(&rowID); err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "artifact.remove", "team_artifact", rowID, map[string]any{"artifact_id": id}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"artifact_id": id, "deleted": true}, nil
}
