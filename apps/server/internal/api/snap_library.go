package api

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The team Snap library: snap PACKAGES (one zip per version) that an owner or
// lead explicitly publishes so teammates can install them without a git host.
//
// PRIVACY: the server stores only these explicitly published packages. It
// never receives code, prompts, file names or secrets of users' projects, and
// never secret VALUES: a snap's permissions only name the secrets it asks for.
// Lists and events carry metadata only; the package is served only by the
// download route.
//
// Versions are immutable. Republishing the same bytes is a no-op; different
// bytes under a published version are a conflict. A bad version is yanked and
// stays downloadable, since lock files may pin it.

const (
	// MaxSnapPackageBytes caps one published package (the decoded zip).
	MaxSnapPackageBytes = 8 << 20
	// MaxSnapPublishBodyBytes caps PUT /v1/snap-library/{id}/versions/{version}:
	// the package base64-encoded plus room for the metadata.
	MaxSnapPublishBodyBytes = (MaxSnapPackageBytes+2)/3*4 + MaxBodyBytes

	maxSnapPackageEntries   = 2000
	maxSnapPackageUnpacked  = 20 << 20
	maxSnapLibraryDescLen   = 500
	maxSnapPermissionsBytes = 8 << 10
	maxSnapYankReasonLen    = 200
)

var snapVersionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`)

var errSnapPackageTooLarge = &apiError{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large",
	Message: "package must be at most 8 MiB"}

// snapVersion is one published version as listed (never the package bytes).
type snapVersion struct {
	SnapID        string          `json:"snap_id"`
	Version       string          `json:"version"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	SHA256        string          `json:"sha256"`
	PackageSHA256 string          `json:"package_sha256"`
	PackageSize   int             `json:"package_size"`
	Permissions   json.RawMessage `json:"permissions"`
	PublishedBy   string          `json:"published_by"`
	PublishedAt   time.Time       `json:"published_at"`
	Yanked        bool            `json:"yanked"`
	YankedBy      *string         `json:"yanked_by"`
	YankedAt      *time.Time      `json:"yanked_at"`
	YankReason    *string         `json:"yank_reason"`
}

const snapVersionCols = `snap_id, version, name, description, sha256, package_sha256, package_size, permissions,
	published_by, published_at, yanked, yanked_by, yanked_at, yank_reason`

func scanSnapVersion(row pgx.Row, extra ...any) (snapVersion, error) {
	var v snapVersion
	dst := append([]any{&v.SnapID, &v.Version, &v.Name, &v.Description, &v.SHA256, &v.PackageSHA256,
		&v.PackageSize, &v.Permissions, &v.PublishedBy, &v.PublishedAt, &v.Yanked, &v.YankedBy, &v.YankedAt,
		&v.YankReason}, extra...)
	return v, row.Scan(dst...)
}

func pathSnapVersion(r *http.Request) (id, version string, err error) {
	if id, err = pathSnapID(r); err != nil {
		return "", "", err
	}
	version = r.PathValue("version")
	if !snapVersionRe.MatchString(version) {
		return "", "", errBadRequest("invalid_input", "version must match ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$")
	}
	return id, version, nil
}

// listSnapLibrary is GET /v1/snap-library: every version of every snap, for
// every member (viewers included), without the packages.
func (s *Server) listSnapLibrary(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	rows, err := tx.Query(r.Context(),
		`SELECT `+snapVersionCols+` FROM team_snap_versions ORDER BY snap_id, published_at DESC, version DESC`)
	if err != nil {
		return 0, nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (snapVersion, error) { return scanSnapVersion(row) })
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, listResponse[snapVersion]{Items: items}, nil
}

// getSnapPackage is GET /v1/snap-library/{id}/versions/{version}/package: the
// zip itself, for any member. Yanked versions stay downloadable.
func (s *Server) getSnapPackage(r *http.Request, _ orgCtx, tx pgx.Tx) (int, any, error) {
	id, version, err := pathSnapVersion(r)
	if err != nil {
		return 0, nil, err
	}
	var (
		pkg             []byte
		snapSum, pkgSum string
	)
	err = tx.QueryRow(r.Context(),
		`SELECT package, sha256, package_sha256 FROM team_snap_versions WHERE snap_id = $1 AND version = $2`,
		id, version).Scan(&pkg, &snapSum, &pkgSum)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("snap version not found")
	}
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, rawBody{
		ContentType: "application/zip",
		Header: map[string]string{
			"X-Kingu-Package-Sha256": pkgSum,
			"X-Kingu-Snap-Sha256":    snapSum,
			"Content-Disposition":    fmt.Sprintf(`attachment; filename="%s-%s.zip"`, id, version),
		},
		Data: pkg,
	}, nil
}

type publishSnapReq struct {
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	SHA256        string          `json:"sha256"`
	Permissions   json.RawMessage `json:"permissions"`
	Package       string          `json:"package"`
	PackageSHA256 string          `json:"package_sha256"`
}

