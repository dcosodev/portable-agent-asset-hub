// Package rest_test exercises hub/internal/rest via the public
// package API. The tests live at tests/go/rest/*_test.go (not in
// internal/rest/) on purpose: the T6 contract is "thin curated
// stdlib-only Go REST client" and the test surface is a separate
// subprocess boundary driven by tests/go/rest/*.test.ts. The TS
// harness (tests/go/rest/_rest-harness.ts) compiles this file
// with `go test -c` and spawns the resulting binary; the Go
// testing package owns every assertion in this file.
//
// Coverage:
//
//   - auth_test.go  — table-driven 401/403/404/409/412/5xx,
//     happy-path JSON decode, bearer-redaction
//     cases (the bearer is set on the client but
//     NEVER appears in the captured error).
//   - token_reader_test.go — ReadTokenFile enforces regular file,
//     non-symlink, mode 0600. The bearer bytes
//     never leak into the error message.
//
// The tests do NOT touch cmd/hub, openapi/, packages/, or
// observability/. They only import hub/internal/rest and stdlib.
package rest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"hub/internal/rest"
)

// ----------------------------------------------------------------------------
// auth_test.go content (kept in one file because tests/go/rest is a single
// Go package: rest_test).
// ----------------------------------------------------------------------------

// canonicalBearer is the literal bearer used by every test in this
// file. The string is 32 random-looking base64url characters; it
// must NOT appear in any captured stderr / error message so the
// redaction contract stays honest. The length matters for the
// regex assertion below — see assertNoBearerLeak.
const canonicalBearer = "hubv1_4f8b2c1e9a0d6f3b7e5c8a1d2f4b6e8a"

// assertNoBearerLeak is the negative assertion every auth test
// runs against its captured stderr, error message, and HubError
// .Error() string. It must catch every place the bearer could
// possibly surface.
func assertNoBearerLeak(t *testing.T, where string, lines ...string) {
	t.Helper()
	for i, s := range lines {
		if strings.Contains(s, canonicalBearer) {
			t.Fatalf("%s[%d] leaked canonical bearer: %q", where, i, s)
		}
		// Bearer-shape regex: bearer prefix + 20+ opaque chars.
		low := strings.ToLower(s)
		if strings.Contains(low, "bearer ") && containsOpaque(extractAfter(low, "bearer ")) {
			t.Fatalf("%s[%d] matches bearer-shaped regex: %q", where, i, s)
		}
	}
}

// containsOpaque returns true if s begins with 20+ chars from the
// base64url alphabet (the canonical opaque token shape).
func containsOpaque(s string) bool {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-"
	count := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' {
			count++
			continue
		}
		if strings.IndexByte(alphabet, c) >= 0 {
			count++
			continue
		}
		break
	}
	return count >= 20
}

// extractAfter returns the substring after the first occurrence of
// needle in s. If needle is missing it returns s verbatim.
func extractAfter(s, needle string) string {
	idx := strings.Index(s, needle)
	if idx < 0 {
		return s
	}
	return s[idx+len(needle):]
}

// errorEnvelope is the shape the server emits on every non-2xx
// response. Mirror of openapi/components/errors.yaml.
type errorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Status  int    `json:"status"`
	} `json:"error"`
	RequestID string `json:"request_id"`
}

// fixtureServer is a tiny httptest.Server wired for the auth
// cases. Each call records what the server saw (method, path,
// Authorization header presence, bearer value, captured body) so
// the test can assert on the outbound request without depending on
// an external mock library.
type fixtureServer struct {
	t              *testing.T
	server         *httptest.Server
	gotAuthHeader  atomic.Value // string — last seen Authorization header
	gotAuthPresent atomic.Bool
	hits           atomic.Int64
	pathHandler    func(w http.ResponseWriter, r *http.Request)
}

func newFixtureServer(t *testing.T, pathHandler func(w http.ResponseWriter, r *http.Request)) *fixtureServer {
	t.Helper()
	fs := &fixtureServer{t: t, pathHandler: pathHandler}
	fs.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fs.hits.Add(1)
		if h := r.Header.Get("Authorization"); h != "" {
			fs.gotAuthPresent.Store(true)
			fs.gotAuthHeader.Store(h)
		} else {
			fs.gotAuthPresent.Store(false)
		}
		fs.pathHandler(w, r)
	}))
	t.Cleanup(fs.server.Close)
	return fs
}

