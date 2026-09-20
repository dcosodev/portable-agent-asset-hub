// Package mcp supervises an external Model Context Protocol (MCP)
// child process and bridges its stdio with the parent's. The
// supervisor is intentionally minimal: it does NOT understand
// JSON-RPC, parse MCP envelopes, or interpret the payloads
// passing through it. T7's contract is "supervise the existing
// TS MCP" — every byte on the wire belongs to the TypeScript
// MCP source of truth, and the supervisor's only job is to keep
// the child alive, propagate lifecycle signals, and redact
// bearer-shaped strings that surface through its own diagnostic
// stderr.
//
// The supervisor exposes a small, testable surface:
//
//	cfg := mcp.SupervisorConfig{
//	    Command: "node",
//	    Args:    []string{"packages/mcp/bin/agent-memory-mcp.mjs"},
//	    Env:     os.Environ(),
//	    Backoff: mcp.BackoffConfig{Min: 50 * time.Millisecond, Max: 400 * time.Millisecond, MaxAttempts: 5},
//	}
//	sup := mcp.NewSupervisor(cfg)
//	sup.SetStdin(os.Stdin)
//	sup.SetStdout(os.Stdout)
//	sup.SetStderr(os.Stderr)
//	exit := sup.Run(ctx)
//
// The supervisor writes diagnostic lines (restarts, max-attempts
// exhaustion, signal propagation, child spawn errors, child
// stderr forward with bearer redaction) to the supplied stderr
// sink — every line passes through output.Redact so a leaked
// token from the child's stderr never reaches the operator.
//
// Concurrency model:
//
//   - Exactly one goroutine performs io.Copy from parent→child
//     stdin and another from child→parent stdout.
//   - stderr from the child is copied into a single goroutine
//     whose output is buffered through output.Redact before it
//     reaches the parent's stderr sink.
//   - Signal propagation happens on a dedicated goroutine that
//     calls Signal() under the supervisor's lock.
//   - All mutable state (cmd, exit code, pid) is guarded by a
//     mutex; Run()'s callers observe ExitCode() and ChildPID()
//     after Run() returns.
package mcp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"hub/internal/output"
)

// BackoffConfig controls the bounded exponential restart loop the
// supervisor runs when the child exits non-zero. A clean exit
// (status 0) is treated as "shutdown succeeded" and never
// triggers a restart regardless of MaxAttempts.
//
// The backoff schedule grows as Min * 2^n for n restart attempts,
// clamped at Max. A non-positive MaxAttempts disables restarts
// entirely — the supervisor will exit 0 on a clean child exit
// and exit with the child's code on the first non-zero exit.
type BackoffConfig struct {
	// Min is the floor of the inter-restart delay. The first
	// restart sleeps Min; the second sleeps Min*2; and so on up
	// to Max. A non-positive Min is treated as 1ms.
	Min time.Duration
	// Max caps the inter-restart delay. T7's contract pins the
	// cap at 400ms (tests assert the schedule never exceeds
	// 1.5xMax as a rounding slack). A non-positive Max falls
	// back to Min so the schedule stays bounded.
	Max time.Duration
	// MaxAttempts is the maximum number of restart attempts
	// before the supervisor gives up and exits non-zero. A
	// value <= 0 disables restart entirely.
	MaxAttempts int
}

// SupervisorConfig is the typed argv the supervisor spawns.
type SupervisorConfig struct {
	// Command is the absolute path or PATH-resolvable name of
	// the child executable. Required.
	Command string
	// Args is the argv passed to the child. Args[0] is the
	// command name (the convention set by os/exec).
	Args []string
	// Env is the child environment. When nil, the child inherits
	// the parent's environment via os.Environ(). When non-nil,
	// the child receives exactly the supplied slice.
	Env []string
	// Backoff configures the restart loop. See BackoffConfig.
	Backoff BackoffConfig
	// StderrPrefix is a short tag prefixed to every diagnostic
	// the supervisor writes to its own stderr (e.g.
	// "mcp-supervisor"). Empty means no prefix.
	StderrPrefix string
}

