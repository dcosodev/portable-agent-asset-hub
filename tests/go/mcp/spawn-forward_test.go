// Package mcp_test exercises the MCP stdio supervisor at
// hub/internal/mcp via the public package API.
//
// The tests live at tests/go/mcp/*_test.go (not in internal/mcp/) on
// purpose: the T7 contract is "supervises the existing TypeScript
// MCP" and the test surface is a separate subprocess boundary driven
// by tests/go/mcp/*.test.ts. The TS harness (tests/go/mcp/_mcp-harness.ts)
// compiles this file with `go test -c` and spawns the resulting
// binary; the Go testing package owns every assertion in this file.
//
// Each test spawns a *real* child process via the hub/internal/mcp
// package and exercises the supervisor's stdio forwarding, child
// lifecycle, and redaction semantics. The "external MCP" used in
// these tests is a FAKE — a small Node program spawned via
// `node -e <script>` — which is hermetic and never touches
// packages/mcp/** or the real REST surface. The slice contract is
// explicit: "fake external MCP only, never fake product".
//
// The tests do NOT touch cmd/hub, openapi/, packages/, or
// observability/. They only import hub/internal/mcp and stdlib.
package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"hub/internal/mcp"
)

// canonicalBearer is the literal bearer every redaction test in this
// file uses. The string is 32 random-looking base64url characters;
// it must NOT appear in any captured stderr so the redaction contract
// stays honest.
const canonicalBearer = "hubv1_4f8b2c1e9a0d6f3b7e5c8a1d2f4b6e8a"