// okJSON responds 200 with the supplied body (encoded as JSON).
func okJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(body)
}

// errEnvelope responds with the supplied HTTP status and a
// canonical error envelope. request_id is fixed to a known string
// so the test can assert on it without depending on randomness.
func errEnvelope(w http.ResponseWriter, status int, code, msg, requestID string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	env := errorEnvelope{RequestID: requestID}
	env.Error.Code = code
	env.Error.Message = msg
	env.Error.Status = status
	_ = json.NewEncoder(w).Encode(env)
}

// ----------------------------------------------------------------------------
// Table-driven auth cases. One row per status class so the
// redaction + envelope + status field contract is locked.
// ----------------------------------------------------------------------------

func TestAuth_RedactsAndPreservesEnvelope(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		code        string
		message     string
		requestID   string
		wantCode    string // HubError.Code
		wantStatus  int
		wantRequest string // HubError.RequestID
	}{
		{
			name: "401_unauthorized_preserves_envelope", status: http.StatusUnauthorized,
			code:        "unauthorized",
			message:     "missing bearer",
			requestID:   "req-401-aaaa",
			wantCode:    "unauthorized",
			wantStatus:  401,
			wantRequest: "req-401-aaaa",
		},
		{
			name: "403_forbidden_preserves_envelope", status: http.StatusForbidden,
			code:        "forbidden",
			message:     "scope insufficient",
			requestID:   "req-403-bbbb",
			wantCode:    "forbidden",
			wantStatus:  403,
			wantRequest: "req-403-bbbb",
		},
		{
			name: "404_not_found_preserves_envelope", status: http.StatusNotFound,
			code:        "not_found",
			message:     "no such skill",
			requestID:   "req-404-cccc",
			wantCode:    "not_found",
			wantStatus:  404,
			wantRequest: "req-404-cccc",
		},
		{
			name: "409_conflict_preserves_envelope", status: http.StatusConflict,
			code:        "conflict",
			message:     "supersede race",
			requestID:   "req-409-dddd",
			wantCode:    "conflict",
			wantStatus:  409,
			wantRequest: "req-409-dddd",
		},
		{
			name: "412_precondition_failed_preserves_envelope", status: http.StatusPreconditionFailed,
			code:        "precondition_failed",
			message:     "if-match mismatch",
			requestID:   "req-412-eeee",
			wantCode:    "precondition_failed",
			wantStatus:  412,
			wantRequest: "req-412-eeee",
		},
		{
			name: "500_internal_preserves_envelope", status: http.StatusInternalServerError,
			code:        "internal",
			message:     "upstream down",
			requestID:   "req-500-ffff",
			wantCode:    "internal",
			wantStatus:  500,
			wantRequest: "req-500-ffff",
		},
		{
			name: "503_unavailable_preserves_envelope", status: http.StatusServiceUnavailable,
			code:        "unavailable",
			message:     "backoff please",
			requestID:   "req-503-gggg",
			wantCode:    "unavailable",
			wantStatus:  503,
			wantRequest: "req-503-gggg",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
				errEnvelope(w, tc.status, tc.code, tc.message, tc.requestID)
			})
			c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
			_, err := c.Health(context.Background())
			if err == nil {
				t.Fatalf("expected HubError for status %d, got nil", tc.status)
			}
			var he *rest.HubError
			if !errors.As(err, &he) {
				t.Fatalf("expected *HubError, got %T: %v", err, err)
			}
			if he.Status != tc.wantStatus {
				t.Fatalf("Status: want %d got %d", tc.wantStatus, he.Status)
			}
			if he.Code != tc.wantCode {
				t.Fatalf("Code: want %q got %q", tc.wantCode, he.Code)
			}
			if he.RequestID != tc.wantRequest {
				t.Fatalf("RequestID: want %q got %q", tc.wantRequest, he.RequestID)
			}
			// Redaction: Error() must NEVER contain the bearer.
			errStr := err.Error()
			assertNoBearerLeak(t, "HubError.Error", errStr)
		})
	}
}