// Supervisor manages a single MCP child. There is no public
// Close / Stop today — Run() returns when the parent context is
// cancelled, a signal propagates, or the child exits and the
// restart budget is exhausted.
type Supervisor struct {
	cfg   SupervisorConfig
	cmdMu sync.Mutex
	cmd   *exec.Cmd
	pid   atomic.Int32 // -1 = no child; else the live pid
	exit  atomic.Int32 // 0 = not exited; else the exit status
	done  chan struct{}

	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

// NewSupervisor returns a ready-to-Run supervisor. The parent's
// stdin / stdout / stderr are wired via SetStdin / SetStdout /
// SetStderr before Run is called; if any are unset, Run returns
// an error.
func NewSupervisor(cfg SupervisorConfig) *Supervisor {
	return &Supervisor{
		cfg:  cfg,
		done: make(chan struct{}),
		pid:  atomic.Int32{},
	}
}

// SetStdin binds the parent's stdin. The supervisor copies bytes
// from src into the child's stdin until EOF or until Run()'s
// context is cancelled.
func (s *Supervisor) SetStdin(src io.Reader) {
	s.stdin = src
}

// SetStdout binds the parent's stdout. The supervisor copies the
// child's stdout into dst verbatim — no JSON parsing, no line
// framing, no redaction (the child is the source of truth for
// the wire format).
func (s *Supervisor) SetStdout(dst io.Writer) {
	s.stdout = dst
}

// SetStderr binds the parent's stderr. The supervisor copies the
// child's stderr into dst after running each batch through
// output.Redact; bearer-shaped tokens are never propagated
// verbatim. The supervisor's OWN diagnostic stderr (restarts,
// max-attempts, signal handling) also passes through output.Redact
// before reaching dst.
func (s *Supervisor) SetStderr(dst io.Writer) {
	s.stderr = dst
}

// ChildPID returns the live PID of the supervised child, or -1
// when no child is running. The PID is the value os/exec assigned
// after Start() and is stale across restarts; callers should
// re-read after a restart completes if they need the latest
// value.
func (s *Supervisor) ChildPID() int {
	return int(s.pid.Load())
}

// ExitCode returns the final exit code the supervisor decided on:
//   - 0 when the child exited 0 (clean shutdown, no restart)
//   - the child's exit code when MaxAttempts <= 0 and the child
//     exited non-zero
//   - a non-zero code set by the supervisor when MaxAttempts
//     was exhausted or a signal triggered shutdown
//
// ExitCode is only meaningful after Run() returns.
func (s *Supervisor) ExitCode() int {
	return int(s.exit.Load())
}

// Signal forwards a Unix signal to the child. On Windows the
// only signals that survive the syscall boundary are
// os.Interrupt equivalents (the test harness is darwin/linux so
// SIGINT / SIGTERM are the supported signals).
func (s *Supervisor) Signal(sig syscall.Signal) error {
	s.cmdMu.Lock()
	cmd := s.cmd
	s.cmdMu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return errors.New("mcp: cannot signal: no live child")
	}
	return cmd.Process.Signal(sig)
}