// validate checks the metadata and returns the decoded package.
func (req *publishSnapReq) validate() ([]byte, *apiError) {
	if err := checkText("name", req.Name, maxSnapNameLen, true); err != nil {
		return nil, err
	}
	if err := checkText("description", req.Description, maxSnapLibraryDescLen, false); err != nil {
		return nil, err
	}
	if secretRe.MatchString(req.Name) || secretRe.MatchString(req.Description) {
		return nil, errContent
	}
	if !sha256HexRe.MatchString(req.SHA256) {
		return nil, errBadRequest("invalid_input", "sha256 must be 64 lowercase hex characters")
	}
	if !sha256HexRe.MatchString(req.PackageSHA256) {
		return nil, errBadRequest("invalid_input", "package_sha256 must be 64 lowercase hex characters")
	}
	if err := checkSnapPermissions(req.Permissions); err != nil {
		return nil, err
	}
	if req.Package == "" {
		return nil, errBadRequest("invalid_input", "package is required")
	}
	if base64.StdEncoding.DecodedLen(len(req.Package)) > MaxSnapPackageBytes+2 {
		return nil, errSnapPackageTooLarge
	}
	pkg, err := base64.StdEncoding.DecodeString(req.Package)
	if err != nil {
		return nil, errBadRequest("invalid_input", "package must be standard base64")
	}
	if len(pkg) > MaxSnapPackageBytes {
		return nil, errSnapPackageTooLarge
	}
	sum := sha256.Sum256(pkg)
	if hex.EncodeToString(sum[:]) != req.PackageSHA256 {
		return nil, errBadRequest("invalid_input", "package_sha256 does not match the package")
	}
	if err := checkSnapPackage(pkg); err != nil {
		return nil, err
	}
	return pkg, nil
}

// checkSnapPermissions accepts a JSON object of at most 8 KiB whose optional
// "secrets" is a list of secret NAMES. Anything that looks like a credential
// is refused: secret values never reach the server.
func checkSnapPermissions(raw json.RawMessage) *apiError {
	if len(raw) == 0 {
		return errBadRequest("invalid_input", "permissions is required")
	}
	if len(raw) > maxSnapPermissionsBytes {
		return errBadRequest("invalid_input", "permissions must be at most 8 KiB")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return errBadRequest("invalid_input", "permissions must be a JSON object")
	}
	if secrets, ok := obj["secrets"]; ok {
		var names []string
		if err := json.Unmarshal(secrets, &names); err != nil || names == nil {
			return errBadRequest("invalid_input", "permissions.secrets must be an array of secret names")
		}
		if len(names) > maxSnapSecrets {
			return errBadRequest("invalid_input", "permissions.secrets has too many entries")
		}
		for _, name := range names {
			if !secretNameRe.MatchString(name) {
				return errBadRequest("invalid_input", "permissions.secrets must hold secret names ([A-Za-z0-9_.-]{1,64}), never values")
			}
		}
	}
	if secretRe.Match(raw) {
		return errContent
	}
	return nil
}

func errBadPackage(msg string) *apiError {
	return errBadRequest("invalid_input", "package: "+msg)
}

// checkSnapPackage checks that pkg is a zip a desktop can safely unpack: at
// most 2000 entries and 20 MiB unpacked, relative '/'-separated names without
// empty, '.' or '..' parts, no backslashes, no symlinks or other special
// files, no duplicates, and a snap.toml at its root. Every entry is read so a
// size that lies or a bad checksum is caught here.
func checkSnapPackage(pkg []byte) *apiError {
	zr, err := zip.NewReader(bytes.NewReader(pkg), int64(len(pkg)))
	if err != nil {
		return errBadPackage("not a valid zip archive")
	}
	if len(zr.File) > maxSnapPackageEntries {
		return errBadPackage(fmt.Sprintf("at most %d entries", maxSnapPackageEntries))
	}
	var total uint64
	seen := make(map[string]bool, len(zr.File))
	hasManifest := false
	for _, f := range zr.File {
		if f.UncompressedSize64 > maxSnapPackageUnpacked || total+f.UncompressedSize64 > maxSnapPackageUnpacked {
			return errBadPackage("at most 20 MiB unpacked")
		}
		total += f.UncompressedSize64
		mode := f.Mode()
		isDir := mode.IsDir()
		if mode.Type()&^fs.ModeDir != 0 {
			return errBadPackage("entry " + quoteEntry(f.Name) + " is a symlink or special file")
		}
		if !snapEntryNameOK(f.Name, isDir) {
			return errBadPackage("entry " + quoteEntry(f.Name) + " is not a plain relative path")
		}
		key := strings.TrimSuffix(f.Name, "/")
		if seen[key] {
			return errBadPackage("entry " + quoteEntry(f.Name) + " appears twice")
		}
		seen[key] = true
		if f.Flags&0x1 != 0 {
			return errBadPackage("encrypted entries are not allowed")
		}
		if isDir {
			continue
		}
		if f.Name == "snap.toml" {
			hasManifest = true
		}
		rc, err := f.Open()
		if err != nil {
			return errBadPackage("entry " + quoteEntry(f.Name) + " cannot be read")
		}
		n, err := io.Copy(io.Discard, io.LimitReader(rc, int64(f.UncompressedSize64)+1))
		rc.Close()
		if err != nil || uint64(n) != f.UncompressedSize64 {
			return errBadPackage("entry " + quoteEntry(f.Name) + " is corrupt")
		}
	}
	if !hasManifest {
		return errBadPackage("snap.toml is missing at the root")
	}
	return nil
}