// TestAuth_BearerHeaderSentOnOutbound locks the bearer in the
// Authorization header for every outbound call. The server records
// the header verbatim so the test asserts "Bearer <opaque>"
// without leaking the opaque into the test report (we mask it).
func TestAuth_BearerHeaderSentOnOutbound(t *testing.T) {
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		okJSON(w, map[string]any{"ok": true})
	})
	c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
	if _, err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health failed: %v", err)
	}
	if !fs.gotAuthPresent.Load() {
		t.Fatalf("expected Authorization header on outbound request")
	}
	got, _ := fs.gotAuthHeader.Load().(string)
	if got != "Bearer "+canonicalBearer {
		// Mask the bearer in the failure message so the report
		// itself is bearer-safe.
		masked := got
		if len(masked) > 0 {
			// Replace the bearer bytes with ***REDACTED***.
			const marker = "Bearer "
			if strings.HasPrefix(masked, marker) {
				masked = marker + "***REDACTED***"
			}
		}
		assertNoBearerLeak(t, "Authorization header", got)
		t.Fatalf("Authorization: want %q got %q", "Bearer "+"***REDACTED***", masked)
	}
}

// TestAuth_NoBearerWhenEmpty locks the inverse: when the client
// has no token, the outbound request must NOT carry any
// Authorization header at all.
func TestAuth_NoBearerWhenEmpty(t *testing.T) {
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		okJSON(w, map[string]any{"ok": true})
	})
	c := rest.NewClient(fs.server.URL, "", fs.server.Client())
	if _, err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health failed: %v", err)
	}
	if fs.gotAuthPresent.Load() {
		got, _ := fs.gotAuthHeader.Load().(string)
		t.Fatalf("expected NO Authorization header, got %q", got)
	}
}

// TestAuth_HappyPathJSONDecode locks the happy path: a 200 with a
// known JSON body must decode into a generic map[string]any and
// return no error.
func TestAuth_HappyPathJSONDecode(t *testing.T) {
	want := map[string]any{
		"service": "hub",
		"status":  "ok",
		"uptime":  42.0,
	}
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		okJSON(w, want)
	})
	c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
	got, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("Health failed: %v", err)
	}
	if got["service"] != "hub" || got["status"] != "ok" {
		t.Fatalf("decoded body mismatch: %v", got)
	}
}

// TestAuth_AllEndpointsExercised locks every documented GET
// endpoint so the curated surface cannot silently shrink. Each
// call hits /api/v1/<path> and the server asserts the path.
func TestAuth_AllEndpointsExercised(t *testing.T) {
	type endpoint struct {
		name string
		path string
		call func(*rest.Client, context.Context) (any, error)
	}
	endpoints := []endpoint{
		{"health", "/api/v1/health", func(c *rest.Client, ctx context.Context) (any, error) { return c.Health(ctx) }},
		{"status", "/api/v1/status", func(c *rest.Client, ctx context.Context) (any, error) { return c.Status(ctx) }},
		{"capabilities", "/api/v1/capabilities", func(c *rest.Client, ctx context.Context) (any, error) { return c.Capabilities(ctx) }},
		{"catalog", "/api/v1/catalog", func(c *rest.Client, ctx context.Context) (any, error) { return c.Catalog(ctx) }},
		{"catalog_search", "/api/v1/catalog/search?q=alpha", func(c *rest.Client, ctx context.Context) (any, error) {
			return c.SearchCatalog(ctx, "alpha")
		}},
		{"skills_skill", "/api/v1/skills/skill-xyz", func(c *rest.Client, ctx context.Context) (any, error) {
			return c.Skill(ctx, "skill-xyz")
		}},
		{"skills_search", "/api/v1/skills/search?q=alpha", func(c *rest.Client, ctx context.Context) (any, error) {
			return c.SearchSkills(ctx, "alpha")
		}},
		{"memories", "/api/v1/memories", func(c *rest.Client, ctx context.Context) (any, error) { return c.Memories(ctx) }},
		{"memory", "/api/v1/memories/mem-xyz", func(c *rest.Client, ctx context.Context) (any, error) {
			return c.Memory(ctx, "mem-xyz")
		}},
		{"memories_search", "/api/v1/memories/search?q=alpha", func(c *rest.Client, ctx context.Context) (any, error) {
			return c.SearchMemories(ctx, "alpha")
		}},
		{"memory_blocks", "/api/v1/memory-blocks", func(c *rest.Client, ctx context.Context) (any, error) {
			return c.MemoryBlocks(ctx)
		}},
	}
	for _, ep := range endpoints {
		ep := ep
		t.Run(ep.name, func(t *testing.T) {
			var gotPath string
			fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.RequestURI()
				okJSON(w, map[string]any{"ok": true, "path": gotPath})
			})
			c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
			if _, err := ep.call(c, context.Background()); err != nil {
				t.Fatalf("call failed: %v", err)
			}
			if gotPath != ep.path {
				t.Fatalf("path mismatch: want %q got %q", ep.path, gotPath)
			}
		})
	}
}

