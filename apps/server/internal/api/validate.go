package api

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxTitleLen       = 300
	maxProjectNameLen = 200
	maxRepoURLLen     = 2048
	maxRefLen         = 255
	maxExternalRefLen = 500
	maxShortTextLen   = 200
)

var (
	taskStatuses = map[string]bool{
		"backlog": true, "running": true, "needs_input": true,
		"review": true, "done": true, "failed": true,
	}
	taskSources = map[string]bool{"manual": true, "github": true, "linear": true, "jira": true}
)

// parseUUID accepts the canonical 8-4-4-4-12 hex form and returns it lowercased.
func parseUUID(s string) (string, bool) {
	if len(s) != 36 {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return "", false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return "", false
			}
		}
	}
	return strings.ToLower(s), true
}

// checkText validates a free-text field: valid UTF-8, no control characters,
// not blank, at most max characters.
func checkText(field, v string, max int, required bool) *apiError {
	if v == "" {
		if required {
			return errBadRequest("invalid_input", field+" is required")
		}
		return nil
	}
	if !utf8.ValidString(v) {
		return errBadRequest("invalid_input", field+" must be valid UTF-8")
	}
	if strings.TrimSpace(v) == "" {
		return errBadRequest("invalid_input", field+" must not be blank")
	}
	if n := utf8.RuneCountInString(v); n > max {
		return errBadRequest("invalid_input", fmt.Sprintf("%s must be at most %d characters", field, max))
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return errBadRequest("invalid_input", field+" must not contain control characters")
		}
	}
	return nil
}

// checkRef validates a git ref / branch name (subset of git check-ref-format).
func checkRef(field, v string) *apiError {
	if err := checkText(field, v, maxRefLen, true); err != nil {
		return err
	}
	bad := v[0] == '-' || v[0] == '/' || strings.HasSuffix(v, "/") ||
		strings.HasSuffix(v, ".") || strings.HasSuffix(v, ".lock") ||
		strings.Contains(v, "..") || strings.Contains(v, "//") || strings.Contains(v, "@{") ||
		strings.ContainsAny(v, " ~^:?*[\\") || v == "@"
	if bad {
		return errBadRequest("invalid_input", field+" is not a valid git ref name")
	}
	return nil
}

func checkRepoURL(v string) *apiError { return checkGitURL("repo_url", v) }

// checkGitURL accepts https://, ssh:// and scp-style git@host:path remotes
// and rejects anything carrying credentials: the server must never store
// secrets.
func checkGitURL(field, v string) *apiError {
	if err := checkText(field, v, maxRepoURLLen, true); err != nil {
		return err
	}
	if strings.ContainsAny(v, " \t") {
		return errBadRequest("invalid_input", field+" must not contain whitespace")
	}
	// git would read a leading dash as an option.
	if strings.HasPrefix(v, "-") {
		return errBadRequest("invalid_input", field+" must not start with -")
	}
	// scp-like syntax: user@host:path (no scheme).
	if !strings.Contains(v, "://") {
		at := strings.Index(v, "@")
		colon := strings.Index(v, ":")
		if at > 0 && colon > at+1 && colon < len(v)-1 && !strings.Contains(v[:at], ":") {
			return nil
		}
		return errBadRequest("invalid_input", field+" must be an https://, ssh:// or user@host:path remote")
	}
	u, err := url.Parse(v)
	if err != nil || u.Host == "" {
		return errBadRequest("invalid_input", field+" is not a valid URL")
	}
	switch u.Scheme {
	case "https":
		if u.User != nil {
			return errBadRequest("invalid_input", field+" must not embed credentials")
		}
	case "ssh":
		if u.User != nil {
			if _, hasPassword := u.User.Password(); hasPassword {
				return errBadRequest("invalid_input", field+" must not embed credentials")
			}
		}
	default:
		return errBadRequest("invalid_input", field+" scheme must be https or ssh")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errBadRequest("invalid_input", field+" must not have a query or fragment")
	}
	return nil
}
