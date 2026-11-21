package api

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Org administration: tokens, members, the org's name, the audit log and
// closing runs a desktop never finished.
//
// Roles:
//   - owner: everything, including other members' tokens and owners/leads.
//   - lead:  read the audit log; add, change and remove dev/viewer members.
//   - dev:   their own tokens; close their own runs.
//   - viewer: read-only, except creating and revoking their own tokens.

const (
	// maxActiveTokensPerUser caps tokens that are neither revoked nor expired.
	maxActiveTokensPerUser = 50
	// defaultTokenTTL applies when POST /v1/tokens omits ttl_hours.
	defaultTokenTTL  = 90 * 24 * time.Hour
	maxTokenTTLHours = 24 * 365
	// maxClockSkew bounds client timestamps in the future (as task sync does).
	maxClockSkew = 24 * time.Hour
)

// ---- tokens ------------------------------------------------------------------

type apiToken struct {
	ID         string     `json:"id"`
	UserID     string     `json:"user_id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
	// Current is true for the token that authenticated this request.
	Current bool `json:"current"`
}

const tokenCols = `id::text, user_id, name, prefix, created_at, last_used_at, expires_at, revoked_at`

func scanToken(row pgx.Row, current string) (apiToken, error) {
	var t apiToken
	err := row.Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.CreatedAt, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt)
	t.Current = current != "" && t.ID == current
	return t, err
}

// listTokens is GET /v1/tokens: the caller's tokens, newest first. Owners may
// pass ?user_id= for one member's tokens or ?all=true for every member's.
func (s *Server) listTokens(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	pg, err := parsePage(r, true, true)
	if err != nil {
		return 0, nil, err
	}
	q := r.URL.Query()
	user := oc.Actor
	all := q.Get("all") == "true"
	if u := q.Get("user_id"); u != "" {
		if err := checkText("user_id", u, 255, true); err != nil {
			return 0, nil, err
		}
		user = u
	}
	if (all || user != oc.Actor) && !oc.P.isOwner() {
		return 0, nil, errForbidden
	}
	rows, err := tx.Query(r.Context(),
		`SELECT `+tokenCols+` FROM api_tokens
		  WHERE ($1 OR user_id = $2)
		    AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid))
		  ORDER BY created_at DESC, id DESC LIMIT $5`,
		all, user, pg.afterTime(), pg.afterID(), pg.Limit+1)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (apiToken, error) { return scanToken(row, oc.P.TokenID) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, pageOf(items, pg.Limit, func(t apiToken) cursor { return cursor{T: &t.CreatedAt, ID: t.ID} }), nil
}

type createTokenReq struct {
	Name string `json:"name"`
	// TTLHours: omitted = 90 days, 0 = never expires, else 1..8760.
	TTLHours *int   `json:"ttl_hours"`
	UserID   string `json:"user_id"`
}

type createTokenResp struct {
	MintedToken
	Name string `json:"name"`
}

// createToken is POST /v1/tokens. Anyone may mint a token for themselves;
// owners may mint one for another member (e.g. right after adding them).
func (s *Server) createToken(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	var req createTokenReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := checkText("name", req.Name, 100, true); err != nil {
		return 0, nil, err
	}
	ttl := defaultTokenTTL
	if req.TTLHours != nil {
		if *req.TTLHours < 0 || *req.TTLHours > maxTokenTTLHours {
			return 0, nil, errBadRequest("invalid_input", "ttl_hours must be between 0 (no expiry) and 8760")
		}
		ttl = time.Duration(*req.TTLHours) * time.Hour
	}
	user := oc.Actor
	if req.UserID != "" && req.UserID != oc.Actor {
		if err := checkText("user_id", req.UserID, 255, true); err != nil {
			return 0, nil, err
		}
		if !oc.P.isOwner() {
			return 0, nil, errForbidden
		}
		user = req.UserID
	}
	ctx := r.Context()
	var isMember bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM members WHERE user_id = $1)`, user).Scan(&isMember); err != nil {
		return 0, nil, err
	}
	if !isMember {
		return 0, nil, errNotFound("member not found")
	}
	var active int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM api_tokens
		  WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
		user).Scan(&active); err != nil {
		return 0, nil, err
	}
	if active >= maxActiveTokensPerUser {
		return 0, nil, &apiError{Status: http.StatusConflict, Code: "too_many_tokens",
			Message: "this member already has 50 active tokens; revoke some first"}
	}
	minted, err := mintTokenTx(ctx, tx, oc.Actor, user, req.Name, ttl)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, createTokenResp{MintedToken: *minted, Name: req.Name}, nil
}

