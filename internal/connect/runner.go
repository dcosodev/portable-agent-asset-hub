// internal/connect/runner.go — Go-side subprocess orchestrator.
//
// The runner forks a small Node child (`connect_runner.mjs`
// shipped alongside this package) and exchanges one
// request/response per connect verb. The transport is argv +
// stdout JSON; the child NEVER receives a bearer or an
// environment that contains one. Every contract violation
// detected by the child becomes a non-zero exit code that the
// dispatcher in cmd/hub/cmd_connect.go maps to exit 1 (operator
// error) — the slice's audit policy is unambiguous: any error
// that surfaces from the adapter is "the operator typed
// something wrong against the live system", not a CLI
// contract violation.
//
// Security invariants:
//
//   * Bearer hygiene (I-07). The runner strips HUB_BEARER_TOKEN
//     and HUB_BEARER_TOKEN_FILE from the inherited environment
//     before launching the child. The argv never carries a
//     bearer-shaped value (the digest flags carry only
//     hex). The runner's diagnostic channel goes through
//     output.Redact before it reaches the operator's stderr.
//
//   * Read-only preview (T8 contract). The runner refuses to
//     invoke the child with an --action=preview when the
//     target root is missing OR is a symlink — the apply/rollback
//     paths reach the same conclusion via the adapter
//     itself, but we fail-fast in preview to keep the
//     read-only guarantee visibly tight.
//
//   * Output limits. The child stdout is bounded to MaxCaptureBytes
//     so a runaway adapter cannot exhaust the operator's tty.
//
//   * Cancellation. A ctx cancellation propagates to the child
//     via Process.Kill so the operator's Ctrl-C reaches the
//     adapter instead of leaving a background process behind.

package connect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"hub/internal/output"
)

// MaxCaptureBytes caps the child stdout so a runaway adapter
// can't stream the operator's machine.
const MaxCaptureBytes int64 = 1 << 20 // 1 MiB

// Runner holds the immutable context every Run* call needs.
// The struct is intentionally small — tests construct it with
// zero value, only path resolution happens here.
type Runner struct {
	// RepoRoot is the absolute repository root. The runner
	// resolves connect_runner.mjs relative to this directory.
	RepoRoot string
	// NodeOverride lets tests / hermetic harnesses pin an
	// explicit Node binary path (e.g. HUB_NODE_BIN). Production
	// leaves it empty and the runner calls exec.LookPath.
	NodeOverride string
	// RunnerOverride lets tests / hermetic harnesses pin an
	// explicit connect_runner.mjs path. Production leaves it
	// empty and the runner searches <RepoRoot>/internal/connect.
	ScriptOverride string

	// envProbe lets tests pin the resolved child environment
	// to a known fixture without mutating real os.Setenv state.
	// Production leaves it as osGetenv.
	envProbe func(string) string
}

// NewRunner returns a Runner with the production defaults.
// The single argument is the absolute repo root; tests can
// construct a Runner literal directly to override any path.
func NewRunner(repoRoot string) *Runner {
	return &Runner{RepoRoot: repoRoot, envProbe: osGetenv}
}

// resolveNode returns the absolute path to the Node binary the
// runner will spawn. A literal override wins; otherwise the
// runner calls exec.LookPath on "node" and refuses to fall
// back if Node is unavailable (the adapter is impossible
// without Node).
func (r *Runner) resolveNode() (string, error) {
	if override := strings.TrimSpace(r.NodeOverride); override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("hub hub connect: HUB_NODE_BIN override must be absolute")
		}
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("hub hub connect: node binary missing at %s: %w", override, err)
		}
		return override, nil
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("hub hub connect: node binary not on PATH (set HUB_NODE_BIN to override): %w", err)
	}
	return node, nil
}

