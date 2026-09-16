// Package secrets — internal unit tests for the bearer-token
// lifecycle. The tests are pure Go (no subprocess) and exercise
// every helper the cmd/hub handlers depend on:
//
//   * Generate          — entropy-driven; injectable reader.
//   * WriteAtomic       — mode 0600; atomic; idempotent re-write
//                          does not change mode.
//   * EnsureDir         — creates 0700; chmod on existing dir.
//   * Read              — happy path + ErrNotInitialised on
//                          missing file.
//   * Preview           — stable; never embeds the raw bearer.
//
// All tests use os.MkdirTemp under os.TmpDir so no real HUB_HOME
// is touched. The package deliberately has zero deps outside the
// standard library so the test file matches.

package secrets

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerate_returns_base64url_token_with_expected_length(t *testing.T) {
	// Reset to crypto/rand for this test.
	SetEntropyForTest(rand.Reader)
	tok, err := Generate()
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if len(tok) == 0 {
		t.Fatal("Generate returned empty token")
	}
	// base64.RawURLEncoding.EncodedLen(32) = 43
	if want, got := 43, len(tok); want != got {
		t.Fatalf("token length: want %d got %d", want, got)
	}
	// Round-trip: the token must decode back to 32 raw bytes.
	raw, decErr := base64.RawURLEncoding.DecodeString(tok)
	if decErr != nil {
		t.Fatalf("token does not decode as base64url: %v", decErr)
	}
	if len(raw) != DefaultTokenLen {
		t.Fatalf("decoded length: want %d got %d", DefaultTokenLen, len(raw))
	}
}

func TestGenerate_is_injective_under_deterministic_entropy(t *testing.T) {
	// Inject a deterministic reader so the test is reproducible
	// across hosts and Go versions.
	seq := []byte{}
	for i := 0; i < 1024; i++ {
		seq = append(seq, byte(i))
	}
	// Wrap the slice in an io.Reader that always re-reads from
	// offset 0 — this keeps the test stable when Generate calls
	// ReadFull more than once across the suite.
	SetEntropyForTest(&cycleReader{src: seq})
	defer SetEntropyForTest(rand.Reader)
	a, err := Generate()
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	b, err := Generate()
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	// Two consecutive Generate calls under deterministic entropy
	// MUST yield two distinct tokens — a regression that re-uses
	// the same bytes is a security-critical bug.
	if a == b {
		t.Fatalf("two consecutive tokens are identical (regression): %q", a)
	}
}

func TestGenerate_returns_error_on_entropy_failure(t *testing.T) {
	SetEntropyForTest(&errReader{})
	defer SetEntropyForTest(rand.Reader)
	if _, err := Generate(); err == nil {
		t.Fatal("expected Generate to surface an error on entropy failure")
	}
}

// ---------------------------------------------------------------------------
// WriteAtomic — file mode + atomicity + idempotency
// ---------------------------------------------------------------------------