// TestAuth_ResponseBodyBounded locks the bounded response body.
// The server returns a 5 MiB payload; the client must reject it
// rather than blow up the heap.
func TestAuth_ResponseBodyBounded(t *testing.T) {
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		// 5 MiB of zeros — well above any sane bound.
		buf := bytes.Repeat([]byte{'x'}, 5*1024*1024)
		_, _ = w.Write(buf)
	})
	c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
	// We expect the client to surface an error rather than
	// silently swallow a giant body.
	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatalf("expected error from bounded body, got nil")
	}
	// The error is implementation-defined (io.ErrUnexpectedEOF,
	// a HubError, or net/http's own limit). We just assert it
	// does not panic and does not contain the bearer.
	assertNoBearerLeak(t, "bounded body error", err.Error())
}

// TestAuth_NonEnvelopeBodyStillTypedHubError locks the behaviour
// when the server returns a non-2xx without the canonical error
// envelope — the client must still surface a typed HubError so
// the caller can branch on .Status.
func TestAuth_NonEnvelopeBodyStillTypedHubError(t *testing.T) {
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "<html>nginx</html>")
	})
	c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	var he *rest.HubError
	if !errors.As(err, &he) {
		t.Fatalf("expected *HubError even for non-envelope body, got %T: %v", err, err)
	}
	if he.Status != http.StatusBadGateway {
		t.Fatalf("Status: want %d got %d", http.StatusBadGateway, he.Status)
	}
	assertNoBearerLeak(t, "non-envelope HubError", err.Error())
}

// TestAuth_2xxMalformedJSONReturnsError locks the symmetric
// failure: a 200 with invalid JSON must NOT be reported as a
// HubError; it must be a parse error so the caller can
// distinguish "server gave us garbage" from "server rejected us".
func TestAuth_2xxMalformedJSONReturnsError(t *testing.T) {
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "{not-json")
	})
	c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatalf("expected parse error, got nil")
	}
	var he *rest.HubError
	if errors.As(err, &he) {
		t.Fatalf("expected NON-HubError for malformed JSON, got HubError: %v", he)
	}
	assertNoBearerLeak(t, "malformed-json error", err.Error())
}

// TestAuth_RedactionAcrossManyFormats sweeps the bearer through
// every string-shaped field the HubError exposes. The bearer
// must NEVER appear, even if a future refactor accidentally
// formats a header into the message.
func TestAuth_RedactionAcrossManyFormats(t *testing.T) {
	fs := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Echo back a header that contains the bearer. This
		// simulates an upstream that mistakenly leaks a token
		// in an X-Forwarded-Auth header.
		w.Header().Set("X-Forwarded-Auth", "Bearer "+canonicalBearer)
		errEnvelope(w, http.StatusUnauthorized, "unauthorized", "see upstream", "req-redact-aaaa")
	})
	c := rest.NewClient(fs.server.URL, canonicalBearer, fs.server.Client())
	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatalf("expected error")
	}
	errStr := err.Error()
	assertNoBearerLeak(t, "redaction sweep", errStr)
}

// ----------------------------------------------------------------------------
// token_reader_test.go content (kept in one package file).
// ----------------------------------------------------------------------------

