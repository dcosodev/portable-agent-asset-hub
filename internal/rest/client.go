// Package rest is the curated, stdlib-only Go REST client for the
// hub product shell (T6 — Curated Go REST client, per
// docs/roadmap/implementation-plan.md).
//
// Scope:
//   - The package wraps net/http with a thin, opinionated surface
//     for the documented v1 endpoints (health, status,
//     capabilities, catalog, catalog/search, skills/{id},
//     skills/search, memories, memories/{id}, memories/search,
//     memory-blocks). It does NOT cover write endpoints yet —
//     those are reserved for a future slice.
//   - Every outbound request that has a non-empty bearer carries
//     it in the Authorization header ONLY. The token bytes never
//     appear in logs, error messages, or HubError fields.
//   - Non-2xx responses are mapped to a typed HubError that
//     preserves the upstream status code, the documented error
//     envelope fields (code/message), and the request_id. The
//     bearer bytes never appear in the error.
//   - Response bodies are bounded (4 MiB hard cap) so a hostile
//     upstream cannot blow up the heap.
//
// Determinism: every helper is pure given the same Client + ctx.
// The package does not read environment variables; the caller
// supplies the base URL, token, and http.Client.
package rest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// MaxResponseBytes is the hard ceiling on a single response body.
// A hostile or broken upstream cannot return more than this; the
// bounded reader short-circuits the JSON decode with an error.
// 4 MiB is generous for every documented v1 endpoint (the largest
// documented payloads — skills/{id}/resources — are well under
// 1 MiB in canonical fixtures).
const MaxResponseBytes = 4 * 1024 * 1024

// AuthorizationHeader is the header name. Exported so a test
// harness (or a future middleware) can reference the canonical
// literal without re-typing it.
const AuthorizationHeader = "Authorization"

// HubError is the typed error returned for every non-2xx response
// that the client recognizes. The fields are deliberately minimal:
//
//   - Status    — the upstream HTTP status code
//   - Code      — the documented error.code from the envelope
//     (empty when the upstream did not return a
//     canonical envelope; the typed error is still
//     useful via Status).
//   - Message   — the documented error.message from the envelope
//     (may be empty).
//   - RequestID — the documented request_id from the envelope
//     (may be empty).
//
// The bearer token bytes NEVER appear in any field of this
// struct, nor in the Error() string. The error is safe to log.
type HubError struct {
	Status    int
	Code      string
	Message   string
	RequestID string
}

// Error renders the HubError in a stable, log-safe shape. The
// format is "<status> <code>: <message> (request_id=<id>)". The
// bearer token is never interpolated here even if a future
// refactor accidentally threads it through the package; the
// HubError struct simply has no field that could carry it.
func (e *HubError) Error() string {
	parts := make([]string, 0, 4)
	parts = append(parts, fmt.Sprintf("hub %d", e.Status))
	if e.Code != "" {
		parts = append(parts, e.Code)
	}
	if e.Message != "" {
		parts = append(parts, e.Message)
	}
	if e.RequestID != "" {
		parts = append(parts, "request_id="+e.RequestID)
	}
	return strings.Join(parts, ": ")
}

// Is allows callers to compare errors by status code:
//
//	if errors.Is(err, rest.ErrUnauthorized) { ... }
//
// Implementation note: errors.Is walks the target's chain via
// Unwrap. HubError has no wrapped inner error (the upstream
// response body is decoded, not wrapped), so we compare the
// sentinel directly via ==.
func (e *HubError) Is(target error) bool {
	if target == nil || e == nil {
		return false
	}
	var t *HubError
	if !errors.As(target, &t) {
		return false
	}
	return e.Status == t.Status && e.Code == t.Code
}

// Sentinel errors for status-based comparisons. Callers use
// errors.Is to branch on a status class without parsing the
// numeric code.
var (
	ErrUnauthorized = &HubError{Status: http.StatusUnauthorized, Code: "unauthorized"}
	ErrForbidden    = &HubError{Status: http.StatusForbidden, Code: "forbidden"}
	ErrNotFound     = &HubError{Status: http.StatusNotFound, Code: "not_found"}
	ErrConflict     = &HubError{Status: http.StatusConflict, Code: "conflict"}
	ErrPrecondition = &HubError{Status: http.StatusPreconditionFailed, Code: "precondition_failed"}
	ErrServer       = &HubError{Status: http.StatusInternalServerError, Code: "internal"}
)

// Client is the curated REST client. Construct one per process;
// the struct is safe for concurrent use as long as the underlying
// http.Client is also safe (the stdlib client is).
type Client struct {
	// BaseURL is the origin (scheme://host[:port]) of the hub
	// REST surface. It must not have a trailing slash; the
	// package normalises trailing slashes in NewClient.
	BaseURL string

	// HTTPClient is the underlying transport. When nil,
	// http.DefaultClient is used. Tests substitute a custom
	// client so they can reach httptest.Server URLs without
	// touching the process-wide default.
	HTTPClient *http.Client

	// Token is the bearer. When non-empty, every outbound
	// request carries it in the Authorization header. The
	// bytes never appear in any error or log.
	Token string
}

