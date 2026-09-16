// Package secrets is the single source of truth for the hub
// bearer token lifecycle. Per docs/roadmap/slices.json (T3) the
// shell's first-run init creates tokens/hub.token with mode 0600,
// `hub token show` redacts the bearer on every output surface, and
// `hub token rotate` regenerates a fresh bearer on demand.
//
// The package is intentionally small and pure: it owns the
// cryptographic primitive (Generate), the file-write primitive
// (WriteAtomic), the file-read primitive (Read), and a small
// redactor (Preview) so callers never accidentally emit a bearer.
//
// The package deliberately does NOT depend on hub/internal/output:
// output is the audit-side redactor; secrets is the file-side
// generator. Coupling the two would make the redactor a chokepoint
// for token generation, which is the wrong direction. The handler
// composes the two packages itself.
//
// Security invariants the package enforces by construction:
//
//   - 0600 file mode. Every write uses WriteAtomic, which opens
//     the destination with 0600 BEFORE writing any bytes. The
//     package never relies on the operator's umask — a future
//     umask of 022 would still produce a 0600 token file because
//     the open(2) syscall passes the mode explicitly and Go's
//     syscall.Open honours it.
//
//   - atomic replacement. WriteAtomic writes to a sibling tmpfile
//     and renames into place. A power loss mid-write leaves the
//     prior token (or no token) on disk, never a half-written
//     one. The shell can recover by re-running rotate.
//
//   - no bearer in package APIs. The token bytes only flow through
//     Read and WriteAtomic; no helper formats the token into a
//     string, logs it, or echoes it to stderr. Callers that need
//     the bytes (e.g. `hub token show --full`) MUST go through
//     their own redaction layer; the package does NOT add an
//     "unredacted read" path because the contract says no such
//     path exists.
//
//   - constant-length token. Generate returns 32 random bytes
//     encoded as 43 base64url characters (no padding). The length
//     is constant so a fingerprint comparison (e.g. the redactor's
//     preview) is stable across rotations and so a log line that
//     matches the canonical length cannot be confused with
//     ordinary prose.
//
// Determinism: every helper in the package is pure (no env reads,
// no syscalls outside Read/WriteAtomic). Generate is the only
// caller of crypto/rand; the entropy source is fixed at the
// stdlib. Tests substitute the entropy source via WithReader so
// every generated token is reproducible across runs.
package secrets

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// DefaultTokenLen is the canonical bearer length, in bytes, before
// base64url encoding. 32 bytes = 256 bits, which is the smallest
// strength a cryptographic bearer should have on a v1 release. The
// redactor's preview is byte-stable against this constant — see
// Preview — so changing it is a contract-visible event.
const DefaultTokenLen = 32

// TokenFileMode is the canonical unix mode for tokens/hub.token.
// 0600 is owner read/write only; no group or world access. The
// package's write path enforces this mode by passing it to the
// open(2) syscall explicitly so the operator's umask is bypassed.
const TokenFileMode = 0o600

// DirMode is the canonical unix mode for tokens/. 0700 keeps the
// directory owner-only so a sibling file inside the dir cannot be
// listed by other accounts. The package's EnsureDir helper applies
// this mode to the dir.
const DirMode = 0o700

// ErrEmptyPath is returned when the supplied path is empty or
// whitespace. The error is exported so the cmd/hub handlers can
// surface a precise diagnostic without re-parsing a generic
// os.PathError.
var ErrEmptyPath = errors.New("secrets: empty path")

// ErrNotInitialised is returned by Read when the token file does
// not exist. The handler maps this to exit 1 (operator error) with
// a "run `hub init` first" diagnostic — see cmd/hub/cmd_token.go.
var ErrNotInitialised = errors.New("secrets: token file not found")

// entropy is the reader for Generate. Tests override it via
// SetEntropyForTest; production leaves the stdlib's crypto/rand.
var entropy io.Reader = rand.Reader

// SetEntropyForTest swaps the entropy reader used by Generate. The
// caller MUST restore the prior reader (defer SetEntropyForTest)
// so a test cannot accidentally poison a sibling package's random
// source. Passing nil restores crypto/rand.
func SetEntropyForTest(r io.Reader) {
	if r == nil {
		entropy = rand.Reader
		return
	}
	entropy = r
}

