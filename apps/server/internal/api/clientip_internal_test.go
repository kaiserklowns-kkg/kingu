package api

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientIP(t *testing.T) {
	s := &Server{cfg: Config{TrustedProxies: []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("2001:db8::/32"),
	}}}
	cases := []struct {
		name, remote string
		xff          []string
		want         string
	}{
		{"direct client", "203.0.113.5:1234", nil, "203.0.113.5"},
		{"direct client cannot spoof", "203.0.113.5:1234", []string{"1.2.3.4"}, "203.0.113.5"},
		{"via one proxy", "10.0.0.2:80", []string{"198.51.100.7"}, "198.51.100.7"},
		{"spoofed left part is ignored", "10.0.0.2:80", []string{"1.2.3.4, 198.51.100.7"}, "198.51.100.7"},
		{"chain of proxies", "10.0.0.2:80", []string{"198.51.100.7, 10.1.1.1", "10.2.2.2"}, "198.51.100.7"},
		{"only proxies", "10.0.0.2:80", []string{"10.9.9.9"}, "10.9.9.9"},
		{"no header from proxy", "10.0.0.2:80", nil, "10.0.0.2"},
		{"garbage stops the walk", "10.0.0.2:80", []string{"198.51.100.7, nonsense, 10.1.1.1"}, "10.1.1.1"},
		{"ipv6 proxy", "[2001:db8::1]:443", []string{"2001:db8::9, 2a00::1"}, "2a00::1"},
		{"ipv4-mapped", "10.0.0.2:80", []string{"::ffff:198.51.100.7"}, "198.51.100.7"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		for _, v := range c.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := s.clientIP(r); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
	none := &Server{}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.2:80"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := none.clientIP(r); got != "10.0.0.2" {
		t.Errorf("no trusted proxies: %s", got)
	}
}