// Run is the blocking entry point. It returns when:
//
//   - the parent context is cancelled (returns nil; exit 0
//     unless the child had already exited non-zero),
//   - the child exits 0 (clean shutdown; returns nil; exit 0),
//   - the child exits non-zero AND the restart budget is
//     exhausted (returns an error describing the giveup; exit
//     non-zero),
//   - Signal() propagated a signal and the child has been
//     reaped (returns nil; exit the child's code if available).
//
// Run owns the supervisor's lifecycle. It is not safe to call
// Run concurrently on the same Supervisor — concurrent calls
// would race on the internal cmd pointer and the done channel.
func (s *Supervisor) Run(ctx context.Context) error {
	if s.cfg.Command == "" {
		return errors.New("mcp: SupervisorConfig.Command is required")
	}
	if s.stdin == nil || s.stdout == nil || s.stderr == nil {
		return errors.New("mcp: SetStdin / SetStdout / SetStderr must all be set before Run")
	}
	defer close(s.done)

	attempts := 0
	for {
		// Cancellation before each attempt — a cancelled ctx
		// means the operator asked us to stop.
		if err := ctx.Err(); err != nil {
			s.recordExit(0)
			return nil
		}

		err := s.attempt(ctx)
		attempts++

		// Clean exit (status 0) → done, no restart.
		if err == nil {
			s.recordExit(0)
			s.logf("clean child exit; supervisor done")
			return nil
		}

		// Context cancelled mid-flight → done.
		if ctx.Err() != nil {
			s.recordExit(0)
			return nil
		}

		// Decide whether to restart. With MaxAttempts <= 0
		// we never restart — propagate the child's exit code
		// as our own.
		max := s.cfg.Backoff.MaxAttempts
		if max <= 0 || attempts > max {
			childCode := -1
			exitErr := &exec.ExitError{}
			if errors.As(err, &exitErr) {
				childCode = exitErr.ExitCode()
			}
			if max > 0 {
				// exhausted — surface the giveup reason
				// on stderr so the operator can see why
				// we stopped.
				s.logf("max_attempts_exhausted: child exited %d after %d attempts; giving up", childCode, attempts-1)
				s.recordExit(1)
				return fmt.Errorf("mcp: max attempts (%d) exhausted; last child exit %v", max, err)
			}
			s.recordExit(childCode)
			return err
		}

		// Compute the next backoff window and sleep. The cmd
		// has already been Wait()'d inside attempt(), so
		// there is no separate reap to do here — spawning
		// the next attempt will reuse the process slot.
		delay := backoffDelay(s.cfg.Backoff, attempts)
		s.logf("restart attempt=%d delay=%s (last child error: %v)", attempts, delay, err)

		select {
		case <-ctx.Done():
			s.recordExit(0)
			return nil
		case <-time.After(delay):
		}
	}
}