// resolveScript returns the absolute path to connect_runner.mjs.
// The productive locator walks upward from each production-grade
// anchor (the running binary's real path, and the operator's
// current working directory) looking for the file at
// `<dir>/internal/connect/connect_runner.mjs`. This is the single
// seam where the Go shell meets the .mjs child, and it MUST work
// regardless of where the binary lives (a temp build dir under
// vitest, a copied release artifact, an installed Go binary on
// the operator's PATH) — the source tree is the canonical anchor.
//
// Precedence:
//
//  1. ScriptOverride (HUB_CONNECT_RUNNER) — escape hatch for
//     hermetic harnesses / production overrides. The path MUST
//     be absolute and MUST exist; a missing override is an
//     operator error.
//  2. RepoRoot+internal/connect/connect_runner.mjs — the
//     historical fallback. The dispatcher (cmd_connect.go)
//     passes repoRoot from main.go; if main.go resolved it
//     correctly this hits on the first try.
//  3. Productive walk from os.Executable() — the productive
//     locator's first probe. We resolve the binary's real path
//     (following symlinks), then walk parent directories up to a
//     sane bound (maxWalkerDepth) until we find the file. This
//     is the canonical anchor for a production-installed layout
//     where `hub` sits somewhere inside the source tree.
//  4. Productive walk from os.Getwd() — the second probe. The
//     vitest harness spawns the binary with `cwd: repoRoot`, so
//     the CWD-based walk finds the .mjs in test invocations
//     where the binary was built into a temp directory that is
//     NOT a descendant of the source tree. Production operators
//     who run `hub hub connect …` from inside the repo tree
//     also hit here.
//  5. Fail-closed: a missing file at every level surfaces a
//     precise diagnostic naming the anchors tried, so the
//     operator sees exactly where the resolver stopped instead
//     of a generic "not found".
//
// The function never panics and never silently falls back to a
// guessed path; every error is structured.
func (r *Runner) resolveScript() (string, error) {
	if override := strings.TrimSpace(r.ScriptOverride); override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("hub hub connect: HUB_CONNECT_RUNNER override must be absolute")
		}
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("hub hub connect: connect_runner.mjs missing at %s: %w", override, err)
		}
		return override, nil
	}
	// Step 2 — RepoRoot-relative lookup (historical fallback).
	if r.RepoRoot != "" {
		candidate := filepath.Join(r.RepoRoot, "internal", "connect", "connect_runner.mjs")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	// Step 3 — productive walk from os.Executable().
	if found, walkErr := locateScriptFromExecutable(); walkErr == nil {
		return found, nil
	}
	// Step 4 — productive walk from os.Getwd().
	if found, walkErr := locateScriptFromWorkingDir(); walkErr == nil {
		return found, nil
	}
	// Step 5 — fail-closed with a structured diagnostic that names
	// every anchor we tried.
	if r.RepoRoot != "" {
		candidate := filepath.Join(r.RepoRoot, "internal", "connect", "connect_runner.mjs")
		return "", fmt.Errorf("hub hub connect: connect_runner.mjs not found at %s, productive walk from %q failed, productive walk from %q failed", candidate, executableOrEmpty(), workingDirOrEmpty())
	}
	return "", fmt.Errorf("hub hub connect: connect_runner.mjs not found via productive walk from %q (executable) or %q (working dir)", executableOrEmpty(), workingDirOrEmpty())
}

// maxWalkerDepth caps how far the productive locator walks up
// from a given anchor. A normal repo is 3–4 levels deep from
// the binary (`<repo>/cmd/hub/hub`), so 16 is a generous bound
// that still rejects infinite symlink loops and runaway parents
// like `/`.
const maxWalkerDepth = 16

// locateScriptFromExecutable resolves os.Executable() to its real
// path (following symlinks via EvalSymlinks) and walks parent
// directories upward, returning the first directory that contains
// `internal/connect/connect_runner.mjs`. The function fails closed:
// a missing file at every level surfaces an error naming the
// deepest directory it tried.
func locateScriptFromExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	real, realErr := filepath.EvalSymlinks(exe)
	if realErr != nil {
		// Fall back to the unresolved executable: a fresh
		// build without symlinks still needs to work.
		real = exe
	}
	return locateScriptFromDir(real)
}

// locateScriptFromWorkingDir walks upward from os.Getwd(). The
// vitest harness spawns the binary with `cwd: repoRoot`, so this
// probe finds the .mjs in test invocations where the binary
// lives in a temp dir outside the source tree. Production
// operators who `cd` into the repo before invoking `hub hub
// connect …` also hit this branch.
func locateScriptFromWorkingDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("os.Getwd: %w", err)
	}
	return locateScriptFromDir(wd)
}