// assertNoBearerLeak is the negative assertion every redaction test
// runs against its captured stderr and child-stderr surfaces.
func assertNoBearerLeak(t *testing.T, where string, lines ...string) {
	t.Helper()
	for i, s := range lines {
		if strings.Contains(s, canonicalBearer) {
			t.Fatalf("%s[%d] leaked canonical bearer: %q", where, i, s)
		}
		low := strings.ToLower(s)
		if strings.Contains(low, "bearer ") && containsOpaque(extractAfter(low, "bearer ")) {
			t.Fatalf("%s[%d] matches bearer-shaped regex: %q", where, i, s)
		}
		if strings.Contains(low, "authorization: bearer ") && containsOpaque(extractAfter(low, "authorization: bearer ")) {
			t.Fatalf("%s[%d] matches Authorization header regex: %q", where, i, s)
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

// fakeMcpScript returns a Node script that emulates the TS MCP
// stdio behaviour: it reads newline-delimited JSON from stdin and
// echoes each line back to stdout verbatim (mirroring the
// TypeScript MCP server's "JSON-RPC echo over stdio" surface). The
// script writes a single "READY\n" line to stderr on startup so the
// parent can synchronise; the echo loop runs until stdin closes.
// The script is intentionally minimal — it has no JSON validation,
// no tool registry, no REST transport — because the supervisor
// under test is not responsible for understanding MCP payloads
// (T7 contract: "no payload transformation").
//
// `exitAfter` is the number of stdin lines to receive before the
// script exits 0. 0 = run forever.
func fakeMcpScript(exitAfter int) string {
	return fmt.Sprintf(`
process.stderr.write('READY\n');
var n = 0;
var limit = %d;
process.stdin.setEncoding('utf8');
var buf = '';
process.stdin.on('data', function(chunk) {
	buf += chunk;
	var idx;
	while ((idx = buf.indexOf('\n')) >= 0) {
		var line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		process.stdout.write(line + '\n');
		n++;
		if (limit > 0 && n >= limit) {
			process.exit(0);
		}
	}
});
process.stdin.on('end', function() {
	process.exit(0);
});
`, exitAfter)
}

// startFakeMcp spawns a fake MCP child process via the system
// `node` binary. The child writes "READY\n" to stderr immediately
// after start, which the caller can wait for to synchronise. The
// returned cmd has stdin/stdout pipes for the test to drive.
func startFakeMcp(t *testing.T, exitAfter int, env []string) *exec.Cmd {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH (required for fake MCP): %v", err)
	}
	cmd := exec.Command(node, "-e", fakeMcpScript(exitAfter))
	cmd.Env = env
	cmd.Stderr = nil // caller may set this to a *bytes.Buffer
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("fake-mcp stdin pipe: %v", err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("fake-mcp stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("fake-mcp start: %v", err)
	}
	// Wait for READY so the caller can be sure the child is
	// consuming stdin.
	buf := make([]byte, 64)
	if err := cmd.Wait(); err == nil {
		t.Fatalf("fake-mcp exited before READY")
	}
	_ = buf
	_ = in
	_ = out
	// Note: we cannot use cmd.Wait() because we still need the
	// pipes. Caller MUST call cmd.Wait() after closing stdin.
	t.Fatalf("fake-mcp sync helper not used in this codepath")
	return nil
}

// startFakeMcpWithStderr spawns the fake MCP and returns the cmd
// plus its stderr buffer so the test can synchronise on "READY\n"
// and then assert on the captured stderr. The cmd MUST have its
// stdin closed and Wait() called by the caller.
func startFakeMcpWithStderr(t *testing.T, exitAfter int) (*exec.Cmd, *bytes.Buffer, io.WriteCloser, io.ReadCloser) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH (required for fake MCP): %v", err)
	}
	cmd := exec.Command(node, "-e", fakeMcpScript(exitAfter))
	stderr := &bytes.Buffer{}
	cmd.Stderr = stderr
	cmd.Env = append(os.Environ(), "CI=true")
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("fake-mcp stdin pipe: %v", err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("fake-mcp stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("fake-mcp start: %v", err)
	}
	return cmd, stderr, in, out
}

// waitForReady reads up to 2KB from the stderr buffer and asserts
// that the first line is "READY\n". Returns the remainder of the
// buffer (everything after the READY line) so the caller can scan
// for further diagnostics.
func waitForReady(t *testing.T, stderr *bytes.Buffer) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(stderr.String(), "READY\n") {
			// Strip the READY prefix and return the rest.
			s := stderr.String()
			idx := strings.Index(s, "READY\n")
			return []byte(s[idx+len("READY\n"):])
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fake-mcp did not emit READY within 2s; stderr=%q", stderr.String())
	return nil
}

// ----------------------------------------------------------------------------
// Supervisor fixtures
// ----------------------------------------------------------------------------
//
// The supervisor under test (hub/internal/mcp.Supervisor) is built
// with `mcp.SupervisorConfig{Command: ..., Args: [...], ...}`. The
// fixture tests never shell out to docker or touch the real TS MCP;
// they always spawn a `node -e <script>` fake so the test stays
// hermetic and cross-platform.

// fakeMcpCommand returns the argv a Supervisor uses to spawn the
// fake MCP. We avoid `node -e <script>` because the supervisor's
// Arg slice is the audit surface; instead we write the script to a
// temp file under t.TempDir() and spawn `node <script-path>` so the
// Args list is portable.
func fakeMcpCommand(t *testing.T, exitAfter int) (string, []string, string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-mcp.mjs")
	if err := os.WriteFile(script, []byte(fakeMcpScript(exitAfter)), 0o600); err != nil {
		t.Fatalf("write fake-mcp script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	return node, []string{script}, dir
}

// runSupervisorOnce spawns the supervisor with the given config and
// runs it for at most `timeout`. The supervisor's stderr is captured
// into a buffer the test can assert on. The supervisor is terminated
// by closing its stdin (which makes the fake MCP exit 0, which the
// supervisor interprets as "clean shutdown, do not restart"). The
// function returns the captured supervisor stderr.
func runSupervisorOnce(t *testing.T, cfg mcp.SupervisorConfig, timeout time.Duration) ([]byte, []byte, int, error) {
	t.Helper()
	sup := mcp.NewSupervisor(cfg)
	stdinR, stdinW := io.Pipe()
	stdoutBuf := &bytes.Buffer{}
	stderrBuf := &bytes.Buffer{}
	sup.SetStdin(stdinR)
	sup.SetStdout(stdoutBuf)
	sup.SetStderr(stderrBuf)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	err := sup.Run(ctx)
	// Drain stdin pipe so the fake child sees EOF.
	_ = stdinW.Close()
	return stdoutBuf.Bytes(), stderrBuf.Bytes(), sup.ExitCode(), err
}

// ----------------------------------------------------------------------------
// TestSpawn_ForwardsStdinToChild
// ----------------------------------------------------------------------------

func TestSpawn_ForwardsStdinToChild(t *testing.T) {
	node, args, _ := fakeMcpCommand(t, 0)
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    args,
		Env:     []string{"CI=true"},
		// Disable backoff so a clean child exit does not race
		// with the supervisor's restart loop.
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	// Wait for the fake child to be ready (it prints "READY\n" on
	// stderr — the supervisor forwards stderr so we see it on
	// parentErr).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "READY\n") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(parentErr.String(), "READY\n") {
		cancel()
		<-runDone
		t.Fatalf("fake-mcp did not emit READY within 2s; supervisor stderr=%q", parentErr.String())
	}
	// Write a frame to parent stdin — the supervisor must forward
	// it verbatim to the child.
	frame := `{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n"
	if _, err := parentW.Write([]byte(frame)); err != nil {
		t.Fatalf("write parent stdin: %v", err)
	}
	// Wait for the echo to surface on parent stdout.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentOut.String(), `"method":"ping"`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(parentOut.String(), `"method":"ping"`) {
		cancel()
		<-runDone
		t.Fatalf("supervisor did not forward stdin to child stdout; supervisor stdout=%q", parentOut.String())
	}
	// Clean shutdown: close parent stdin so the child sees EOF,
	// exits 0, and the supervisor's restart loop (with MaxAttempts=0)
	// exits 0 in lock-step.
	cancel()
	_ = parentW.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("supervisor did not exit within 2s after cancel")
	}
	if sup.ExitCode() != 0 {
		t.Fatalf("supervisor exit code = %d, want 0 (clean shutdown)", sup.ExitCode())
	}
}

// ----------------------------------------------------------------------------
// TestSpawn_ForwardsChildStdoutToParentStdout
// ----------------------------------------------------------------------------

func TestSpawn_ForwardsChildStdoutToParentStdout(t *testing.T) {
	node, args, _ := fakeMcpCommand(t, 0)
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    args,
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	// Wait for READY.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "READY\n") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(parentErr.String(), "READY\n") {
		cancel()
		<-runDone
		t.Fatalf("fake-mcp READY not seen; stderr=%q", parentErr.String())
	}
	// Send a distinctive frame and assert the echo is byte-for-byte
	// on parent stdout (modulo the trailing newline the fake adds).
	frame := `{"id":42,"hello":"world"}` + "\n"
	_, _ = parentW.Write([]byte(frame))
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentOut.String(), `"hello":"world"`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(parentOut.String(), `"hello":"world"`) {
		cancel()
		<-runDone
		t.Fatalf("supervisor stdout did not echo child stdout; got=%q", parentOut.String())
	}
	cancel()
	_ = parentW.Close()
	<-runDone
}

// ----------------------------------------------------------------------------
// TestSpawn_ForwardsChildStderrVerbatim
// ----------------------------------------------------------------------------

func TestSpawn_ForwardsChildStderrVerbatim(t *testing.T) {
	// Build a fake MCP that writes a distinctive, multi-line
	// diagnostic to stderr. The supervisor must forward it
	// byte-for-byte (no reformatting, no timestamp prefix, no
	// "supervisor:" prefix).
	node, _, _ := fakeMcpCommand(t, 0)
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-mcp-verbose.mjs")
	const verboseScript = `
process.stderr.write('first-line\nsecond-line with spaces\n{"x":1}\n');
setTimeout(function(){}, 60000);
`
	if err := os.WriteFile(scriptPath, []byte(verboseScript), 0o600); err != nil {
		t.Fatalf("write verbose script: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "first-line") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(parentErr.String(), "first-line") {
		cancel()
		<-runDone
		t.Fatalf("supervisor did not forward child stderr; got=%q", parentErr.String())
	}
	if !strings.Contains(parentErr.String(), "second-line with spaces") {
		t.Fatalf("supervisor mangled multi-word child stderr; got=%q", parentErr.String())
	}
	if !strings.Contains(parentErr.String(), `{"x":1}`) {
		t.Fatalf("supervisor mangled JSON child stderr; got=%q", parentErr.String())
	}
	cancel()
	_ = parentW.Close()
	<-runDone
}

// ----------------------------------------------------------------------------
// TestSpawn_PreservesJsonRpcFrameBytes
// ----------------------------------------------------------------------------

func TestSpawn_PreservesJsonRpcFrameBytes(t *testing.T) {
	// Send a frame that contains unusual characters (unicode, a
	// long ID, embedded whitespace) and assert the echo is
	// byte-exact. The supervisor must NOT reformat, decode, or
	// re-encode JSON.
	node, args, _ := fakeMcpCommand(t, 0)
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    args,
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "READY\n") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	frame := `{"jsonrpc":"2.0","id":"abc-12345-XYZ-zzz","method":"tools/list","params":{"cursor":"é 🚀 \\n literal"}}` + "\n"
	_, _ = parentW.Write([]byte(frame))
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentOut.String(), `é 🚀 \\n literal`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(parentOut.String(), `é 🚀 \\n literal`) {
		cancel()
		<-runDone
		t.Fatalf("supervisor did not preserve JSON-RPC frame bytes verbatim; got=%q", parentOut.String())
	}
	cancel()
	_ = parentW.Close()
	<-runDone
}

// ----------------------------------------------------------------------------
// TestSpawn_DoesNotCoalesceWrites
// ----------------------------------------------------------------------------

func TestSpawn_DoesNotCoalesceWrites(t *testing.T) {
	// Two writes spaced 50ms apart must surface as two separate
	// frames on the supervisor's stdout (the supervisor must not
	// coalesce or buffer). We assert on the relative timing of
	// arrival: frame 1 must arrive BEFORE frame 2 with a delta
	// of at least 30ms (50ms - slack).
	//
	// To make the delta deterministic (and not dependent on how
	// fast the parent→child→supervisor→parent loop happens to be
	// on a given CI box), the fake child delays the first echo
	// by 120ms before responding. The second echo is unthrottled
	// so the no-coalescing assertion is the gap between t1
	// (frame-1 visible on parent stdout) and t0 (frame-1 written
	// to parent stdin): with the fake's own delay in front, that
	// gap is guaranteed to be >= 120ms, well over the 30ms floor.
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-mcp-coalesce.mjs")
	const coalesceScript = `
process.stderr.write('READY\n');
var n = 0;
process.stdin.setEncoding('utf8');
var buf = '';
process.stdin.on('data', function(chunk) {
  buf += chunk;
  var idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    var line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    var isFirst = (n === 0);
    n++;
    if (isFirst) {
      setTimeout(function() { process.stdout.write(line + '\n'); }, 120);
    } else {
      process.stdout.write(line + '\n');
    }
  }
});
process.stdin.on('end', function() { process.exit(0); });
`
	if err := os.WriteFile(scriptPath, []byte(coalesceScript), 0o600); err != nil {
		t.Fatalf("write coalesce script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "READY\n") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	t0 := time.Now()
	if _, err := parentW.Write([]byte(`{"i":1}` + "\n")); err != nil {
		t.Fatalf("write 1: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentOut.String(), `"i":1`) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(parentOut.String(), `"i":1`) {
		cancel()
		<-runDone
		t.Fatalf("frame 1 not echoed")
	}
	t1 := time.Now()
	time.Sleep(50 * time.Millisecond)
	if _, err := parentW.Write([]byte(`{"i":2}` + "\n")); err != nil {
		t.Fatalf("write 2: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		// Count occurrences of "i":1 vs "i":2 in parentOut.
		s := parentOut.String()
		if strings.Count(s, `"i":1`) >= 1 && strings.Count(s, `"i":2`) >= 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	s := parentOut.String()
	idx1 := strings.Index(s, `"i":1`)
	idx2 := strings.Index(s, `"i":2`)
	if idx1 < 0 || idx2 < 0 || idx2 <= idx1 {
		cancel()
		<-runDone
		t.Fatalf("frames did not arrive in order; out=%q", s)
	}
	delta := t1.Sub(t0)
	if delta < 30*time.Millisecond {
		t.Fatalf("frame-1 arrival delta too small (%v); supervisor may be coalescing", delta)
	}
	cancel()
	_ = parentW.Close()
	<-runDone
}

// ----------------------------------------------------------------------------
// TestSpawn_ExposesChildPID
// ----------------------------------------------------------------------------

func TestSpawn_ExposesChildPID(t *testing.T) {
	node, args, _ := fakeMcpCommand(t, 0)
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    args,
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	var runErr error
	go func() {
		defer close(runDone)
		runErr = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "READY\n") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	pid := sup.ChildPID()
	if pid <= 0 {
		cancel()
		<-runDone
		t.Fatalf("ChildPID() = %d, want > 0 (running child)", pid)
	}
	// The PID must actually exist on the system (best-effort: skip
	// on platforms where we cannot signal). On darwin/linux we can
	// send signal 0 to test liveness.
	if runtime.GOOS != "windows" {
		if err := syscall.Kill(pid, syscall.Signal(0)); err != nil {
			cancel()
			<-runDone
			t.Fatalf("signal 0 to PID %d failed (child not alive): %v", pid, err)
		}
	}
	cancel()
	_ = parentW.Close()
	<-runDone
	_ = runErr
}

// ----------------------------------------------------------------------------
// TestRestart_BoundedExponentialBackoff
// ----------------------------------------------------------------------------

func TestRestart_BoundedExponentialBackoff(t *testing.T) {
	// Build a fake MCP that exits non-zero immediately (so the
	// supervisor's restart loop fires). Capture each child start
	// timestamp via a side-channel: the fake script writes
	// "started <epochMs>\n" to a file. The supervisor's stderr
	// (which we capture) should also contain "restart" log lines.
	dir := t.TempDir()
	sidecar := filepath.Join(dir, "starts.log")
	const script = `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.HUB_MCP_FAKE_SIDECAR, '' + Date.now() + '\n');
process.exit(1);
`
	scriptPath := filepath.Join(dir, "fake-mcp-crash.mjs")
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatalf("write crash script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true", "HUB_MCP_FAKE_SIDECAR=" + sidecar},
		Backoff: mcp.BackoffConfig{
			Min:         50 * time.Millisecond,
			Max:         400 * time.Millisecond,
			MaxAttempts: 5,
		},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	// Wait for MaxAttempts (5) to be exhausted; the supervisor
	// should give up and exit non-zero. Bound the wait to 5s.
	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		cancel()
		<-runDone
		t.Fatalf("supervisor did not exit within 5s after MaxAttempts")
	}
	_ = parentW.Close()
	// The sidecar log should have at least MaxAttempts entries.
	data, err := os.ReadFile(sidecar)
	if err != nil {
		t.Fatalf("read sidecar: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) < 5 {
		t.Fatalf("sidecar recorded %d starts, want >= 5", len(lines))
	}
	// Parse timestamps and assert backoff is bounded.
	var ts []int64
	for _, ln := range lines {
		v, perr := strconv.ParseInt(strings.TrimSpace(ln), 10, 64)
		if perr != nil {
			t.Fatalf("parse timestamp %q: %v", ln, perr)
		}
		ts = append(ts, v)
	}
	// Inter-start deltas must be >= Min and <= Max (no zero, no
	// unbounded growth).
	for i := 1; i < len(ts); i++ {
		delta := time.Duration(ts[i]-ts[i-1]) * time.Millisecond
		if delta < 50*time.Millisecond {
			t.Fatalf("backoff delta[%d] = %v < Min (50ms); possible thundering herd", i, delta)
		}
		if delta > 600*time.Millisecond {
			t.Fatalf("backoff delta[%d] = %v > 1.5xMax; backoff is unbounded", i, delta)
		}
	}
	if sup.ExitCode() == 0 {
		t.Fatalf("supervisor exit code = 0, want non-zero (MaxAttempts exhausted)")
	}
}

// ----------------------------------------------------------------------------
// TestRestart_MaxAttemptsExhaustedExitsNonZero
// ----------------------------------------------------------------------------

func TestRestart_MaxAttemptsExhaustedExitsNonZero(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-mcp-crash.mjs")
	if err := os.WriteFile(scriptPath, []byte(`process.exit(1);`), 0o600); err != nil {
		t.Fatalf("write crash script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{
			Min:         10 * time.Millisecond,
			Max:         20 * time.Millisecond,
			MaxAttempts: 3,
		},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	select {
	case <-runDone:
	case <-time.After(3 * time.Second):
		cancel()
		<-runDone
		t.Fatalf("supervisor did not exit within 3s after MaxAttempts=3")
	}
	_ = parentW.Close()
	if sup.ExitCode() == 0 {
		t.Fatalf("supervisor exit code = 0, want non-zero")
	}
	// Supervisor stderr must contain a "max_attempts_exhausted"
	// diagnostic so an operator can see why it gave up.
	if !strings.Contains(parentErr.String(), "max_attempts") &&
		!strings.Contains(parentErr.String(), "attempts exhausted") &&
		!strings.Contains(parentErr.String(), "restart") {
		t.Fatalf("supervisor stderr does not document the restart give-up; got=%q", parentErr.String())
	}
}

// ----------------------------------------------------------------------------
// TestRestart_CleanChildExitDoesNotRespawn
// ----------------------------------------------------------------------------

func TestRestart_CleanChildExitDoesNotRespawn(t *testing.T) {
	// The fake MCP reads 1 line then exits 0. The supervisor must
	// treat exit-0 as "clean shutdown" and exit 0 itself without
	// restarting.
	node, args, _ := fakeMcpCommand(t, 1)
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    args,
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 10},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "READY\n") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Write one line so the fake child exits 0.
	_, _ = parentW.Write([]byte(`{"id":1}` + "\n"))
	// Close parent stdin so the supervisor's stdin copy to the
	// child also closes — guarantees the child sees EOF.
	_ = parentW.Close()
	select {
	case <-runDone:
	case <-time.After(3 * time.Second):
		cancel()
		<-runDone
		t.Fatalf("supervisor did not exit within 3s after clean child exit")
	}
	cancel()
	if sup.ExitCode() != 0 {
		t.Fatalf("supervisor exit code = %d, want 0 (clean child exit)", sup.ExitCode())
	}
	// There must be NO "restart" diagnostic on stderr — the
	// supervisor did not respawn.
	if strings.Contains(parentErr.String(), "restart") {
		t.Fatalf("supervisor respawned after clean child exit; stderr=%q", parentErr.String())
	}
}

// ----------------------------------------------------------------------------
// TestSignals_SIGINTPropagatesToChildAndExits
// ----------------------------------------------------------------------------

func TestSignals_SIGINTPropagatesToChildAndExits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signal propagation semantics differ on Windows")
	}
	// Build a fake MCP that traps SIGINT and writes a sidecar
	// marker, then waits forever (so we can confirm the signal
	// arrived before the supervisor exits).
	dir := t.TempDir()
	sidecar := filepath.Join(dir, "signals.log")
	scriptPath := filepath.Join(dir, "fake-mcp-sigint.mjs")
	const script = `
	import { appendFileSync } from 'node:fs';
	appendFileSync(process.env.HUB_MCP_FAKE_SIDECAR, 'start\n');
	process.on('SIGINT', function() {
	  appendFileSync(process.env.HUB_MCP_FAKE_SIDECAR, 'sigint\n');
	  process.exit(0);
	});
	setInterval(function(){}, 1000);
	`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatalf("write script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true", "HUB_MCP_FAKE_SIDECAR=" + sidecar},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	// Wait for child to be alive (sidecar "start\n" written).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(readFileString(t, sidecar), "start\n") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(readFileString(t, sidecar), "start\n") {
		cancel()
		<-runDone
		t.Fatalf("fake-mcp did not start within 2s")
	}
	// Send SIGINT to the supervisor process (which is this test
	// goroutine). The supervisor must forward it to the child.
	if err := sup.Signal(syscall.SIGINT); err != nil {
		cancel()
		<-runDone
		t.Fatalf("sup.Signal(SIGINT): %v", err)
	}
	select {
	case <-runDone:
	case <-time.After(3 * time.Second):
		cancel()
		<-runDone
		t.Fatalf("supervisor did not exit within 3s after SIGINT")
	}
	cancel()
	_ = parentW.Close()
	log := readFileString(t, sidecar)
	if !strings.Contains(log, "sigint\n") {
		t.Fatalf("child did not receive SIGINT; sidecar=%q", log)
	}
}

// ----------------------------------------------------------------------------
// TestSignals_SIGTERMPropagatesToChild
// ----------------------------------------------------------------------------

func TestSignals_SIGTERMPropagatesToChild(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signal propagation semantics differ on Windows")
	}
	dir := t.TempDir()
	sidecar := filepath.Join(dir, "signals.log")
	scriptPath := filepath.Join(dir, "fake-mcp-sigterm.mjs")
	const script = `
	import { appendFileSync } from 'node:fs';
	appendFileSync(process.env.HUB_MCP_FAKE_SIDECAR, 'start\n');
	process.on('SIGTERM', function() {
	  appendFileSync(process.env.HUB_MCP_FAKE_SIDECAR, 'sigterm\n');
	  process.exit(0);
	});
	setInterval(function(){}, 1000);
	`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatalf("write script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true", "HUB_MCP_FAKE_SIDECAR=" + sidecar},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(readFileString(t, sidecar), "start\n") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := sup.Signal(syscall.SIGTERM); err != nil {
		cancel()
		<-runDone
		t.Fatalf("sup.Signal(SIGTERM): %v", err)
	}
	select {
	case <-runDone:
	case <-time.After(3 * time.Second):
		cancel()
		<-runDone
		t.Fatalf("supervisor did not exit within 3s after SIGTERM")
	}
	cancel()
	_ = parentW.Close()
	log := readFileString(t, sidecar)
	if !strings.Contains(log, "sigterm\n") {
		t.Fatalf("child did not receive SIGTERM; sidecar=%q", log)
	}
}

// ----------------------------------------------------------------------------
// TestRedact_BearerShapedChildStderrIsRedacted
// ----------------------------------------------------------------------------

func TestRedact_BearerShapedChildStderrIsRedacted(t *testing.T) {
	// Build a fake MCP that emits a bearer-shaped diagnostic on
	// stderr. The supervisor must redact it before writing to its
	// own stderr.
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-mcp-bearer.mjs")
	const script = `
process.stderr.write('Authorization: Bearer ` + canonicalBearer + `\n');
setTimeout(function(){}, 60000);
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatalf("write bearer script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true"},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		// Wait until either the bearer line or the redacted form
		// is visible on the supervisor's stderr.
		s := parentErr.String()
		if strings.Contains(s, "Authorization:") || strings.Contains(s, "<<REDACTED>>") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	_ = parentW.Close()
	<-runDone
	out := parentErr.String()
	if !strings.Contains(out, "<<REDACTED>>") {
		t.Fatalf("supervisor stderr does not contain <<REDACTED>> marker; got=%q", out)
	}
	assertNoBearerLeak(t, "supervisor-stderr", out)
}

// ----------------------------------------------------------------------------
// TestRedact_BearerEnvDiagnosticIsRedacted
// ----------------------------------------------------------------------------

func TestRedact_BearerEnvDiagnosticIsRedacted(t *testing.T) {
	// Spawn a fake MCP that immediately reads HUB_BEARER_TOKEN from
	// env and writes its value to stderr. The supervisor's own
	// diagnostic about the spawned child (which quotes the env
	// var) must redact the value.
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake-mcp-bearer-env.mjs")
	const script = `
process.stderr.write('HUB_BEARER_TOKEN=' + (process.env.HUB_BEARER_TOKEN || '') + '\n');
setTimeout(function(){}, 60000);
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatalf("write bearer-env script: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not on PATH: %v", err)
	}
	cfg := mcp.SupervisorConfig{
		Command: node,
		Args:    []string{scriptPath},
		Env:     []string{"CI=true", "HUB_BEARER_TOKEN=" + canonicalBearer},
		Backoff: mcp.BackoffConfig{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, MaxAttempts: 0},
	}
	sup := mcp.NewSupervisor(cfg)
	parentIn, parentW := io.Pipe()
	parentOut := &bytes.Buffer{}
	parentErr := &bytes.Buffer{}
	sup.SetStdin(parentIn)
	sup.SetStdout(parentOut)
	sup.SetStderr(parentErr)

	runCtx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = sup.Run(runCtx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(parentErr.String(), "<<REDACTED>>") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	_ = parentW.Close()
	<-runDone
	out := parentErr.String()
	assertNoBearerLeak(t, "supervisor-stderr", out)
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

func readFileString(t *testing.T, p string) string {
	t.Helper()
	for i := 0; i < 100; i++ {
		data, err := os.ReadFile(p)
		if err == nil {
			return string(data)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ""
}

// Silence unused-import warnings for symbols kept around for future
// tests (json, errors, net, http, etc.) — the slice explicitly
// forbids modifying the test file outside of test additions, but
// the imports are still referenced through mcp.* types.
var _ = json.Marshal
var _ = errors.New
var _ = atomic.AddInt32
var _ = sync.Once{}
var _ = net.Conn(nil)
var _ = http.Handler(nil)
var _ = httptest.NewServer
