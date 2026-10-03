package dispatch

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type redirectTransport func(*http.Request) (*http.Response, error)

func (f redirectTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAuthenticatedRedirectOrigin(t *testing.T) {
	cases := []struct {
		name, base, destination string
		allowed                 bool
	}{
		{"relative", "https://api.example.com", "/next", true},
		{"same origin", "https://api.example.com", "https://api.example.com/next", true},
		{"explicit default https port", "https://api.example.com", "https://api.example.com:443/next", true},
		{"implicit default https port", "https://api.example.com:443", "https://api.example.com/next", true},
		{"explicit default http port", "http://api.example.com", "http://api.example.com:80/next", true},
		{"case insensitive hostname", "https://api.example.com", "https://API.EXAMPLE.COM/next", true},
		{"custom port", "https://api.example.com:8443", "https://api.example.com:8443/next", true},
		{"downgrade", "https://api.example.com", "http://api.example.com/next", false},
		{"upgrade", "http://api.example.com", "https://api.example.com/next", false},
		{"changed port", "https://api.example.com", "https://api.example.com:8443/next", false},
		{"removed custom port", "https://api.example.com:8443", "https://api.example.com/next", false},
		{"subdomain", "https://api.example.com", "https://child.api.example.com/next", false},
		{"parent domain", "https://api.example.com", "https://example.com/next", false},
		{"unrelated", "https://api.example.com", "https://other.example.com/next", false},
		{"hostname suffix", "https://api.example.com", "https://api.example.com.evil.test/next", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			c := New("secret")
			c.BaseURL = tc.base
			c.HTTPClient.Transport = redirectTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Header.Get("Authorization") != "Bearer secret" {
					t.Fatalf("missing authorization: %v", r.Header)
				}
				if calls == 1 {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": {tc.destination}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[]}`)), Request: r}, nil
			})
			_, err := c.Emails()
			if tc.allowed {
				if err != nil || calls != 2 {
					t.Fatalf("same origin: calls=%d err=%v", calls, err)
				}
			} else {
				var apiErr *Error
				if calls != 1 || !errors.As(err, &apiErr) || !strings.Contains(apiErr.Cause.Error(), "outside API origin") {
					t.Fatalf("cross origin: calls=%d err=%v", calls, err)
				}
			}
		})
	}
}

func TestRedirectPreservesCallerPolicy(t *testing.T) {
	for _, mode := range []string{"reject", "last response", "mutate", "allow"} {
		t.Run(mode, func(t *testing.T) {
			c := New("secret")
			c.BaseURL = "https://api.example.com"
			calls, checks := 0, 0
			sentinel := errors.New("caller rejected redirect")
			transport := redirectTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"/next"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[]}`)), Request: r}, nil
			})
			original := &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
				checks++
				switch mode {
				case "reject":
					return sentinel
				case "last response":
					return http.ErrUseLastResponse
				case "mutate":
					r.URL, _ = url.Parse("https://evil.test/next")
				}
				return nil
			}}
			c.HTTPClient = original
			_, err := c.Emails()
			if checks != 1 || c.HTTPClient != original || original.Timeout != time.Second {
				t.Fatalf("caller client changed or callback skipped")
			}
			switch mode {
			case "allow":
				if err != nil || calls != 2 {
					t.Fatalf("allow: %v calls=%d", err, calls)
				}
			case "reject":
				if !errors.Is(err, sentinel) || calls != 1 {
					t.Fatalf("reject: %v calls=%d", err, calls)
				}
			case "last response":
				var apiErr *Error
				if !errors.As(err, &apiErr) || apiErr.Status != 302 || calls != 1 {
					t.Fatalf("last response: %v calls=%d", err, calls)
				}
			case "mutate":
				if err == nil || calls != 1 {
					t.Fatalf("mutate: %v calls=%d", err, calls)
				}
			}
		})
	}
}

func TestAuthenticatedRedirectLimit(t *testing.T) {
	for _, custom := range []bool{false, true} {
		t.Run(map[bool]string{false: "default policy", true: "caller policy"}[custom], func(t *testing.T) {
			c := New("secret")
			c.BaseURL = "https://api.example.com"
			calls := 0
			c.HTTPClient.Transport = redirectTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"/next"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			})
			if custom {
				c.HTTPClient.CheckRedirect = func(*http.Request, []*http.Request) error { return nil }
			}
			_, err := c.Emails()
			if err == nil || calls != 10 {
				t.Fatalf("redirect limit: %v calls=%d", err, calls)
			}
		})
	}
}