// snapEntryNameOK accepts "a/b/c" (a directory entry may end in one "/").
func snapEntryNameOK(name string, isDir bool) bool {
	if isDir {
		name = strings.TrimSuffix(name, "/")
	}
	if name == "" || strings.HasPrefix(name, "/") || strings.ContainsRune(name, '\\') {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func quoteEntry(name string) string {
	if len(name) > 80 {
		name = name[:80] + "…"
	}
	return fmt.Sprintf("%q", name)
}

// publishSnapVersion is PUT /v1/snap-library/{id}/versions/{version} (owner or
// lead): publishes the package as this version. 201 when new, 200 when the
// same bytes were already published, 409 when other bytes were.
func (s *Server) publishSnapVersion(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	id, version, err := pathSnapVersion(r)
	if err != nil {
		return 0, nil, err
	}
	var req publishSnapReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	pkg, verr := req.validate()
	if verr != nil {
		return 0, nil, verr
	}
	ctx := r.Context()
	var rowID string
	out, err := scanSnapVersion(tx.QueryRow(ctx,
		`INSERT INTO team_snap_versions (org_id, snap_id, version, name, description, sha256, package,
		                                 package_sha256, package_size, permissions, published_by)
		 VALUES (app_current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
		 ON CONFLICT (org_id, snap_id, version) DO NOTHING
		 RETURNING `+snapVersionCols+`, id::text`,
		id, version, req.Name, req.Description, req.SHA256, pkg, req.PackageSHA256, len(pkg),
		string(req.Permissions), oc.Actor), &rowID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Already published: immutable, so only the very same bytes are accepted.
		existing, err := scanSnapVersion(tx.QueryRow(ctx,
			`SELECT `+snapVersionCols+` FROM team_snap_versions WHERE snap_id = $1 AND version = $2`, id, version))
		if err != nil {
			return 0, nil, err
		}
		if existing.PackageSHA256 != req.PackageSHA256 {
			return 0, nil, errConflict("version " + version + " of " + id + " is already published with a different package; publish a new version")
		}
		return http.StatusOK, existing, nil
	}
	if err != nil {
		return 0, nil, err
	}
	if err := audit(ctx, tx, oc, "snap.publish", "team_snap_version", rowID, map[string]any{
		"snap_id": id, "version": version, "sha256": out.SHA256,
		"package_sha256": out.PackageSHA256, "package_size": out.PackageSize,
	}); err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, out, nil
}

type yankSnapReq struct {
	Yanked *bool   `json:"yanked"`
	Reason *string `json:"reason"`
}

// yankSnapVersion is POST /v1/snap-library/{id}/versions/{version}/yank (owner
// or lead): marks the version yanked (desktops stop offering it for new
// installs) or, with "yanked": false, restores it.
func (s *Server) yankSnapVersion(r *http.Request, oc orgCtx, tx pgx.Tx) (int, any, error) {
	if !oc.P.canAdmin() {
		return 0, nil, errForbidden
	}
	id, version, err := pathSnapVersion(r)
	if err != nil {
		return 0, nil, err
	}
	var req yankSnapReq
	if err := decodeJSON(r, &req); err != nil {
		return 0, nil, err
	}
	if req.Yanked == nil {
		return 0, nil, errBadRequest("invalid_input", "yanked is required")
	}
	var reason *string
	if *req.Yanked && req.Reason != nil && *req.Reason != "" {
		if err := checkText("reason", *req.Reason, maxSnapYankReasonLen, true); err != nil {
			return 0, nil, err
		}
		if secretRe.MatchString(*req.Reason) {
			return 0, nil, errContent
		}
		reason = req.Reason
	}
	ctx := r.Context()
	var rowID string
	var row pgx.Row
	if *req.Yanked {
		row = tx.QueryRow(ctx,
			`UPDATE team_snap_versions SET yanked = true, yanked_by = $3, yanked_at = now(), yank_reason = $4
			 WHERE snap_id = $1 AND version = $2
			 RETURNING `+snapVersionCols+`, id::text`, id, version, oc.Actor, reason)
	} else {
		row = tx.QueryRow(ctx,
			`UPDATE team_snap_versions SET yanked = false, yanked_by = NULL, yanked_at = NULL, yank_reason = NULL
			 WHERE snap_id = $1 AND version = $2
			 RETURNING `+snapVersionCols+`, id::text`, id, version)
	}
	out, err := scanSnapVersion(row, &rowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errNotFound("snap version not found")
	}
	if err != nil {
		return 0, nil, err
	}
	action, details := "snap.unyank", map[string]any{"snap_id": id, "version": version}
	if out.Yanked {
		action = "snap.yank"
		if reason != nil {
			details["reason"] = *reason
		}
	}
	if err := audit(ctx, tx, oc, action, "team_snap_version", rowID, details); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, out, nil
}
