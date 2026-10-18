package api

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// The team Snap catalog: which snaps an org approved, pinned to a git commit
// and manifest hash. Metadata only; the snap code stays in its git repo.

const (
	maxSnapNameLen    = 100
	maxSnapVersionLen = 100
	maxSnapNoteLen    = 500
	maxSnapSecrets    = 32
)

var (
	// Same rule as the desktop (snap::is_snap_id).
	snapIDRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	commitSHARe  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256HexRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	secretNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
)

// snapPermissions mirrors the desktop's declared `[permissions]` of snap.toml.
type snapPermissions struct {
	Network bool     `json:"network"`
	FS      string   `json:"fs"`
	Secrets []string `json:"secrets"`
}

type teamSnap struct {
	SnapID         string          `json:"snap_id"`
	Name           string          `json:"name"`
	Version        string          `json:"version"`
	GitURL         string          `json:"git_url"`
	GitRef         *string         `json:"git_ref"`
	CommitSHA      string          `json:"commit_sha"`
	ManifestSHA256 string          `json:"manifest_sha256"`
	Permissions    snapPermissions `json:"permissions"`
	ApprovedBy     string          `json:"approved_by"`
	ApprovedAt     time.Time       `json:"approved_at"`
	Required       bool            `json:"required"`
	Note           *string         `json:"note"`
}

const teamSnapCols = `snap_id, name, version, git_url, git_ref, commit_sha, manifest_sha256, permissions,
	approved_by, approved_at, required, note`

func scanTeamSnap(row pgx.Row) (teamSnap, error) {
	var s teamSnap
	err := row.Scan(&s.SnapID, &s.Name, &s.Version, &s.GitURL, &s.GitRef, &s.CommitSHA, &s.ManifestSHA256,
		&s.Permissions, &s.ApprovedBy, &s.ApprovedAt, &s.Required, &s.Note)
	if s.Permissions.Secrets == nil {
		s.Permissions.Secrets = []string{}
	}
	return s, err
}

func pathSnapID(r *http.Request) (string, error) {
	id := r.PathValue("id")
	if !snapIDRe.MatchString(id) {
		return "", errBadRequest("invalid_input", "snap id must match ^[a-z0-9][a-z0-9-]{0,39}$")
	}
	return id, nil
}

// listSnaps is GET /v1/snaps: every member (viewers included) may read it.
func (s *Server) listSnaps(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	rows, err := tx.Query(r.Context(), `SELECT `+teamSnapCols+` FROM team_snaps ORDER BY snap_id`)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (teamSnap, error) { return scanTeamSnap(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[teamSnap]{Items: items}, nil
}

type putSnapReq struct {
	Name           string           `json:"name"`
	Version        string           `json:"version"`
	GitURL         string           `json:"git_url"`
	GitRef         *string          `json:"git_ref"`
	CommitSHA      string           `json:"commit_sha"`
	ManifestSHA256 string           `json:"manifest_sha256"`
	Permissions    *snapPermissions `json:"permissions"`
	Required       bool             `json:"required"`
	Note           *string          `json:"note"`
}

func (req *putSnapReq) validate() *apiError {
	if err := checkText("name", req.Name, maxSnapNameLen, true); err != nil {
		return err
	}
	if err := checkText("version", req.Version, maxSnapVersionLen, true); err != nil {
		return err
	}
	if err := checkGitURL("git_url", req.GitURL); err != nil {
		return err
	}
	if req.GitRef != nil {
		if err := checkRef("git_ref", *req.GitRef); err != nil {
			return err
		}
	}
	if !commitSHARe.MatchString(req.CommitSHA) {
		return errBadRequest("invalid_input", "commit_sha must be 40 lowercase hex characters")
	}
	if !sha256HexRe.MatchString(req.ManifestSHA256) {
		return errBadRequest("invalid_input", "manifest_sha256 must be 64 lowercase hex characters")
	}
	if req.Permissions == nil {
		return errBadRequest("invalid_input", "permissions is required")
	}
	p := req.Permissions
	if p.FS == "" {
		p.FS = "worktree"
	}
	if p.FS != "worktree" && p.FS != "home" {
		return errBadRequest("invalid_input", "permissions.fs must be worktree or home")
	}
	if len(p.Secrets) > maxSnapSecrets {
		return errBadRequest("invalid_input", "permissions.secrets has too many entries")
	}
	for _, name := range p.Secrets {
		if !secretNameRe.MatchString(name) {
			return errBadRequest("invalid_input", "permissions.secrets must hold secret names ([A-Za-z0-9_.-]{1,64}), never values")
		}
	}
	if p.Secrets == nil {
		p.Secrets = []string{}
	}
	if req.Note != nil {
		if err := checkText("note", *req.Note, maxSnapNoteLen, true); err != nil {
			return err
		}
		if secretRe.MatchString(*req.Note) {
			return errContent
		}
	}
	return nil
}

// putSnap is PUT /v1/snaps/{id} (owner/lead): approves the snap at exactly
// this commit and manifest hash, replacing an earlier approval of the same id.
func (s *Server) putSnap(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	id, err := pathSnapID(r)
	if err != nil {
		return 0, nil, err
	}
	var req putSnapReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := req.validate(); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var (
		out     teamSnap
		rowID   string
		created bool
	)
	row := tx.QueryRow(ctx,
		`INSERT INTO team_snaps (org_id, snap_id, name, version, git_url, git_ref, commit_sha, manifest_sha256,
		                         permissions, approved_by, approved_at, required, note)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11)
		 ON CONFLICT (org_id, snap_id) DO UPDATE SET
		     name = EXCLUDED.name, version = EXCLUDED.version, git_url = EXCLUDED.git_url,
		     git_ref = EXCLUDED.git_ref, commit_sha = EXCLUDED.commit_sha,
		     manifest_sha256 = EXCLUDED.manifest_sha256, permissions = EXCLUDED.permissions,
		     approved_by = EXCLUDED.approved_by, approved_at = now(),
		     required = EXCLUDED.required, note = EXCLUDED.note
		 RETURNING `+teamSnapCols+`, id::text, (xmax = 0)`,
		id, req.Name, req.Version, req.GitURL, req.GitRef, req.CommitSHA, req.ManifestSHA256,
		req.Permissions, oc.Actor, req.Required, req.Note)
	if err := row.Scan(&out.SnapID, &out.Name, &out.Version, &out.GitURL, &out.GitRef, &out.CommitSHA,
		&out.ManifestSHA256, &out.Permissions, &out.ApprovedBy, &out.ApprovedAt, &out.Required, &out.Note,
		&rowID, &created); err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "snap.approve", "team_snap", rowID, map[string]any{
		"snap_id": id, "version": out.Version, "commit_sha": out.CommitSHA, "required": out.Required,
	}); err != nil {
		return 0, nil, err
	}
	if created {
		return http.StatusCreated, out, nil
	}
	return http.StatusOK, out, nil
}

// deleteSnap is DELETE /v1/snaps/{id} (owner/lead). Desktops keep what they
// installed; the snap only leaves the team catalog.
func (s *Server) deleteSnap(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	id, err := pathSnapID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var rowID string
	err = tx.QueryRow(ctx, `DELETE FROM team_snaps WHERE snap_id = $1 RETURNING id::text`, id).Scan(&rowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("snap not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "snap.remove", "team_snap", rowID, map[string]any{"snap_id": id}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"snap_id": id, "deleted": true}, nil
}