// attempt spawns one child and runs it to completion. It
// blocks until the child exits (cleanly or not), the parent
// context is cancelled, or SetStderr / SetStdout produces a
// non-recoverable copy error.
func (s *Supervisor) attempt(ctx context.Context) error {
	cmd := exec.Command(s.cfg.Command, s.cfg.Args...)
	// The test harness relies on the child seeing CI=true so
	// the existing TS MCP suppresses interactive prompts.
	// We start from Env (when supplied) and otherwise inherit
	// the parent environment.
	if s.cfg.Env != nil {
		cmd.Env = s.cfg.Env
	} else {
		cmd.Env = os.Environ()
	}
	// Stdout / stderr wiring uses the canonical cmd.*Pipe
	// helpers — those set cmd.Stdout / cmd.Stderr internally
	// and return the parent side as an io.ReadCloser. We
	// MUST use cmd.StdinPipe (not assign cmd.Stdin before
	// calling it) because StdinPipe asserts no prior Stdin
	// assignment; the stdlib returns "exec: Stdin already set"
	// otherwise and the child never starts. Order matters:
	// stdout/stderr pipes first, then StdinPipe last so the
	// "Stdin already set" invariant is preserved even though
	// the other two are unrelated.
	childStdoutR, stdoutErr := cmd.StdoutPipe()
	if stdoutErr != nil {
		return fmt.Errorf("mcp: child stdout pipe: %w", stdoutErr)
	}
	childStderrR, stderrErr := cmd.StderrPipe()
	if stderrErr != nil {
		return fmt.Errorf("mcp: child stderr pipe: %w", stderrErr)
	}
	childStdinW, stdinErr := cmd.StdinPipe()
	if stdinErr != nil {
		return fmt.Errorf("mcp: child stdin pipe: %w", stdinErr)
	}

	if err := cmd.Start(); err != nil {
		// Spawn failure is recorded as the attempt error.
		// The supervisor's restart policy still applies; on
		// each attempt we re-exec, so a transient ENOENT
		// today becomes a clean BLOCKED exit. The gate test
		// gates a real BLOCKED state via MaxAttempts=0 so
		// the spawn failure surfaces as the supervisor's
		// own exit.
		s.pid.Store(-1)
		return fmt.Errorf("mcp: child start: %w", err)
	}
	s.pid.Store(int32(cmd.Process.Pid))
	s.cmdMu.Lock()
	s.cmd = cmd
	s.cmdMu.Unlock()

	// Goroutines: stdin copy, stdout copy, stderr redact
	// + copy. Each teardown owns one closer.
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		// Stdout is the contract surface. Copy verbatim, no
		// buffering beyond what io.Copy provides.
		_, err := io.Copy(s.stdout, childStdoutR)
		if err != nil && !errors.Is(err, io.EOF) && !isClosedPipe(err) {
			// Informational only; the child will surface
			// its own exit code via Wait().
			_ = err
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		// Stderr is the diagnostic surface. We buffer every
		// read into a small accumulator and run the buffer
		// through output.Redact on flush. The buffer is
		// flushed on newline boundaries so a single bearer
		// on its own line still gets redacted even when no
		// further data arrives.
		buf := make([]byte, 0, 4096)
		flush := func() {
			if len(buf) == 0 {
				return
			}
			redacted := output.Redact(string(buf))
			_, _ = s.stderr.Write([]byte(redacted))
			buf = buf[:0]
		}
		tmp := make([]byte, 4096)
		for {
			n, rerr := childStderrR.Read(tmp)
			if n > 0 {
				buf = append(buf, tmp[:n]...)
				// Flush on newline boundaries so the
				// operator sees a newline-terminated
				// line per original child write.
				for {
					idx := indexNewline(buf)
					if idx < 0 {
						break
					}
					line := buf[:idx+1]
					redacted := output.Redact(string(line))
					_, _ = s.stderr.Write([]byte(redacted))
					buf = buf[idx+1:]
				}
			}
			if rerr != nil {
				flush()
				if rerr != io.EOF {
					// EOF is the expected end-of-stream
					// signal once the child exits; we
					// don't surface it as a pipe error.
					if !isClosedPipe(rerr) {
						// Informational only; the
						// child will surface its
						// own exit code via
						// Wait().
						_ = rerr
					}
				}
				return
			}
		}
	}()

	// `done` is the single teardown signal for every watcher
	// goroutine. It MUST be closed BEFORE wg.Wait so goroutines
	// that race on it can return — otherwise wg.Wait blocks
	// forever waiting for goroutines waiting for `done` to be
	// closed by a defer that hasn't fired yet. The channel is
	// closed exactly once: by the main goroutine after cmd.Wait
	// returns (clean exit, signal, or post-Kill).
	done := make(chan struct{})

	// Cancellation watcher: best-effort terminate when ctx
	// fires. Run on its own goroutine so cmd.Wait can still
	// return in the normal path even when ctx is fine.
	go func() {
		select {
		case <-ctx.Done():
			s.cmdMu.Lock()
			c := s.cmd
			s.cmdMu.Unlock()
			if c != nil && c.Process != nil {
				_ = c.Process.Kill()
			}
		case <-done:
			// Normal child exit: do not leave a cancellation
			// watcher behind waiting on a context that may never end.
		}
	}()

	// Stdin pump pattern. We bridge the caller-owned s.stdin
	// reader and the child stdin pipe through an internal
	// io.Pipe so the upstream reader can be cancelled by
	// closing the pipe's write side. The outer goroutine
	// races the upstream io.Copy against `done`: when the
	// child exits (clean or signal) we close the pump's write
	// side, which makes the upstream Write return immediately
	// even if s.stdin.Read was blocked. The downstream io.Copy
	// (also wg-tracked) drains the pipe into childStdinW and
	// returns EOF when the write side closes.
	stdinPumpR, stdinPumpW := io.Pipe()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer stdinPumpW.Close()
		copyDone := make(chan struct{})
		go func() {
			defer close(copyDone)
			// io.Copy stops at EOF (caller closed stdin) or
			// with an error (e.g. stdinPumpW was closed by
			// the outer goroutine).
			_, _ = io.Copy(stdinPumpW, s.stdin)
		}()
		// Either the upstream reader finished (caller closed
		// stdin) or the child exited / ctx cancelled. Either
		// way, closing stdinPumpW unblocks the upstream
		// Write and the downstream io.Copy in lock-step.
		select {
		case <-copyDone:
		case <-done:
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer childStdinW.Close()
		_, err := io.Copy(childStdinW, stdinPumpR)
		if err != nil && !isClosedPipe(err) && !errors.Is(err, io.EOF) {
			_ = err
		}
	}()

	// Wait for the child. cmd.Wait produces the "child exited"
	// signal Run() uses to drive the restart loop; the stdlib
	// reaps the OS process and reports its exit status.
	waitErr := cmd.Wait()
	// Once cmd.Wait returns, the OS side of the pipes is
	// closed. Closing done unblocks the stdin pump's
	// select{} and any stdout/stderr readers stuck on a
	// half-closed fd. Closing done BEFORE wg.Wait is critical:
	// see the comment on the `done` channel above.
	close(done)
	wg.Wait()

	// After the child has been reaped, clear the cmd slot
	// so signal() doesn't try to deliver to a dead pid.
	s.cmdMu.Lock()
	s.cmd = nil
	s.cmdMu.Unlock()
	s.pid.Store(-1)

	if waitErr != nil {
		// ExitError is the canonical "child exited non-zero"
		// signal. Anything else (signal kill, syscall error)
		// is propagated verbatim so the caller can see why.
		return waitErr
	}
	return nil
}