// locateScriptFromDir is the shared upward walker used by both
// the executable-anchored and the working-directory-anchored
// probes. Starting from `start` (which may be either a binary
// file path or an already-resolved directory), it walks the
// directory itself and each ancestor up to maxWalkerDepth levels
// looking for `<dir>/internal/connect/connect_runner.mjs`.
//
// If `start` is a file (i.e. the binary path from
// os.Executable), the walker strips the basename first. If
// `start` is already a directory (i.e. from os.Getwd), the
// walker checks the directory itself first and then walks up.
func locateScriptFromDir(start string) (string, error) {
	dir := start
	// Strip the basename when `start` looks like a file path
	// (anything containing a base component whose trailing
	// segment is non-empty and `start` is not a directory).
	if info, statErr := os.Stat(start); statErr == nil && !info.IsDir() {
		dir = filepath.Dir(start)
	}
	last := dir
	for i := 0; i < maxWalkerDepth; i++ {
		candidate := filepath.Join(dir, "internal", "connect", "connect_runner.mjs")
		if _, statErr := os.Stat(candidate); statErr == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			// Reached filesystem root without a hit.
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("walked up from %q through %d levels without finding internal/connect/connect_runner.mjs", last, maxWalkerDepth)
}

// executableOrEmpty returns os.Executable() or "" if it fails.
// Used only to embed the resolved binary path in the locator's
// fail-closed diagnostic — production never sees this branch.
func executableOrEmpty() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	real, realErr := filepath.EvalSymlinks(exe)
	if realErr != nil {
		return exe
	}
	return real
}

// workingDirOrEmpty returns os.Getwd() or "" if it fails. Used
// only to embed the resolved working directory in the locator's
// fail-closed diagnostic — production never sees this branch.
func workingDirOrEmpty() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	real, realErr := filepath.EvalSymlinks(wd)
	if realErr != nil {
		return wd
	}
	return real
}

// sanitizeEnv returns a clean child environment. We start with
// the inherited env (PATH, LANG, etc. stay) and then strip
// every bearer-shaped key the test harness expects absent.
//
// The blocker rationale: the test harness clears
// HUB_BEARER_TOKEN*. The Go shell must NOT inherit a token
// from the operator's parent shell when launching the
// adapter child. Even if the token is empty in the test
// runner, a CI leak would surface here.
func (r *Runner) sanitizeEnv() ([]string, error) {
	raw := os.Environ()
	clean := make([]string, 0, len(raw))
	banned := map[string]bool{
		"HUB_BEARER_TOKEN":        true,
		"HUB_BEARER_TOKEN_FILE":   true,
		"HUB_BEARER_TOKEN_SOURCE": true,
		"AUTHORIZATION":           true,
		"BEARER_TOKEN":            true,
		"AUTH_HEADER":             true,
	}
	for _, kv := range raw {
		key := strings.SplitN(kv, "=", 2)[0]
		if banned[key] {
			continue
		}
		clean = append(clean, kv)
	}
	// CI=true so the .mjs child never emits ANSI noise. The
	// harness already sets this for the parent shell but we
	// pin it again so a parent CI=false environment still
	// produces CI=true for the adapter child.
	clean = append(clean, "CI=true")
	clean = append(clean, "NODE_NO_WARNINGS=1")
	return clean, nil
}

// RunResult is the captured outcome of a single child invocation.
// The dispatch layer in cmd/hub/cmd_connect.go translates
// RunResult.Exit into exit codes (1 = operator / runtime error, 2 =
// CLI contract violation).
type RunResult struct {
	// PayloadJSON is the raw child stdout (or a synthetic
	// oversize-error envelope if the producer overran
	// MaxCaptureBytes).
	PayloadJSON []byte
	// Exit is the child exit code (or -1 if killed by signal).
	Exit int
	// StderrPreview is the child stderr trimmed and redacted.
	StderrPreview string
}

