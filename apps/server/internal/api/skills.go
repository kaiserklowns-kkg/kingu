package api

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Team skills: agent skills members shared with their org, pinned to a git
// commit and the skill's content hash. Metadata only; the skill's files stay
// in its git repo and each desktop fetches and checks them itself.

const (
	maxSkillDescriptionLen = 1024
	maxSkillPathLen        = 512
	maxSkillNoteLen        = 500
)

// Same rule as the desktop (skill_hub::package::is_skill_name): a-z, 0-9 and
// single hyphens, at most 64 characters.
var skillNameRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

type teamSkill struct {
	SkillName     string    `json:"skill_name"`
	Description   string    `json:"description"`
	GitURL        string    `json:"git_url"`
	GitRef        *string   `json:"git_ref"`
	Path          string    `json:"path"`
	CommitSHA     string    `json:"commit_sha"`
	ContentSHA256 string    `json:"content_sha256"`
	SharedBy      string    `json:"shared_by"`
	SharedAt      time.Time `json:"shared_at"`
	Note          *string   `json:"note"`
}

const teamSkillCols = `skill_name, description, git_url, git_ref, path, commit_sha, content_sha256, shared_by, shared_at, note`

func scanTeamSkill(row pgx.Row, extra ...any) (teamSkill, error) {
	var s teamSkill
	dest := append([]any{&s.SkillName, &s.Description, &s.GitURL, &s.GitRef, &s.Path, &s.CommitSHA,
		&s.ContentSHA256, &s.SharedBy, &s.SharedAt, &s.Note}, extra...)
	return s, row.Scan(dest...)
}

func pathSkillName(r *http.Request) (string, error) {
	name := r.PathValue("name")
	if len(name) > 64 || !skillNameRe.MatchString(name) {
		return "", errBadRequest("invalid_input", "skill name must be a-z, 0-9 and single hyphens, at most 64 characters")
	}
	return name, nil
}

// checkSkillPath accepts "" or plain folder names joined by "/": no leading
// "/", no "." or ".." parts, no backslashes.
func checkSkillPath(v string) *apiError {
	if v == "" {
		return nil
	}
	if err := checkText("path", v, maxSkillPathLen, true); err != nil {
		return err
	}
	if strings.ContainsAny(v, "\\:") {
		return errBadRequest("invalid_input", "path must be a plain folder path in the repository")
	}
	for _, part := range strings.Split(v, "/") {
		if part == "" || part == "." || part == ".." {
			return errBadRequest("invalid_input", "path must be a plain folder path in the repository")
		}
	}
	return nil
}

// listSkills is GET /v1/skills: every member (viewers included) may read it.
func (s *Server) listSkills(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	rows, err := tx.Query(r.Context(), `SELECT `+teamSkillCols+` FROM team_skills ORDER BY skill_name`)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (teamSkill, error) { return scanTeamSkill(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[teamSkill]{Items: items}, nil
}

type putSkillReq struct {
	Description   string  `json:"description"`
	GitURL        string  `json:"git_url"`
	GitRef        *string `json:"git_ref"`
	Path          string  `json:"path"`
	CommitSHA     string  `json:"commit_sha"`
	ContentSHA256 string  `json:"content_sha256"`
	Note          *string `json:"note"`
}

func (req *putSkillReq) validate() *apiError {
	if err := checkText("description", req.Description, maxSkillDescriptionLen, true); err != nil {
		return err
	}
	if secretRe.MatchString(req.Description) {
		return errContent
	}
	if err := checkGitURL("git_url", req.GitURL); err != nil {
		return err
	}
	if req.GitRef != nil {
		if err := checkRef("git_ref", *req.GitRef); err != nil {
			return err
		}
	}
	if err := checkSkillPath(req.Path); err != nil {
		return err
	}
	if !commitSHARe.MatchString(req.CommitSHA) {
		return errBadRequest("invalid_input", "commit_sha must be 40 lowercase hex characters")
	}
	if !sha256HexRe.MatchString(req.ContentSHA256) {
		return errBadRequest("invalid_input", "content_sha256 must be 64 lowercase hex characters")
	}
	if req.Note != nil {
		if err := checkText("note", *req.Note, maxSkillNoteLen, true); err != nil {
			return err
		}
		if secretRe.MatchString(*req.Note) {
			return errContent
		}
	}
	return nil
}

// putSkill is PUT /v1/skills/{name} (members who can write): shares the skill
// at exactly this commit and content hash. Replacing a skill someone else
// shared needs an owner or lead.
func (s *Server) putSkill(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canWrite() {
		return 0, nil, errForbidden
	}
	name, err := pathSkillName(r)
	if err != nil {
		return 0, nil, err
	}
	var req putSkillReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := req.validate(); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var sharedBy string
	err = tx.QueryRow(ctx, `SELECT shared_by FROM team_skills WHERE skill_name = $1 FOR UPDATE`, name).Scan(&sharedBy)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return 0, nil, err
	case sharedBy != oc.Actor && !oc.P.canAdmin():
		return 0, nil, errForbidden
	}
	var (
		rowID   string
		created bool
	)
	out, err := scanTeamSkill(tx.QueryRow(ctx,
		`INSERT INTO team_skills (org_id, skill_name, description, git_url, git_ref, path, commit_sha,
		                          content_sha256, shared_by, shared_at, note)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
		 ON CONFLICT (org_id, skill_name) DO UPDATE SET
		     description = EXCLUDED.description, git_url = EXCLUDED.git_url, git_ref = EXCLUDED.git_ref,
		     path = EXCLUDED.path, commit_sha = EXCLUDED.commit_sha, content_sha256 = EXCLUDED.content_sha256,
		     shared_by = EXCLUDED.shared_by, shared_at = now(), note = EXCLUDED.note
		 RETURNING `+teamSkillCols+`, id::text, (xmax = 0)`,
		name, req.Description, req.GitURL, req.GitRef, req.Path, req.CommitSHA, req.ContentSHA256, oc.Actor, req.Note),
		&rowID, &created)
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "skill.share", "team_skill", rowID, map[string]any{
		"skill_name": name, "commit_sha": out.CommitSHA,
	}); err != nil {
		return 0, nil, err
	}
	if created {
		return http.StatusCreated, out, nil
	}
	return http.StatusOK, out, nil
}

// deleteSkill is DELETE /v1/skills/{name}: by whoever shared it, or an owner
// or lead. Desktops keep what they installed; the skill only leaves the list.
func (s *Server) deleteSkill(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canWrite() {
		return 0, nil, errForbidden
	}
	name, err := pathSkillName(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var rowID, sharedBy string
	err = tx.QueryRow(ctx, `SELECT id::text, shared_by FROM team_skills WHERE skill_name = $1 FOR UPDATE`, name).Scan(&rowID, &sharedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("skill not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if sharedBy != oc.Actor && !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	if _, err := tx.Exec(ctx, `DELETE FROM team_skills WHERE id = $1`, rowID); err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "skill.unshare", "team_skill", rowID, map[string]any{"skill_name": name}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"skill_name": name, "deleted": true}, nil
}