// revokeToken is DELETE /v1/tokens/{id}: the caller's own token, or any
// member's for owners. Revoking twice is a no-op. Other members' tokens look
// missing to non-owners.
func (s *Server) revokeToken(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var wasRevoked bool
	if err := tx.QueryRow(ctx,
		`SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id = $1 AND ($2 OR user_id = $3) FOR UPDATE`,
		id, oc.P.isOwner(), oc.Actor).Scan(&wasRevoked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil, errNotFound("token not found")
		}
		return 0, nil, err
	}
	t, err := scanToken(tx.QueryRow(ctx,
		`UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING `+tokenCols, id),
		oc.P.TokenID)
	if err != nil {
		return 0, nil, err
	}
	if !wasRevoked {
		details := map[string]any{"prefix": t.Prefix, "name": t.Name}
		if t.UserID != oc.Actor {
			details["user_id"] = t.UserID
		}
		if err := audit(ctx, tx, oc, "token.revoke", "api_token", t.ID, details); err != nil {
			return 0, nil, err
		}
	}
	return http.StatusOK, t, nil
}

// ---- members -----------------------------------------------------------------

type member struct {
	UserID       string    `json:"user_id"`
	Role         string    `json:"role"`
	CreatedAt    time.Time `json:"created_at"`
	ActiveTokens int       `json:"active_tokens"`
}

const memberSelect = `SELECT m.user_id, m.role, m.created_at,
	(SELECT count(*) FROM api_tokens t
	  WHERE t.user_id = m.user_id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()))::int
	FROM members m`

func scanMember(row pgx.Row) (member, error) {
	var m member
	err := row.Scan(&m.UserID, &m.Role, &m.CreatedAt, &m.ActiveTokens)
	return m, err
}