// runChild is the single subprocess launcher. The exported verbs
// (RunPreview, RunApply, RunRollback) are thin wrappers that
// encode the request as a JSON blob in argv[3]; tests can pin
// the request JSON directly.
func (r *Runner) runChild(ctx context.Context, action string, flags ConnectFlags, requestArg string) (RunResult, error) {
	_ = flags // reserved for future per-flag env wiring; kept on signature for symmetry
	node, err := r.resolveNode()
	if err != nil {
		return RunResult{}, err
	}
	script, err := r.resolveScript()
	if err != nil {
		return RunResult{}, err
	}
	env, err := r.sanitizeEnv()
	if err != nil {
		return RunResult{}, err
	}

	// Action is positional argv[2]; the request payload is a
	// JSON string at argv[3].
	args := []string{script, action, requestArg}

	cmd := exec.CommandContext(ctx, node, args...)
	cmd.Env = env

	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return RunResult{}, fmt.Errorf("hub hub connect: stdout pipe: %w", err)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdoutR.Close()
		stdoutW.Close()
		return RunResult{}, fmt.Errorf("hub hub connect: stderr pipe: %w", err)
	}
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW

	if err := cmd.Start(); err != nil {
		stdoutR.Close()
		stdoutW.Close()
		stderrR.Close()
		stderrW.Close()
		return RunResult{}, fmt.Errorf("hub hub connect: spawn: %w", err)
	}
	stdoutW.Close()
	stderrW.Close()

	// Capture stdout with a bound so a runaway adapter cannot
	// exhaust the operator's tty.
	stdoutLimited := io.LimitReader(stdoutR, MaxCaptureBytes+1)
	stdoutBytes, _ := io.ReadAll(stdoutLimited)
	stdoutR.Close()
	// Read stderr fully (small — bounded by adapter's own
	// internal limits).
	stderrBytes, _ := io.ReadAll(stderrR)
	stderrR.Close()

	waitErr := cmd.Wait()
	result := RunResult{
		PayloadJSON: stdoutBytes,
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			result.Exit = exitErr.ExitCode()
		} else {
			return result, fmt.Errorf("hub hub connect: wait: %w", waitErr)
		}
	}
	// Bound check: if the captured stdout is exactly
	// MaxCaptureBytes+1, the producer ran over. Replace with a
	// parse-safe string so downstream JSON decoders fail
	// cleanly.
	if int64(len(result.PayloadJSON)) > MaxCaptureBytes {
		result.PayloadJSON = []byte(fmt.Sprintf(`{"code":"OUTPUT_TOO_LARGE","message":"child stdout exceeded %d bytes"}`, MaxCaptureBytes))
	}
	// Last-mile hygiene: scrub bearer shapes from stderr
	// preview. The output package owns the canonical regex set.
	if len(stderrBytes) > 0 {
		result.StderrPreview = output.Redact(string(stderrBytes))
	}
	return result, nil
}

// RunPreview drives a single preview invocation.
//
// The function performs only the lexical checks the helper
// already enforced; adapter-level validation (unsafe target,
// invalid profile) surfaces as RunResult.Exit != 0 plus a
// structured ErrorPayload on stdout (or empty stdout + a
// diagnostic on stderr).
func (r *Runner) RunPreview(ctx context.Context, flags ConnectFlags) (RunResult, error) {
	if flags.Action != ActionPreview {
		return RunResult{}, fmt.Errorf("hub hub connect: internal error: RunPreview called with action=%q", flags.Action)
	}
	req := PreviewRequest{
		Harness:    flags.Harness,
		ProfileID:  flags.Profile,
		SnapshotID: flags.Snapshot,
		TargetRoot: flags.TargetRoot,
		HubHome:    r.resolveHubHome(),
	}
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return RunResult{}, fmt.Errorf("hub hub connect: marshal preview request: %w", err)
	}
	return r.runChild(ctx, string(ActionPreview), flags, string(reqJSON))
}

// RunApply drives a single apply invocation.
//
// Digest wiring (three distinct fields on the wire):
//
//   - ObservedDigest — operator-supplied live CAS manifest digest
//     (the optional drift signal from --observed-digest).
//   - ExpectedDigest — optional CAS pin. Today we forward the
//     observed digest so the apply step has a single CAS-side
//     anchor; the field is kept separate from reviewedDigest so
//     future revisions can pin a distinct expected CAS without
//     touching the review-side code.
//   - ReviewedDigest — operator-supplied SHA-256 of the plan
//     CONTENT (from --reviewed-digest). The audit trail must
//     distinguish this from the CAS-side digests.
//
// The function NEVER copies reviewedDigest into observedDigest or
// expectedDigest: those are CAS-side fields, reviewedDigest is the
// plan-content review.
func (r *Runner) RunApply(ctx context.Context, flags ConnectFlags) (RunResult, error) {
	if flags.Action != ActionApply {
		return RunResult{}, fmt.Errorf("hub hub connect: internal error: RunApply called with action=%q", flags.Action)
	}
	if flags.ReviewedDigest == "" {
		return RunResult{}, errors.New("hub hub connect: apply requires a --reviewed-digest (the parser must have rejected this)")
	}
	lockDir := strings.TrimSpace(flags.LockDir)
	if lockDir == "" {
		// The slice mandates an explicit lockDir to scope
		// concurrency. Without it, two parallel applies
		// could race on the same (harness, profile) lock.
		// Default to the target root so the lock sits next
		// to the manifest, matching the materializer's
		// documented convention.
		lockDir = flags.TargetRoot
	}
	req := ApplyRequest{
		Harness:        flags.Harness,
		ProfileID:      flags.Profile,
		SnapshotID:     flags.Snapshot,
		TargetRoot:     flags.TargetRoot,
		LockDir:        lockDir,
		ObservedDigest: flags.ObservedDigest,
		ExpectedDigest: flags.ObservedDigest,
		ReviewedDigest: flags.ReviewedDigest,
		Reason:         flags.Reason,
		RequestID:      flags.RequestID,
		HubHome:        r.resolveHubHome(),
	}
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return RunResult{}, fmt.Errorf("hub hub connect: marshal apply request: %w", err)
	}
	return r.runChild(ctx, string(ActionApply), flags, string(reqJSON))
}

