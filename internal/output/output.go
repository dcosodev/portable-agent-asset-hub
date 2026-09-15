// Package output is the single boundary through which hub writes
// anything to the operator. Per docs/architecture/go-product-shell.md:
//
//   - stdout MUST carry the contract surface (human-readable Info, the
//     `--json` payload, the `--help` text). Operators and orchestrators
//     parse stdout.
//
//   - stderr MUST carry diagnostic, warning, and error output. CI
//     pipelines key off `stderr != ""` to detect a non-zero exit, so
//     stderr is reserved for failure signaling.
//
//   - The output stream MUST respect CI: when `$CI` is set and
//     non-empty, the shell MUST NOT emit interactive prompts or ANSI
//     color codes. `IsCI` exposes that probe.
//
//   - The output stream MUST NOT include bearer-shaped strings. A
//     bearer-shaped string is any continuous run of
//     [A-Za-z0-9._~+/=-]{20,} that is either:
//
//   - prefixed by `Bearer ` / `bearer ` (case-insensitive), or
//
//   - prefixed by `HUB_BEARER_TOKEN=`, or
//
//   - matched as a JWT (`<hdr>.<payload>.<sig>` where each segment is
//     base64url).
//
//     `Redact` replaces the match with the literal "<<REDACTED>>"
//     token so the operator can see that something was stripped
//     without learning the value. `LooksLikeBearer` exposes the
//     predicate so tests and the s11 gate can probe output without
//     coupling to the redactor.
package output

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Sink is the abstraction over stdout/stderr. main.go wires the real
// sinks to os.Stdout and os.Stderr; tests inject byte buffers so they
// can assert on byte-exact output without spawning subprocesses.
type Sink struct {
	Out    SinkFn
	Err    SinkFn
	isCI   bool
	stderr *os.File // optional override; nil means "use os.Stderr"
}

// SinkFn is the per-write sink. Bytes are the raw payload (already
// formatted by the caller); the sink returns any write error so the
// caller can surface a structured diagnostic.
type SinkFn func(b []byte) (int, error)

// New returns a sink wired to os.Stdout / os.Stderr. isCI is taken
// from the env probe — see IsCI.
func New() *Sink {
	return &Sink{
		Out:  func(b []byte) (int, error) { return os.Stdout.Write(b) },
		Err:  func(b []byte) (int, error) { return os.Stderr.Write(b) },
		isCI: IsCI(),
	}
}

// NewForTest returns a sink whose stdout/stderr point at the supplied
// SinkFn pair. The isCI flag is set explicitly so tests stay
// deterministic even when the host runs in CI.
func NewForTest(out, err SinkFn, isCI bool) *Sink {
	return &Sink{Out: out, Err: err, isCI: isCI}
}

// IsCI reports whether the current process is running in a CI
// environment. The check is intentionally strict: we only treat
// "obviously non-interactive" signals as CI so an operator's local
// terminal is never accidentally silenced.
func IsCI() bool {
	for _, key := range []string{"CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE"} {
		if v := os.Getenv(key); v != "" && v != "0" && v != "false" {
			return true
		}
	}
	return false
}

// IsInteractive returns the negation of IsCI. The shell respects
// IsInteractive for future interactive helpers; today every command
// is non-interactive so this exists for forward compatibility.
func (s *Sink) IsInteractive() bool { return !s.isCI }

// Printf writes a single line to stdout. The function is the canonical
// line writer: every contract payload that leaves stdout passes through
// here. The implementation appends a trailing '\n' when (and only when)
// the rendered line does not already end with one, so callers do not
// need to remember to terminate every line. This makes the contract
// surface (help, version, path, config) byte-deterministic for the
// s11 gate's line-by-line assertions while preserving the historical
// "PassPrintf("%s", line)" call shape.
func (s *Sink) Printf(format string, a ...any) error {
	return s.writeLine(s.Out, format, a...)
}

// Errorf writes a single diagnostic line to stderr. The trailing '\n'
// rule mirrors Printf: a line is always newline-terminated so CI
// pipelines can rely on "stderr != empty" as a fail signal. The
// function MUST be used for diagnostics, warnings, and errors; CI
// pipelines key off "stderr != empty AND exit != 0".
func (s *Sink) Errorf(format string, a ...any) error {
	return s.writeLine(s.Err, format, a...)
}