func TestTokenReader_RejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.token")
	if err := os.WriteFile(real, []byte(canonicalBearer), 0o600); err != nil {
		t.Fatalf("seed real: %v", err)
	}
	link := filepath.Join(dir, "link.token")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unsupported on this platform: %v", err)
	}
	if _, err := rest.ReadTokenFile(link); err == nil {
		t.Fatalf("expected error on symlink, got nil")
	} else if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink-rejection error, got: %v", err)
	}
}

func TestTokenReader_RejectsWrongMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "loose.token")
	if err := os.WriteFile(path, []byte(canonicalBearer), 0o644); err != nil {
		t.Fatalf("seed loose: %v", err)
	}
	if _, err := rest.ReadTokenFile(path); err == nil {
		t.Fatalf("expected error on mode 0644, got nil")
	} else if !strings.Contains(err.Error(), "0600") {
		t.Fatalf("expected mode-rejection error, got: %v", err)
	}
}

func TestTokenReader_RejectsDirectory(t *testing.T) {
	dir := t.TempDir()
	if _, err := rest.ReadTokenFile(dir); err == nil {
		t.Fatalf("expected error on directory, got nil")
	}
}

func TestTokenReader_RejectsEmptyPath(t *testing.T) {
	if _, err := rest.ReadTokenFile(""); err == nil {
		t.Fatalf("expected error on empty path")
	}
	if _, err := rest.ReadTokenFile("   "); err == nil {
		t.Fatalf("expected error on whitespace path")
	}
}

func TestTokenReader_RejectsMissing(t *testing.T) {
	if _, err := rest.ReadTokenFile(filepath.Join(t.TempDir(), "nope.token")); err == nil {
		t.Fatalf("expected error on missing file")
	}
}

func TestTokenReader_HappyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hub.token")
	if err := os.WriteFile(path, []byte(canonicalBearer), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	got, err := rest.ReadTokenFile(path)
	if err != nil {
		t.Fatalf("ReadTokenFile: %v", err)
	}
	if got != canonicalBearer {
		t.Fatalf("bearer mismatch: want %q got %q", canonicalBearer, got)
	}
}

// TestTokenReader_ErrorMessagesNeverContainBearer asserts the
// redaction invariant on every error path of ReadTokenFile.
func TestTokenReader_ErrorMessagesNeverContainBearer(t *testing.T) {
	dir := t.TempDir()

	// Loose mode — error must not contain bearer.
	loose := filepath.Join(dir, "loose.token")
	if err := os.WriteFile(loose, []byte(canonicalBearer), 0o644); err != nil {
		t.Fatalf("seed loose: %v", err)
	}
	if _, err := rest.ReadTokenFile(loose); err != nil {
		assertNoBearerLeak(t, "loose mode error", err.Error())
	}

	// Missing file — error must not contain bearer.
	if _, err := rest.ReadTokenFile(filepath.Join(dir, "missing.token")); err != nil {
		assertNoBearerLeak(t, "missing file error", err.Error())
	}

	// Directory — error must not contain bearer.
	if _, err := rest.ReadTokenFile(dir); err != nil {
		assertNoBearerLeak(t, "directory error", err.Error())
	}
}

// ----------------------------------------------------------------------------
// Test entry point used by the TS harness when it spawns the
// compiled binary directly with -test.run. The function is a
// no-op marker; the real assertions live in the *_test functions
// above. The marker exists so the TS harness can run a single
// smoke check without specifying -test.run.
// ----------------------------------------------------------------------------

func TestRestHarnessMarker(t *testing.T) {
	// Smoke check: building a client and reading a token file
	// must not panic. The harness marker is what the TS test
	// runs when no subtest name is supplied; it does not need
	// to do more than prove the package is loadable.
	c := rest.NewClient("http://example.invalid", "tok", nil)
	if c == nil {
		t.Fatalf("rest.NewClient returned nil")
	}
	if _, err := rest.ReadTokenFile("/this/path/does/not/exist/hub.token"); err == nil {
		t.Fatalf("rest.ReadTokenFile on missing file: expected error, got nil")
	}
}

// sentinel: ensure fmt is referenced so go vet on older toolchains
// does not flag the file.
var _ = fmt.Sprintf