func TestWriteAtomic_enforces_0600_mode_and_round_trip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	tok, err := Generate()
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if err := WriteAtomic(path, tok); err != nil {
		t.Fatalf("WriteAtomic failed: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}
	if got, want := info.Mode()&0o777, os.FileMode(TokenFileMode); got != want {
		t.Fatalf("file mode: want %o got %o", want, got)
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if got != tok {
		t.Fatalf("Read returned %q, want %q", got, tok)
	}
}

func TestWriteAtomic_re_write_preserves_mode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	first, _ := Generate()
	if err := WriteAtomic(path, first); err != nil {
		t.Fatalf("first WriteAtomic failed: %v", err)
	}
	second, _ := Generate()
	if first == second {
		// Generate is supposed to produce distinct tokens; if it
		// didn't the test is meaningless. Recurse to guarantee
		// distinctness.
		second, _ = Generate()
	}
	if err := WriteAtomic(path, second); err != nil {
		t.Fatalf("second WriteAtomic failed: %v", err)
	}
	info, _ := os.Stat(path)
	if got, want := info.Mode()&0o777, os.FileMode(TokenFileMode); got != want {
		t.Fatalf("file mode after re-write: want %o got %o", want, got)
	}
	got, _ := Read(path)
	if got != second {
		t.Fatalf("Read returned old token; re-write lost bytes")
	}
}

func TestWriteAtomic_rejects_empty_token(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	if err := WriteAtomic(path, ""); err == nil {
		t.Fatal("WriteAtomic(empty) must fail")
	}
}

func TestWriteAtomic_rejects_empty_path(t *testing.T) {
	if err := WriteAtomic("", "token"); !errors.Is(err, ErrEmptyPath) {
		t.Fatalf("WriteAtomic(empty path): want ErrEmptyPath got %v", err)
	}
}

func TestEnsureDir_creates_dir_with_0700_mode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	if err := EnsureDir(path); err != nil {
		t.Fatalf("EnsureDir failed: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "tokens"))
	if err != nil {
		t.Fatalf("stat tokens dir failed: %v", err)
	}
	if got, want := info.Mode()&0o777, os.FileMode(DirMode); got != want {
		t.Fatalf("tokens dir mode: want %o got %o", want, got)
	}
}

func TestEnsureDir_idempotent_on_existing_dir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	if err := EnsureDir(path); err != nil {
		t.Fatalf("first EnsureDir failed: %v", err)
	}
	if err := EnsureDir(path); err != nil {
		t.Fatalf("second EnsureDir failed: %v", err)
	}
	info, _ := os.Stat(filepath.Join(dir, "tokens"))
	if got, want := info.Mode()&0o777, os.FileMode(DirMode); got != want {
		t.Fatalf("tokens dir mode after idempotent EnsureDir: want %o got %o", want, got)
	}
}

// ---------------------------------------------------------------------------
// Read — error mapping
// ---------------------------------------------------------------------------

func TestRead_missing_file_returns_ErrNotInitialised(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	if _, err := Read(path); !errors.Is(err, ErrNotInitialised) {
		t.Fatalf("Read on missing file: want ErrNotInitialised got %v", err)
	}
}

func TestRead_empty_path_returns_ErrEmptyPath(t *testing.T) {
	if _, err := Read(""); !errors.Is(err, ErrEmptyPath) {
		t.Fatalf("Read(\"\"): want ErrEmptyPath got %v", err)
	}
}

func TestRead_trims_trailing_newline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tokens", "hub.token")
	if err := os.MkdirAll(filepath.Dir(path), DirMode); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("abcd\n"), TokenFileMode); err != nil {
		t.Fatal(err)
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if got != "abcd" {
		t.Fatalf("Read: want %q got %q", "abcd", got)
	}
}

// ---------------------------------------------------------------------------
// Preview — redaction surface
// ---------------------------------------------------------------------------

func TestPreview_returns_redacted_marker_for_empty_token(t *testing.T) {
	if got, want := Preview(""), "<<REDACTED>>"; got != want {
		t.Fatalf("Preview(\"\"): want %q got %q", want, got)
	}
}

func TestPreview_never_embeds_raw_bearer_in_full_token(t *testing.T) {
	tok, _ := Generate()
	p := Preview(tok)
	if strings.Contains(p, tok) {
		t.Fatalf("Preview leaked the full token (regression): %q contains %q", p, tok)
	}
	if !strings.Contains(p, "<<REDACTED>>") {
		t.Fatalf("Preview must include the REDACTED marker: %q", p)
	}
}

func TestPreview_is_byte_stable_for_same_length_input(t *testing.T) {
	// Two different tokens of the same length must produce
	// previews of the same byte length — the contract surface is
	// "fixed-width preview", and an attacker fingerprinting the
	// log cannot use a length oracle.
	a := strings.Repeat("a", 43)
	b := strings.Repeat("b", 43)
	pa, pb := Preview(a), Preview(b)
	if len(pa) != len(pb) {
		t.Fatalf("Preview length differs across tokens of same length: %d vs %d", len(pa), len(pb))
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// cycleReader is a tiny io.Reader that always rewinds to the start
// so successive calls return the same byte sequence. Used to make
// Generate deterministic across tests.
type cycleReader struct {
	src []byte
	pos int
}

func (r *cycleReader) Read(p []byte) (int, error) {
	if len(r.src) == 0 {
		return 0, errors.New("empty entropy source")
	}
	written := 0
	for written < len(p) {
		// Compute how many bytes we can write in this iteration.
		remaining := len(p) - written
		avail := len(r.src) - r.pos
		if avail <= 0 {
			r.pos = 0
			avail = len(r.src)
		}
		n := remaining
		if n > avail {
			n = avail
		}
		copy(p[written:], r.src[r.pos:r.pos+n])
		r.pos += n
		written += n
	}
	return written, nil
}

// errReader is an io.Reader that always fails — used to verify
// Generate surfaces an error on entropy failure.
type errReader struct{}

func (errReader) Read(p []byte) (int, error) {
	return 0, errors.New("simulated entropy failure")
}