// writeLine formats the message and writes it through fn, appending a
// trailing '\n' when the rendered output does not already end with
// one. An empty rendered payload still produces a single '\n' so an
// empty separator in the help text emits a real blank line — without
// this, the help block would render as a single run-on paragraph.
//
// The buffer-then-write strategy avoids two syscalls per Printf on
// the common "format then '\n'" path and keeps the trailing-newline
// check byte-exact. Re-redaction is unnecessary because the caller is
// expected to feed already-redacted content; this method only adds
// framing, never content.
func (s *Sink) writeLine(fn SinkFn, format string, a ...any) error {
	var buf []byte
	// fmt.Sprintf allocates; using it directly here keeps the call
	// shape identical to the previous Fprintf path so any future
	// fmt-state migration stays a single-file change.
	msg := fmt.Sprintf(format, a...)
	if msg == "" {
		buf = []byte("\n")
	} else if msg[len(msg)-1] == '\n' {
		buf = []byte(msg)
	} else {
		buf = make([]byte, 0, len(msg)+1)
		buf = append(buf, msg...)
		buf = append(buf, '\n')
	}
	_, err := fn(buf)
	return err
}

// ----------------------------------------------------------------------------
// Bearer hygiene
// ----------------------------------------------------------------------------
//
// Three categories of bearer-shaped strings are recognised. The regex
// set is small and explicit so the s11 gate can probe output and so
// tests can exercise each pattern in isolation.

// BearerPrefix is the canonical Authorization header prefix the
// hub-rest client emits. Both `Bearer ` and `bearer ` (case
// insensitive) are matched.
const BearerPrefix = "Bearer "

// bearerHeaderRe matches an HTTP Authorization-style header carrying
// a long opaque token. The token body is the same base64url alphabet
// that JWTs use; the regex uses a guard of 20+ chars so it never
// redacts ordinary words.
var bearerHeaderRe = regexp.MustCompile(`(?i)(?:bearer\s+)([A-Za-z0-9._~+/=-]{20,})`)

// envRe matches the env-var assignment pattern
// `HUB_BEARER_TOKEN=<value>`. The prefix is fixed so it cannot be
// confused with arbitrary `KEY=value` lists that happen to contain a
// long alphanumeric token.
var envRe = regexp.MustCompile(`(?i)\bHUB_BEARER_TOKEN\b\s*=\s*([^\s,'"]+)`)

// fileRe matches an `Authorization:` or `Authorization: Bearer …`
// line that wraps in shell config files. The match is anchored on
// `Authorization` to keep the regex narrow.
var fileRe = regexp.MustCompile(`(?im)\bauthorization\s*[:=]\s*(?:bearer\s+)?([A-Za-z0-9._~+/=-]{20,})`)

// jwtRe matches a JWT (header.payload.signature, base64url) anywhere
// in the input. The split on `.` lets us reject obvious random strings
// that happen to be long.
var jwtRe = regexp.MustCompile(`\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`)

const redactedMarker = "<<REDACTED>>"

// LooksLikeBearer reports whether the input contains ANY bearer-shaped
// string. It is the predicate the s11 gate uses: every captured
// stdout/stderr line is fed through LooksLikeBearer and the gate fails
// closed if a hit is reported.
func LooksLikeBearer(s string) bool {
	if s == "" {
		return false
	}
	return bearerHeaderRe.MatchString(s) ||
		envRe.MatchString(s) ||
		fileRe.MatchString(s) ||
		jwtRe.MatchString(s)
}

// Redact replaces every bearer-shaped string in the input with
// `<<REDACTED>>`. The redactor is the single source of truth for
// redaction — every output sink consults Redact before writing.
// Redact is deterministic: it returns the same output for the same
// input, regardless of when it is called.
func Redact(s string) string {
	if s == "" {
		return s
	}
	out := s
	out = bearerHeaderRe.ReplaceAllString(out, BearerPrefix+redactedMarker)
	out = envRe.ReplaceAllString(out, "HUB_BEARER_TOKEN="+redactedMarker)
	out = fileRe.ReplaceAllString(out, "Authorization: "+redactedMarker)
	// JWTs: replace each match while preserving the three-segment
	// shape so the reader sees that something was here.
	out = jwtRe.ReplaceAllStringFunc(out, func(m string) string {
		parts := strings.Split(m, ".")
		if len(parts) != 3 {
			return redactedMarker
		}
		return "<<REDACTED>>.<<REDACTED>>.<<REDACTED>>"
	})
	return out
}