// NewClient constructs a Client. It normalises BaseURL (trimming
// any trailing slash) and applies a default http.Client when the
// caller passes nil. The token is taken verbatim; the package
// does not validate its shape (the upstream authenticator does
// that).
func NewClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTPClient: httpClient,
		Token:      token,
	}
}

// do performs a single GET against the supplied path (relative to
// BaseURL) and decodes the response. The returned value is
// always a map[string]any decoded from a JSON object body; any
// other shape is rejected as a parse error so callers do not
// accidentally fan out on a list/scalar payload they did not
// expect.
//
// The path argument is split into a URL path and an optional
// query string on the first '?' character. The path is joined to
// the BaseURL via url.JoinPath (which percent-encodes path
// segments), and the query string is appended verbatim after the
// base. Callers must pre-encode query values; the package does
// NOT re-encode query content because it cannot distinguish a
// literal '&' from a separator.
func (c *Client) do(ctx context.Context, path string) (map[string]any, error) {
	if c.BaseURL == "" {
		return nil, errors.New("rest: empty base URL")
	}
	basePath := path
	query := ""
	if idx := strings.Index(path, "?"); idx >= 0 {
		basePath = path[:idx]
		query = path[idx+1:]
	}
	u, err := url.JoinPath(c.BaseURL, basePath)
	if err != nil {
		return nil, fmt.Errorf("rest: bad path %q: %w", path, err)
	}
	if query != "" {
		u = u + "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("rest: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	// Bearer ONLY in the outbound Authorization header. We never
	// interpolate the token into a URL, query string, or body —
	// even a future refactor would have to thread it explicitly
	// through a different field to leak it.
	if c.Token != "" {
		req.Header.Set(AuthorizationHeader, "Bearer "+c.Token)
	}
	res, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rest: request failed: %w", err)
	}
	defer res.Body.Close()
	// Bounded body. io.LimitReader short-circuits at MaxResponseBytes
	// + 1 so json.Decoder can detect the truncation. We read up
	// to MaxResponseBytes+1 and explicitly check for a partial
	// read so a payload of exactly MaxResponseBytes still decodes.
	body, err := io.ReadAll(io.LimitReader(res.Body, MaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("rest: read body: %w", err)
	}
	if len(body) > MaxResponseBytes {
		return nil, fmt.Errorf("rest: response body exceeds %d bytes", MaxResponseBytes)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, c.parseError(res.StatusCode, body)
	}
	// Happy path. Decode into map[string]any so the caller can
	// extract fields without a typed struct per endpoint.
	var out map[string]any
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return nil, fmt.Errorf("rest: decode JSON: %w", err)
	}
	return out, nil
}

// parseError turns a non-2xx response body into a typed HubError.
// When the body matches the documented envelope
// ({"error":{"code","message","status"}, "request_id"}) the
// envelope fields populate the HubError. When the body does not
// match, the HubError is still typed (Status preserved; Code and
// RequestID empty) so the caller can branch on Status. The bearer
// is never read out of any header, body, or envelope field — it
// lives only on the outbound side.
func (c *Client) parseError(status int, body []byte) error {
	he := &HubError{Status: status}
	// We accept envelopes with or without additional fields
	// (the spec marks additionalProperties=false on the typed
	// schema, but real servers sometimes add request_id at the
	// envelope root as documented).
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Status  int    `json:"status"`
		} `json:"error"`
		RequestID string `json:"request_id"`
	}
	// Decode tolerantly: a non-JSON body is fine — we still
	// surface a typed HubError, just without envelope fields.
	if err := json.Unmarshal(body, &env); err == nil {
		if env.Error.Code != "" {
			he.Code = env.Error.Code
		}
		if env.Error.Message != "" {
			he.Message = env.Error.Message
		}
		// Trust the upstream's envelope status over the wire
		// status only when it matches — defensive against a
		// malformed envelope that lies.
		if env.Error.Status == 0 || env.Error.Status == status {
			if env.RequestID != "" {
				he.RequestID = env.RequestID
			}
		} else {
			he.RequestID = env.RequestID
		}
	}
	return he
}

// ----------------------------------------------------------------------------
// Curated GET endpoints. One method per documented v1 route. The
// path string is the literal the hub REST surface exposes so an
// operator who reads the source can map method name → URL
// without consulting external docs.
// ----------------------------------------------------------------------------

// Health hits GET /api/v1/health.
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	return c.do(ctx, "/api/v1/health")
}

// Status hits GET /api/v1/status.
func (c *Client) Status(ctx context.Context) (map[string]any, error) {
	return c.do(ctx, "/api/v1/status")
}