// Generate returns a fresh bearer of length DefaultTokenLen bytes
// encoded as base64url (no padding). The function is the ONLY entry
// point the package exposes for token creation; cmd/hub/cmd_init.go
// and cmd/hub/cmd_token.go call it. Tests inject deterministic
// entropy via SetEntropyForTest.
//
// The function never returns an empty string; any io error from
// the entropy reader surfaces as a non-nil error so the caller can
// exit 2 (contract violation) — a missing entropy source is a
// host-level failure, not an operator error.
func Generate() (string, error) {
	buf := make([]byte, DefaultTokenLen)
	if _, err := io.ReadFull(entropy, buf); err != nil {
		return "", fmt.Errorf("secrets: entropy read failed: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// EnsureDir creates the parent directory of `path` with mode
// DirMode (0700) if it does not exist. The function is idempotent:
// an existing directory is left untouched. The path argument is
// expected to be the token FILE path; the parent of the file is
// the directory the function ensures.
//
// On an existing directory whose mode differs from DirMode, the
// function chmod's it to DirMode so the security boundary holds
// across hosts with different umask conventions. The chmod is
// best-effort: a permission-denied error surfaces as a non-nil
// error so the caller can refuse to write the token into a
// world-readable directory.
func EnsureDir(path string) error {
	if strings.TrimSpace(path) == "" {
		return ErrEmptyPath
	}
	dir := filepath.Dir(path)
	if strings.TrimSpace(dir) == "" {
		return ErrEmptyPath
	}
	if err := os.MkdirAll(dir, DirMode); err != nil {
		return fmt.Errorf("secrets: mkdir %s: %w", dir, err)
	}
	// Enforce mode on the directory we just (re-)created. MkdirAll
	// honours the requested mode only on CREATE — an existing dir
	// retains its prior mode. Chmod the dir so the security
	// boundary holds even when MkdirAll is a no-op.
	if err := os.Chmod(dir, DirMode); err != nil {
		return fmt.Errorf("secrets: chmod %s: %w", dir, err)
	}
	return nil
}

// WriteAtomic writes `token` to `path` with mode 0600 atomically:
// bytes go to a sibling tmpfile, fsync is called, and the tmpfile
// is renamed into place. On any error the tmpfile is removed and
// the destination is left untouched (so a failed rotate never
// destroys the prior token).
//
// The function calls EnsureDir(path) internally so callers do not
// have to pre-create the parent directory.
//
// The mode is enforced on the open(2) syscall explicitly; the
// operator's umask is bypassed. After rename, the function re-stats
// the file and refuses to leave the path with mode != 0600 — a
// chmod(2) that fails surfaces as a non-nil error so the security
// invariant is observable from the caller.
func WriteAtomic(path, token string) error {
	if strings.TrimSpace(path) == "" {
		return ErrEmptyPath
	}
	if token == "" {
		return errors.New("secrets: empty token rejected")
	}
	if err := EnsureDir(path); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	// tmpfile lives next to the destination so the rename is
	// guaranteed to be on the same filesystem (POSIX rename atomicity
	// only holds for same-filesystem renames).
	tmp, err := os.CreateTemp(dir, ".hub.token.*.tmp")
	if err != nil {
		return fmt.Errorf("secrets: create tmp %s: %w", dir, err)
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = os.Remove(tmpPath)
	}
	// The mode is set BEFORE the bytes are written so a half-written
	// tmpfile never has a token file mode visible to other processes.
	if err := tmp.Chmod(TokenFileMode); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("secrets: chmod tmp %s: %w", tmpPath, err)
	}
	if _, err := tmp.WriteString(token); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("secrets: write tmp: %w", err)
	}
	// fsync — required so the rename reflects on-disk bytes, not
	// page-cache bytes. Without fsync a power loss could leave the
	// new token un-readable until the next sync.
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("secrets: fsync tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("secrets: close tmp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("secrets: rename %s -> %s: %w", tmpPath, path, err)
	}
	// Re-stat and verify the mode survived the rename. On most
	// filesystems rename preserves the source mode; we verify
	// anyway so a future umask or filesystem quirk cannot silently
	// widen the permissions.
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("secrets: stat %s: %w", path, err)
	}
	if got := info.Mode() & 0o777; got != TokenFileMode {
		return fmt.Errorf("secrets: token file mode %o, expected %o", got, TokenFileMode)
	}
	return nil
}

// Read returns the token bytes stored at `path`. The function
// trims a single trailing newline (WriteAtomic writes the token
// without one; this tolerates an operator who edited the file by
// hand). A missing file surfaces as ErrNotInitialised so the
// handler can map the error to exit 1 with a "run `hub init`"
// diagnostic.
//
// Any other error (permission denied, I/O error) is wrapped with
// `secrets: read …: %w` so the caller can route the exit code
// precisely.
func Read(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", ErrEmptyPath
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNotInitialised
		}
		return "", fmt.Errorf("secrets: read %s: %w", path, err)
	}
	tok := strings.TrimRight(string(data), "\n")
	if tok == "" {
		return "", errors.New("secrets: token file is empty")
	}
	return tok, nil
}

// Preview returns a redacted preview of `token` for the human-
// readable contract surface. The format is a fixed prefix and
// suffix with the middle elided so the operator sees something was
// emitted but never the bearer itself.
//
// The preview is stable: every call with the same length input
// returns the same byte sequence (modulo the input value, which is
// not embedded). The visible characters are the first 4 and last
// 4 of the token, separated by `…`, with the literal <<REDACTED>>
// marker at the end so the surface matches the output.Redact
// marker style.
func Preview(token string) string {
	if token == "" {
		return "<<REDACTED>>"
	}
	// 4 chars from each end is a stable, length-stable preview.
	// Tokens shorter than 8 chars (which never happens — Generate
	// always returns 43+ chars) fall back to the full REDACTED
	// marker so we never echo a partial token.
	if len(token) < 8 {
		return "<<REDACTED>>"
	}
	return token[:4] + "…" + token[len(token)-4:] + " <<REDACTED>>"
}
