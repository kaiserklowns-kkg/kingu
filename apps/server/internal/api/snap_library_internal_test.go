package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io/fs"
	"strconv"
	"strings"
	"testing"
)

type zipEntry struct {
	name string
	body string
	mode fs.FileMode
}

func buildZip(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestCheckSnapPackage(t *testing.T) {
	manifest := zipEntry{name: "snap.toml", body: "id = \"go\"\n"}
	ok := [][]zipEntry{
		{manifest},
		{manifest, {name: "bin/"}, {name: "bin/run.sh", body: "echo hi"}, {name: "a/b/c.txt", body: "x"}},
	}
	for i, entries := range ok {
		if err := checkSnapPackage(buildZip(t, entries...)); err != nil {
			t.Errorf("ok #%d: %v", i, err)
		}
	}
	many := []zipEntry{manifest}
	for i := 0; i < maxSnapPackageEntries; i++ {
		many = append(many, zipEntry{name: "f/" + strconv.Itoa(i)})
	}
	bad := map[string][]byte{
		"not zip":       []byte("PK nope"),
		"empty":         {},
		"no manifest":   buildZip(t, zipEntry{name: "README.md", body: "hi"}),
		"nested only":   buildZip(t, zipEntry{name: "sub/snap.toml", body: "x"}),
		"dotdot":        buildZip(t, manifest, zipEntry{name: "../evil", body: "x"}),
		"inner dotdot":  buildZip(t, manifest, zipEntry{name: "a/../../evil", body: "x"}),
		"dot":           buildZip(t, manifest, zipEntry{name: "./a", body: "x"}),
		"absolute":      buildZip(t, manifest, zipEntry{name: "/etc/passwd", body: "x"}),
		"backslash":     buildZip(t, manifest, zipEntry{name: "a\\b", body: "x"}),
		"empty segment": buildZip(t, manifest, zipEntry{name: "a//b", body: "x"}),
		"control char":  buildZip(t, manifest, zipEntry{name: "a\nb", body: "x"}),
		"symlink":       buildZip(t, manifest, zipEntry{name: "link", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777}),
		"duplicate":     buildZip(t, manifest, zipEntry{name: "snap.toml", body: "y"}),
		"too many":      buildZip(t, many...),
		"too big":       buildZip(t, manifest, zipEntry{name: "big", body: strings.Repeat("0", maxSnapPackageUnpacked)}),
	}
	for name, pkg := range bad {
		err := checkSnapPackage(pkg)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		t.Logf("%s: %s", name, err.Message)
	}
}

func TestCheckSnapPermissions(t *testing.T) {
	for _, raw := range []string{`{}`, `{"network":true,"fs":"worktree","secrets":["GO_TOKEN","a.b-c"]}`, `{"secrets":[]}`} {
		if err := checkSnapPermissions(json.RawMessage(raw)); err != nil {
			t.Errorf("%s: %v", raw, err)
		}
	}
	for _, raw := range []string{
		``, `null`, `[]`, `"x"`, `1`,
		`{"secrets":"GO_TOKEN"}`, `{"secrets":[1]}`, `{"secrets":null}`,
		`{"secrets":["has space"]}`,
		`{"secrets":["ghp_` + strings.Repeat("x", 30) + `"]}`,
		`{"note":"sk-` + strings.Repeat("a", 30) + `"}`,
		`{"pad":"` + strings.Repeat("a", maxSnapPermissionsBytes) + `"}`,
	} {
		if err := checkSnapPermissions(json.RawMessage(raw)); err == nil {
			t.Errorf("%.60s: accepted", raw)
		}
	}
	for _, v := range []string{"1.0.0", "2.0.0-beta.1", "1.0.0+build.5", "v1", "0"} {
		if !snapVersionRe.MatchString(v) {
			t.Errorf("version %q rejected", v)
		}
	}
	for _, v := range []string{"", ".1", "-1", "1/2", "1 0", "../x", strings.Repeat("1", 65)} {
		if snapVersionRe.MatchString(v) {
			t.Errorf("version %q accepted", v)
		}
	}
}