// listMembers is GET /v1/members (any member), ordered by user_id.
func (s *Server) listMembers(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	pg, err := parsePage(r, false, false)
	if err != nil {
		return 0, nil, err
	}
	rows, err := tx.Query(r.Context(),
		memberSelect+` WHERE ($1::text IS NULL OR m.user_id > $1) ORDER BY m.user_id LIMIT $2`,
		pg.afterID(), pg.Limit+1)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (member, error) { return scanMember(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, pageOf(items, pg.Limit, func(m member) cursor { return cursor{ID: m.UserID} }), nil
}

// canManageMember: owners manage anyone; leads only dev and viewer members
// ("" = not a member / being removed).
func canManageMember(p *Principal, oldRole, newRole string) bool {
	if p.isOwner() {
		return true
	}
	if p.Role != "lead" {
		return false
	}
	low := func(r string) bool { return r == "" || r == "dev" || r == "viewer" }
	return low(oldRole) && low(newRole)
}

var errLastOwner = &apiError{Status: http.StatusConflict, Code: "last_owner",
	Message: "the org must keep at least one owner"}

// lockMember returns userID's role ("" when not a member) and, when that is
// owner, whether another owner exists. Owner rows are locked so two requests
// cannot demote the last two owners at once.
func lockMember(r *http.Request, tx pgx.Tx, userID string) (role string, otherOwners bool, err error) {
	ctx := r.Context()
	// Exec runs the statement to completion, so every matching row is locked.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM members WHERE role = 'owner' OR user_id = $1 FOR UPDATE`, userID); err != nil {
		return "", false, err
	}
	err = tx.QueryRow(ctx, `SELECT role FROM members WHERE user_id = $1`, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if role == "owner" {
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM members WHERE role = 'owner' AND user_id <> $1)`, userID).Scan(&otherOwners); err != nil {
			return "", false, err
		}
	}
	return role, otherOwners, nil
}

func pathUserID(r *http.Request) (string, error) {
	u := r.PathValue("user")
	if err := checkText("user_id", u, 255, true); err != nil {
		return "", err
	}
	return u, nil
}

type putMemberReq struct {
	Role string `json:"role"`
}

// putMember is PUT /v1/members/{user}: add a member or change their role.
// 201 when added, 200 when changed or unchanged.
func (s *Server) putMember(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	user, err := pathUserID(r)
	if err != nil {
		return 0, nil, err
	}
	var req putMemberReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if !memberRoles[req.Role] {
		return 0, nil, errBadRequest("invalid_input", "role must be one of owner, lead, dev, viewer")
	}
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	old, otherOwners, err := lockMember(r, tx, user)
	if err != nil {
		return 0, nil, err
	}
	if !canManageMember(oc.P, old, req.Role) {
		return 0, nil, errForbidden
	}
	if old == "owner" && req.Role != "owner" && !otherOwners {
		return 0, nil, errLastOwner
	}
	ctx := r.Context()
	status := http.StatusOK
	switch {
	case old == "":
		if _, err := tx.Exec(ctx, `INSERT INTO members (org_id, user_id, role) VALUES (app_current_org(), $1, $2)`, user, req.Role); err != nil {
			return 0, nil, err
		}
		if err := audit(ctx, tx, oc, "member.add", "member", "", map[string]any{"user_id": user, "role": req.Role}); err != nil {
			return 0, nil, err
		}
		status = http.StatusCreated
	case old != req.Role:
		if _, err := tx.Exec(ctx, `UPDATE members SET role = $2 WHERE user_id = $1`, user, req.Role); err != nil {
			return 0, nil, err
		}
		if err := audit(ctx, tx, oc, "member.role", "member", "", map[string]any{"user_id": user, "role": req.Role, "old_role": old}); err != nil {
			return 0, nil, err
		}
	}
	m, err := scanMember(tx.QueryRow(ctx, memberSelect+` WHERE m.user_id = $1`, user))
	if err != nil {
		return 0, nil, err
	}
	return status, m, nil
}

// deleteMember is DELETE /v1/members/{user}. Their tokens are deleted with
// the membership (and stopped working the moment it was gone).
func (s *Server) deleteMember(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	user, err := pathUserID(r)
	if err != nil {
		return 0, nil, err
	}
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	old, otherOwners, err := lockMember(r, tx, user)
	if err != nil {
		return 0, nil, err
	}
	if old == "" {
		return 0, nil, errNotFound("member not found")
	}
	if !canManageMember(oc.P, old, "") {
		return 0, nil, errForbidden
	}
	if old == "owner" && !otherOwners {
		return 0, nil, errLastOwner
	}
	ctx := r.Context()
	if _, err := tx.Exec(ctx, `DELETE FROM members WHERE user_id = $1`, user); err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "member.remove", "member", "", map[string]any{"user_id": user, "role": old}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, map[string]any{"user_id": user, "removed": true}, nil
}

// ---- org ---------------------------------------------------------------------

type orgResp struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type patchOrgReq struct {
	Name string `json:"name"`
}

// patchOrg is PATCH /v1/org (owners): rename the org.
func (s *Server) patchOrg(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	var req patchOrgReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if err := checkText("name", req.Name, 200, true); err != nil {
		return 0, nil, err
	}
	if !oc.P.isOwner() {
		return 0, nil, errForbidden
	}
	ctx := r.Context()
	var old string
	if err := tx.QueryRow(ctx, `SELECT name FROM orgs`).Scan(&old); err != nil {
		return 0, nil, err
	}
	var o orgResp
	if err := tx.QueryRow(ctx, `UPDATE orgs SET name = $1 RETURNING id::text, name, created_at`, req.Name).
		Scan(&o.ID, &o.Name, &o.CreatedAt); err != nil {
		return 0, nil, err
	}
	if old != o.Name {
		if err := audit(ctx, tx, oc, "org.rename", "org", o.ID, map[string]any{"name": o.Name, "old_name": old}); err != nil {
			return 0, nil, err
		}
	}
	return http.StatusOK, o, nil
}

// ---- audit log -----------------------------------------------------------------

type auditEntry struct {
	ID         int64          `json:"id"`
	Actor      string         `json:"actor"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type"`
	TargetID   *string        `json:"target_id"`
	Details    map[string]any `json:"details"`
	CreatedAt  time.Time      `json:"created_at"`
}

// listAudit is GET /v1/audit (owners and leads), newest first. Filters:
// ?actor=, ?action= (exact, or a prefix when it ends in "." like "token."),
// ?target_type=, ?target_id=.
func (s *Server) listAudit(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	pg, err := parsePage(r, false, false)
	if err != nil {
		return 0, nil, err
	}
	var after *int64
	if pg.After != nil {
		n, err := strconv.ParseInt(pg.After.ID, 10, 64)
		if err != nil || n < 1 {
			return 0, nil, errInvalidCursor
		}
		after = &n
	}
	q := r.URL.Query()
	actor, action, targetType := q.Get("actor"), q.Get("action"), q.Get("target_type")
	for field, v := range map[string]string{"actor": actor, "action": action, "target_type": targetType} {
		if err := checkText(field, v, 255, false); err != nil {
			return 0, nil, err
		}
	}
	var targetID *string
	if v := q.Get("target_id"); v != "" {
		id, ok := parseUUID(v)
		if !ok {
			return 0, nil, errBadRequest("invalid_input", "target_id must be a uuid")
		}
		targetID = &id
	}
	actionPrefix := len(action) > 1 && action[len(action)-1] == '.'
	rows, err := tx.Query(r.Context(),
		`SELECT id, actor, action, target_type, target_id::text, details, created_at FROM audit_log
		  WHERE ($1 = '' OR actor = $1)
		    AND ($2 = '' OR CASE WHEN $3 THEN starts_with(action, $2) ELSE action = $2 END)
		    AND ($4 = '' OR target_type = $4)
		    AND ($5::uuid IS NULL OR target_id = $5::uuid)
		    AND ($6::bigint IS NULL OR id < $6)
		  ORDER BY id DESC LIMIT $7`,
		actor, action, actionPrefix, targetType, targetID, after, pg.Limit+1)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (auditEntry, error) {
		var e auditEntry
		err := row.Scan(&e.ID, &e.Actor, &e.Action, &e.TargetType, &e.TargetID, &e.Details, &e.CreatedAt)
		return e, err
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, pageOf(items, pg.Limit, func(e auditEntry) cursor { return cursor{ID: strconv.FormatInt(e.ID, 10)} }), nil
}

// ---- closing runs ------------------------------------------------------------

type closeRunReq struct {
	EndedAt      *time.Time `json:"ended_at"`
	ExitReason   *string    `json:"exit_reason"`
	InputTokens  *int64     `json:"input_tokens"`
	OutputTokens *int64     `json:"output_tokens"`
	CostUSD      *float64   `json:"cost_usd"`
}

// closeRun is POST /v1/runs/{id}/close: end a run that is still open (its
// desktop crashed or went offline). The body is optional; ended_at defaults to
// now and exit_reason to "closed". The run's creator or an owner/lead may
// close it; 409 run_closed when it already ended.
func (s *Server) closeRun(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return 0, nil, err
	}
	var req closeRunReq
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			return 0, nil, err
		}
	}
	reason := "closed"
	if req.ExitReason != nil {
		if err := checkText("exit_reason", *req.ExitReason, maxShortTextLen, true); err != nil {
			return 0, nil, err
		}
		reason = *req.ExitReason
	}
	var in, out int64
	if req.InputTokens != nil {
		in = *req.InputTokens
	}
	if req.OutputTokens != nil {
		out = *req.OutputTokens
	}
	if err := checkUsage(in, out, req.CostUSD); err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	var (
		started   time.Time
		ended     *time.Time
		createdBy *string
	)
	err = tx.QueryRow(ctx, `SELECT started_at, ended_at, created_by FROM agent_runs WHERE id = $1 FOR UPDATE`, id).
		Scan(&started, &ended, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("run not found")
	}
	if err != nil {
		return 0, nil, err
	}
	if !oc.P.canAdmin() && (createdBy == nil || *createdBy != oc.Actor) {
		return 0, nil, errForbidden
	}
	if ended != nil {
		return 0, nil, &apiError{Status: http.StatusConflict, Code: "run_closed", Message: "run has already ended"}
	}
	now := time.Now().UTC()
	end := now
	if req.EndedAt != nil {
		end = *req.EndedAt
	}
	if end.Before(started) {
		return 0, nil, errBadRequest("invalid_input", "ended_at must not be before started_at")
	}
	if end.After(now.Add(maxClockSkew)) {
		return 0, nil, errBadRequest("invalid_input", "ended_at is too far in the future")
	}
	var run agentRun
	if err := tx.QueryRow(ctx,
		`UPDATE agent_runs SET ended_at = $2, exit_reason = $3,
		        input_tokens = COALESCE($4, input_tokens), output_tokens = COALESCE($5, output_tokens),
		        cost_usd = COALESCE($6, cost_usd)
		  WHERE id = $1 RETURNING `+runCols,
		id, end, reason, req.InputTokens, req.OutputTokens, req.CostUSD).Scan(run.scanDest()...); err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "run.close", "agent_run", run.ID, map[string]any{"task_id": run.TaskID, "exit_reason": reason}); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, run, nil
}
