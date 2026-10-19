package api

import (
	"strings"
	"testing"
)

func TestPutArtifactReqValidate(t *testing.T) {
	desc := "ok"
	blank := "  "
	ok := func() putArtifactReq {
		return putArtifactReq{Title: "Bench", Description: &desc, Format: "html", Version: 1, HTML: "<h1>hi</h1>"}
	}
	r := ok()
	if err := r.validate(); err != nil {
		t.Fatalf("valid request: %v", err)
	}
	cases := map[string]func(*putArtifactReq){
		"no title":      func(r *putArtifactReq) { r.Title = "" },
		"control title": func(r *putArtifactReq) { r.Title = "a\nb" },
		"blank desc":    func(r *putArtifactReq) { r.Description = &blank },
		"format":        func(r *putArtifactReq) { r.Format = "pdf" },
		"version 0":     func(r *putArtifactReq) { r.Version = 0 },
		"version big":   func(r *putArtifactReq) { r.Version = maxArtifactVersion + 1 },
		"empty html":    func(r *putArtifactReq) { r.HTML = "" },
		"bad utf8":      func(r *putArtifactReq) { r.HTML = "\xff\xfe" },
		"too large":     func(r *putArtifactReq) { r.HTML = strings.Repeat("a", MaxArtifactHTMLBytes+1) },
		"secret":        func(r *putArtifactReq) { r.HTML = "sk-" + strings.Repeat("a", 30) },
	}
	for name, mutate := range cases {
		r := ok()
		mutate(&r)
		if err := r.validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	r = ok()
	r.HTML = strings.Repeat("a", MaxArtifactHTMLBytes+1)
	if err := r.validate(); err != errArtifactTooLarge {
		t.Errorf("too large: %v", err)
	}
	r = ok()
	r.Description = nil
	r.Format = "markdown"
	if err := r.validate(); err != nil {
		t.Errorf("no description, markdown: %v", err)
	}
	for _, id := range []string{"0123456789abcdef", "ffffffffffffffff"} {
		if !artifactIDRe.MatchString(id) {
			t.Errorf("%s rejected", id)
		}
	}
	for _, id := range []string{"0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../etc/passwd0000"} {
		if artifactIDRe.MatchString(id) {
			t.Errorf("%s accepted", id)
		}
	}
}