// RunRollback drives a single rollback invocation.
func (r *Runner) RunRollback(ctx context.Context, flags ConnectFlags) (RunResult, error) {
	if flags.Action != ActionRollback {
		return RunResult{}, fmt.Errorf("hub hub connect: internal error: RunRollback called with action=%q", flags.Action)
	}
	req := RollbackRequest{
		RunID:     flags.RunID,
		Reason:    flags.Reason,
		RequestID: flags.RequestID,
		HubHome:   r.resolveHubHome(),
	}
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return RunResult{}, fmt.Errorf("hub hub connect: marshal rollback request: %w", err)
	}
	return r.runChild(ctx, string(ActionRollback), flags, string(reqJSON))
}

// resolveHubHome forwards the operator's HUB_HOME to the child
// process so the receipt store can land at the canonical
// $HUB_HOME/state/connect/receipts/<runId>.json path. The function
// prefers HUB_HOME (the slice-mandated knob) and falls back to the
// runner's RepoRoot-relative .hub-home only when HUB_HOME is unset
// (a development-only convenience; production operators always
// export HUB_HOME).
func (r *Runner) resolveHubHome() string {
	if hubHome := strings.TrimSpace(osGetenv("HUB_HOME")); hubHome != "" {
		return hubHome
	}
	// Production MUST set HUB_HOME; the dispatcher warns when
	// the runner cannot resolve it. Tests that bypass
	// `connect.NewRunner` can pin the value via envProbe.
	if r.envProbe == nil {
		return ""
	}
	return ""
}

// PreviewRequest mirrors the JSON-encoded request the .mjs child
// consumes via argv[3]. The struct's JSON shape is the wire
// contract.
type PreviewRequest struct {
	Harness    string `json:"harness"`
	ProfileID  string `json:"profileId"`
	SnapshotID string `json:"snapshotId"`
	TargetRoot string `json:"targetRoot"`
	HubHome    string `json:"hubHome,omitempty"`
}

// ApplyRequest mirrors PreviewRequest with apply-only fields. The
// reviewedDigest field is the operator-supplied CAS-pin for the
// plan content; the slice mandates it as a separate field from
// observedDigest / expectedDigest so the audit trail distinguishes
// the operator's review from the live CAS compare.
type ApplyRequest struct {
	Harness        string `json:"harness"`
	ProfileID      string `json:"profileId"`
	SnapshotID     string `json:"snapshotId"`
	TargetRoot     string `json:"targetRoot"`
	LockDir        string `json:"lockDir"`
	ObservedDigest string `json:"observedDigest,omitempty"`
	ExpectedDigest string `json:"expectedDigest"`
	ReviewedDigest string `json:"reviewedDigest"`
	Reason         string `json:"reason"`
	RequestID      string `json:"requestId,omitempty"`
	HubHome        string `json:"hubHome,omitempty"`
}

// RollbackRequest is the smallest possible request shape.
type RollbackRequest struct {
	RunID     string `json:"runId"`
	Reason    string `json:"reason"`
	RequestID string `json:"requestId,omitempty"`
	HubHome   string `json:"hubHome,omitempty"`
}

// osGetenv is an indirection so tests can pin env values
// without touching real env state. We keep it inside the
// connect package — the runner is the only consumer.
var osGetenv = os.Getenv