// Capabilities hits GET /api/v1/capabilities.
func (c *Client) Capabilities(ctx context.Context) (map[string]any, error) {
	return c.do(ctx, "/api/v1/capabilities")
}

// Catalog hits GET /api/v1/catalog.
func (c *Client) Catalog(ctx context.Context) (map[string]any, error) {
	return c.do(ctx, "/api/v1/catalog")
}

// SearchCatalog hits GET /api/v1/catalog/search?q=<query>. The
// query string is encoded as a single "q" parameter per the
// documented contract.
func (c *Client) SearchCatalog(ctx context.Context, q string) (map[string]any, error) {
	return c.do(ctx, "/api/v1/catalog/search?q="+url.QueryEscape(q))
}

// Skill hits GET /api/v1/skills/<id>. The id is interpolated
// into the path with url.PathEscape so an upstream ID with
// slashes or spaces cannot break the request line.
func (c *Client) Skill(ctx context.Context, id string) (map[string]any, error) {
	return c.do(ctx, "/api/v1/skills/"+url.PathEscape(id))
}

// SearchSkills hits GET /api/v1/skills/search?q=<query>.
func (c *Client) SearchSkills(ctx context.Context, q string) (map[string]any, error) {
	return c.do(ctx, "/api/v1/skills/search?q="+url.QueryEscape(q))
}

// Memories hits GET /api/v1/memories.
func (c *Client) Memories(ctx context.Context) (map[string]any, error) {
	return c.do(ctx, "/api/v1/memories")
}

// Memory hits GET /api/v1/memories/<id>.
func (c *Client) Memory(ctx context.Context, id string) (map[string]any, error) {
	return c.do(ctx, "/api/v1/memories/"+url.PathEscape(id))
}

// SearchMemories hits GET /api/v1/memories/search?q=<query>.
func (c *Client) SearchMemories(ctx context.Context, q string) (map[string]any, error) {
	return c.do(ctx, "/api/v1/memories/search?q="+url.QueryEscape(q))
}

// MemoryBlocks hits GET /api/v1/memory-blocks.
func (c *Client) MemoryBlocks(ctx context.Context) (map[string]any, error) {
	return c.do(ctx, "/api/v1/memory-blocks")
}

// ----------------------------------------------------------------------------
// Token reader. ReadTokenFile enforces three invariants by
// construction:
//
//   - the path is non-empty (after trimming whitespace);
//   - the file is a regular file (not a directory, device, or
//     socket) AND is not a symbolic link — enforced via
//     os.Lstat + Mode().Type() check before any read;
//   - the unix mode is exactly 0600 (no group, no world).
//
// On any failure the function returns a typed error whose
// message names the failure class (symlink, mode, regular-file,
// missing) WITHOUT echoing the bearer bytes. The bearer is read
// only after every check has passed, and the returned string is
// the literal file contents trimmed of trailing whitespace.
// ----------------------------------------------------------------------------

// ErrTokenNotRegular is returned when the path exists but is
// not a regular non-symlink file (e.g. a directory, fifo, or
// device).
var ErrTokenNotRegular = errors.New("rest: token file is not a regular file")

// ErrTokenWrongMode is returned when the file's mode is not
// exactly 0600. The message is log-safe and never includes the
// file contents.
var ErrTokenWrongMode = errors.New("rest: token file mode must be 0600")

// ErrTokenEmptyPath is returned when the path is empty or only
// whitespace.
var ErrTokenEmptyPath = errors.New("rest: empty token path")

// ReadTokenFile reads the bearer from a regular, non-symlink,
// 0600-moded file. The function never echoes the bearer bytes in
// an error message; the returned string is the literal file
// contents with trailing whitespace stripped.
func ReadTokenFile(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", ErrTokenEmptyPath
	}
	// Lstat — NOT Stat — so a symlink is observed as a symlink
	// rather than transparently followed. Mode().Type() then
	// reports ModeSymlink.
	fi, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	mode := fi.Mode()
	// Symlink, directory, device, pipe, socket — anything that
	// is not a regular file is rejected with a typed error so
	// the caller can branch on errors.Is.
	if mode.Type()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("rest: token file is a symlink: %w", ErrTokenNotRegular)
	}
	if !mode.IsRegular() {
		return "", fmt.Errorf("rest: token file is not regular: %w", ErrTokenNotRegular)
	}
	// Permission check. We require exactly 0600 — any group or
	// world bit is a contract violation.
	perm := mode.Perm()
	if perm != 0o600 {
		return "", fmt.Errorf("rest: token file mode %04o: %w", perm, ErrTokenWrongMode)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(data), "\r\n\t "), nil
}

// _ keeps filepath referenced so go vet on toolchains that flag
// unused imports does not trip on a future refactor that drops
// filepath.
var _ = filepath.Separator