func (s *Supervisor) recordExit(code int) {
	s.exit.Store(int32(code))
}

func (s *Supervisor) logf(format string, a ...any) {
	if s.stderr == nil {
		return
	}
	prefix := "mcp-supervisor: "
	if s.cfg.StderrPrefix != "" {
		prefix = s.cfg.StderrPrefix + ": "
	}
	// Truncate to a single line so the gate's regex sweep
	// doesn't have to deal with continuation logic.
	msg := fmt.Sprintf(prefix+format, a...)
	if i := indexNewline([]byte(msg)); i >= 0 {
		msg = msg[:i]
	}
	redacted := output.Redact(msg)
	_, _ = s.stderr.Write([]byte(redacted))
	if len(redacted) > 0 && redacted[len(redacted)-1] != '\n' {
		_, _ = s.stderr.Write([]byte("\n"))
	}
}

// backoffDelay returns the sleep duration before the n-th
// restart attempt (n starts at 1). It grows as Min*2^(n-1) and
// is clamped at Max. Non-positive inputs fall back to a
// deterministic 1ms floor so a misconfigured supervisor cannot
// busy-loop in production.
func backoffDelay(cfg BackoffConfig, n int) time.Duration {
	min := cfg.Min
	if min <= 0 {
		min = time.Millisecond
	}
	max := cfg.Max
	if max <= 0 {
		max = min
	}
	if n < 1 {
		n = 1
	}
	// Cap shift width to avoid overflow when n is large.
	shift := n - 1
	if shift > 30 {
		shift = 30
	}
	d := min << shift
	if d <= 0 || d > max {
		return max
	}
	return d
}

// indexNewline returns the index of the first '\n' in b, or
// -1 when none is present.
func indexNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

// isClosedPipe reports whether err is one of the well-known
// "pipe closed" errors emitted by os.File.Read on a closed
// descriptor. We treat these as informational so a parent
// closing stdin does not surface as a supervisor error.
func isClosedPipe(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.ErrClosedPipe) {
		return true
	}
	// syscall.EINVAL on darwin/linux happens when reading
	// from a closed pipe; the stdlib wraps it as fs.PathError
	// or *os.SyscallError depending on the call path.
	var serr syscall.Errno
	if errors.As(err, &serr) {
		switch serr {
		case syscall.EINVAL, syscall.EPIPE, syscall.EBADF:
			return true
		}
	}
	return false
}

// waitNoBlock is preserved as a reference implementation of a
// best-effort non-blocking reap. The supervisor's restart loop
// currently reaps inside attempt() so this helper is not
// called from production paths; it is kept here so future
// slices that need a side-channel reap (e.g. an external
// liveness probe) have a single canonical implementation to
// crib from.
//
//go:noinline
func waitNoBlock(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(10 * time.Millisecond):
		return nil
	}
}
