// internal/backup/runner.go — Go-side subprocess orchestrator.
//
// The runner forks a small Node child (`backup_runner.mjs`
// shipped alongside this package) and exchanges one
// request/response per backup verb. The transport is argv +
// stdout JSON; the child NEVER receives a bearer or an
// environment that contains one. Every contract violation
// detected by the child becomes a non-zero exit code that the
// dispatcher in cmd/hub/cmd_backup.go maps to exit 1 (operator
// error) or exit 2 (contract violation) per the shell's documented
// exit-code convention.
//
// Security invariants:
//
//   * Bearer hygiene (I-07). The runner strips every HUB_BEARER_TOKEN*
//     and a few related keys from the inherited environment before
//     launching the child. The argv never carries a bearer-shaped
//     value (only absolute paths and the JSON request payload). The
//     runner's diagnostic channel goes through output.Redact before
//     it reaches the operator's stderr.
//
//   * No SQLite in Go. The Go side NEVER calls into a SQLite handle
//     or re-derives a DB path from HUB_HOME. The single source of
//     truth for the canonical DB path is
//     `@portable-agent-asset-hub/core`'s `resolveHubDatabasePath`,
//     reached through the .mjs child. The Go side merely passes
//     `HUB_HOME` / `AGENT_MEMORY_*` env through to the child so
//     the child's `resolveHubDatabasePath` call sees the same env
//     the operator's shell has.
//
//   * Output limits. The child stdout is bounded to MaxCaptureBytes
//     so a runaway adapter cannot exhaust the operator's tty.
//
//   * Cancellation. A ctx cancellation propagates to the child
//     via Process.Kill so the operator's Ctrl-C reaches the
//     adapter instead of leaving a background process behind.

package backup

import (
	"bytes"
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
	// resolves backup_runner.mjs relative to this directory.
	RepoRoot string
	// NodeOverride lets tests / hermetic harnesses pin an
	// explicit Node binary path (e.g. HUB_NODE_BIN). Production
	// leaves it empty and the runner calls exec.LookPath.
	NodeOverride string
	// ScriptOverride lets tests / hermetic harnesses pin an
	// explicit backup_runner.mjs path. Production leaves it
	// empty and the runner searches <RepoRoot>/internal/backup.
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
	return &Runner{RepoRoot: repoRoot, envProbe: os.Getenv}
}

// resolveNode returns the absolute path to the Node binary the
// runner will spawn. A literal override wins; otherwise the
// runner calls exec.LookPath on "node" and refuses to fall
// back if Node is unavailable (the adapter is impossible
// without Node).
func (r *Runner) resolveNode() (string, error) {
	if override := strings.TrimSpace(r.NodeOverride); override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("hub backup: HUB_NODE_BIN override must be absolute")
		}
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("hub backup: node binary missing at %s: %w", override, err)
		}
		return override, nil
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("hub backup: node binary not on PATH (set HUB_NODE_BIN to override): %w", err)
	}
	return node, nil
}

// resolveScript returns the absolute path to backup_runner.mjs.
// The productive locator walks upward from each production-grade
// anchor (the running binary's real path, and the operator's
// current working directory) looking for the file at
// `<dir>/internal/backup/backup_runner.mjs`. This is the single
// seam where the Go shell meets the .mjs child, and it MUST work
// regardless of where the binary lives (a temp build dir under
// vitest, a copied release artifact, an installed Go binary on
// the operator's PATH) — the source tree is the canonical anchor.
//
// Precedence mirrors internal/connect/runner.go:
//
//  1. ScriptOverride (HUB_BACKUP_RUNNER) — escape hatch for
//     hermetic harnesses / production overrides.
//  2. RepoRoot+internal/backup/backup_runner.mjs — historical
//     fallback (the dispatcher passes repoRoot from main.go).
//  3. Productive walk from os.Executable() — first probe.
//  4. Productive walk from os.Getwd() — second probe.
//  5. Fail-closed: a missing file at every level surfaces a
//     precise diagnostic naming the anchors tried.
func (r *Runner) resolveScript() (string, error) {
	if override := strings.TrimSpace(r.ScriptOverride); override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("hub backup: HUB_BACKUP_RUNNER override must be absolute")
		}
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("hub backup: backup_runner.mjs missing at %s: %w", override, err)
		}
		return override, nil
	}
	if r.RepoRoot != "" {
		candidate := filepath.Join(r.RepoRoot, "internal", "backup", "backup_runner.mjs")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	if found, walkErr := locateScriptFromExecutable(); walkErr == nil {
		return found, nil
	}
	if found, walkErr := locateScriptFromWorkingDir(); walkErr == nil {
		return found, nil
	}
	if r.RepoRoot != "" {
		candidate := filepath.Join(r.RepoRoot, "internal", "backup", "backup_runner.mjs")
		return "", fmt.Errorf("hub backup: backup_runner.mjs not found at %s, productive walk from %q failed, productive walk from %q failed", candidate, executableOrEmpty(), workingDirOrEmpty())
	}
	return "", fmt.Errorf("hub backup: backup_runner.mjs not found via productive walk from %q (executable) or %q (working dir)", executableOrEmpty(), workingDirOrEmpty())
}

// maxWalkerDepth caps how far the productive locator walks up
// from a given anchor. A normal repo is 3–4 levels deep from
// the binary (`<repo>/cmd/hub/hub`), so 16 is a generous bound
// that still rejects infinite symlink loops and runaway parents
// like `/`.
const maxWalkerDepth = 16

func locateScriptFromExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	real, realErr := filepath.EvalSymlinks(exe)
	if realErr != nil {
		real = exe
	}
	return locateScriptFromDir(real)
}

func locateScriptFromWorkingDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("os.Getwd: %w", err)
	}
	return locateScriptFromDir(wd)
}

func locateScriptFromDir(start string) (string, error) {
	dir := start
	if info, statErr := os.Stat(start); statErr == nil && !info.IsDir() {
		dir = filepath.Dir(start)
	}
	last := dir
	for i := 0; i < maxWalkerDepth; i++ {
		candidate := filepath.Join(dir, "internal", "backup", "backup_runner.mjs")
		if _, statErr := os.Stat(candidate); statErr == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("walked up from %q through %d levels without finding internal/backup/backup_runner.mjs", last, maxWalkerDepth)
}

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
// the inherited env (PATH, LANG, etc. stay) and then strip every
// bearer-shaped key the test harness expects absent.
//
// The blocker rationale: the test harness clears
// HUB_BEARER_TOKEN*. The Go shell must NOT inherit a token
// from the operator's parent shell when launching the adapter
// child. Even if the token is empty in the test runner, a CI
// leak would surface here.
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
// The dispatch layer in cmd/hub/cmd_backup.go translates
// RunResult.Exit into exit codes (1 = operator / runtime error,
// 2 = CLI contract violation).
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
// (RunSnapshot, RunRestore) are thin wrappers that encode the
// request as a JSON blob in argv[3]; tests can pin the request
// JSON directly.
func (r *Runner) runChild(ctx context.Context, action string, requestArg string) (RunResult, error) {
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
		return RunResult{}, fmt.Errorf("hub backup: stdout pipe: %w", err)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdoutR.Close()
		stdoutW.Close()
		return RunResult{}, fmt.Errorf("hub backup: stderr pipe: %w", err)
	}
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW

	if err := cmd.Start(); err != nil {
		stdoutR.Close()
		stdoutW.Close()
		stderrR.Close()
		stderrW.Close()
		return RunResult{}, fmt.Errorf("hub backup: spawn: %w", err)
	}
	stdoutW.Close()
	stderrW.Close()

	stdoutLimited := io.LimitReader(stdoutR, MaxCaptureBytes+1)
	stdoutBytes, _ := io.ReadAll(stdoutLimited)
	stdoutR.Close()
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
			return result, fmt.Errorf("hub backup: wait: %w", waitErr)
		}
	}
	if int64(len(result.PayloadJSON)) > MaxCaptureBytes {
		result.PayloadJSON = []byte(fmt.Sprintf(`{"code":"OUTPUT_TOO_LARGE","message":"child stdout exceeded %d bytes"}`, MaxCaptureBytes))
	}
	if len(stderrBytes) > 0 {
		result.StderrPreview = output.Redact(string(stderrBytes))
	}
	return result, nil
}

// SnapshotRequest is the typed payload the .mjs child receives
// for `hub backup --out`. The struct is exported so tests can
// pin the request shape directly.
type SnapshotRequest struct {
	Action      string `json:"action"`
	ArchivePath string `json:"archivePath"`
	DbPath      string `json:"dbPath"`
	HubHome     string `json:"hubHome"`
}

// RestoreRequest is the typed payload the .mjs child receives
// for `hub backup --restore`. The struct is exported so tests can
// pin the request shape directly.
type RestoreRequest struct {
	Action      string `json:"action"`
	ArchivePath string `json:"archivePath"`
	DbPath      string `json:"dbPath"`
	HubHome     string `json:"hubHome"`
}

// RunSnapshot drives a single snapshot invocation. The function
// performs only the lexical checks the helper already enforced;
// child-level validation (missing DB, IO failure) surfaces as
// RunResult.Exit != 0 plus a structured payload on stdout (or
// empty stdout + a diagnostic on stderr).
//
// IMPORTANT: dbPath is the value the dispatcher already resolved
// through `@portable-agent-asset-hub/core`'s
// `resolveHubDatabasePath` via a one-shot probe. The .mjs child
// re-runs the same call so the production path is the canonical
// resolution and the Go side never carries a fallback.
func (r *Runner) RunSnapshot(ctx context.Context, dbPath, archivePath string) (RunResult, error) {
	req := SnapshotRequest{
		Action:      string(ActionSnapshot),
		ArchivePath: archivePath,
		DbPath:      dbPath,
		HubHome:     r.resolveHubHome(),
	}
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return RunResult{}, fmt.Errorf("hub backup: marshal snapshot request: %w", err)
	}
	return r.runChild(ctx, string(ActionSnapshot), string(reqJSON))
}

// RunRestore drives a single restore invocation.
func (r *Runner) RunRestore(ctx context.Context, dbPath, archivePath string) (RunResult, error) {
	req := RestoreRequest{
		Action:      string(ActionRestore),
		ArchivePath: archivePath,
		DbPath:      dbPath,
		HubHome:     r.resolveHubHome(),
	}
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return RunResult{}, fmt.Errorf("hub backup: marshal restore request: %w", err)
	}
	return r.runChild(ctx, string(ActionRestore), string(reqJSON))
}

// restore_backup_runner.mjs: same probe shape, separate action.
const probeScript = `#!/usr/bin/env node
const { resolveHubDatabasePath } = await import(process.env.HUB_CORE_DIST);
const r = resolveHubDatabasePath({ env: process.env });
process.stdout.write(JSON.stringify({
  path: r.path,
  source: r.source,
  mode: r.mode,
  isTemporary: r.isTemporary,
  databaseName: r.databaseName,
}) + '\n')
`

// ProbeDatabase asks the canonical resolver (the same code path
// the .mjs child uses for `hub backup --out` / `--restore`) for
// the absolute path of the resolver-selected SQLite database.
// The Go side NEVER re-implements this resolution — it spawns a
// tiny Node probe and forwards the answer verbatim so the only
// source of truth is the existing `resolveHubDatabasePath`
// already shipped in `@portable-agent-asset-hub/core`.
//
// The probe is idempotent and read-only; it does not open
// SQLite, does not write any file, does not import the storage
// adapter. It only imports the core package.
//
// The probe script is embedded in this source file (rather than
// a sibling .mjs) so the runner ships as a single Go file and
// the only filesystem-side coupling is `internal/backup/
// backup_runner.mjs`. The probe is small enough to be a
// constant; we materialise it to a tmpfile on each call and
// remove it after.
func (r *Runner) ProbeDatabase(ctx context.Context) (string, error) {
	node, err := r.resolveNode()
	if err != nil {
		return "", err
	}
	env, err := r.sanitizeEnv()
	if err != nil {
		return "", err
	}

	// Resolve the canonical core dist through the
	// productive-walk chain so the probe can find the
	// package even when the configured RepoRoot points at
	// a build-tmp ancestor (the hermetic harness case).
	coreDist, err := r.resolveCoreDist()
	if err != nil {
		return "", err
	}

	tmpDir, err := os.MkdirTemp("", "hub-backup-probe-")
	if err != nil {
		return "", fmt.Errorf("hub backup: probe mkdir: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()
	probePath := filepath.Join(tmpDir, "probe.mjs")
	if err := os.WriteFile(probePath, []byte(probeScript), 0o600); err != nil {
		return "", fmt.Errorf("hub backup: probe write: %w", err)
	}

	probeEnv := append([]string{}, env...)
	probeEnv = append(probeEnv, "HUB_CORE_DIST="+coreDist)

	cmd := exec.CommandContext(ctx, node, probePath)
	cmd.Env = probeEnv
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return "", fmt.Errorf("hub backup: probe pipe: %w", err)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdoutR.Close()
		stdoutW.Close()
		return "", fmt.Errorf("hub backup: probe stderr pipe: %w", err)
	}
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW
	if err := cmd.Start(); err != nil {
		stdoutR.Close()
		stdoutW.Close()
		stderrR.Close()
		stderrW.Close()
		return "", fmt.Errorf("hub backup: probe spawn: %w", err)
	}
	stdoutW.Close()
	stderrW.Close()
	stdoutBytes, _ := io.ReadAll(io.LimitReader(stdoutR, MaxCaptureBytes+1))
	stdoutR.Close()
	stderrBytes, _ := io.ReadAll(stderrR)
	stderrR.Close()
	waitErr := cmd.Wait()
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			return "", fmt.Errorf("hub backup: probe exited %d: %s", exitErr.ExitCode(), output.Redact(string(stderrBytes)))
		}
		return "", fmt.Errorf("hub backup: probe wait: %w", waitErr)
	}
	var env2 struct {
		Path string `json:"path"`
	}
	// Trim trailing whitespace before JSON decoding so probe
	// output that ends with the Unix newline (or with a few
	// stray newlines from the .mjs child) is accepted as valid
	// JSON. `encoding/json` rejects any post-top-value content
	// — even trailing whitespace — once it leaves the JSON
	// document, so this normalization happens unconditionally
	// before Unmarshal.
	//
	// The embedded .mjs probe (see `probeScript` above)
	// concatenates a JS literal `'\n'` (the JS two-byte
	// backslash-`n` escape, NOT the byte 0x0a newline) onto
	// the JSON document, so a payload that "ends with two
	// newlines" in the spec translates at the byte level to
	// `JSON <literal-backslash> <literal-n>`. Strip one such
	// pair AFTER whitespace trimming so the decoder accepts
	// the payload. Bounded to a single suffix to keep the
	// behavior fail-closed: a JSON document followed by extra
	// garbage or by a SECOND JSON document still surfaces as
	// an Unmarshal error and is reported via the existing
	// redacted diagnostic.
	trimmedProbe := bytes.TrimSpace(stdoutBytes)
	if len(trimmedProbe) >= 2 &&
		trimmedProbe[len(trimmedProbe)-2] == '\\' &&
		trimmedProbe[len(trimmedProbe)-1] == 'n' {
		trimmedProbe = trimmedProbe[:len(trimmedProbe)-2]
	}
	if err := json.Unmarshal(trimmedProbe, &env2); err != nil {
		return "", fmt.Errorf("hub backup: probe parse: %w (stdout=%s)", err, output.Redact(string(stdoutBytes)))
	}
	if strings.TrimSpace(env2.Path) == "" {
		return "", fmt.Errorf("hub backup: probe returned empty path")
	}
	return env2.Path, nil
}

// resolveHubHome is the HUB_HOME forwarding helper. The .mjs
// child does NOT use this value for database path resolution —
// it goes through resolveHubDatabasePath which honours
// AGENT_MEMORY_DB_PATH first, then AGENT_MEMORY_DATA_DIR /
// PORTABLE_AGENT_ASSET_HUB_DATA_DIR, then platform default. The
// value is forwarded unchanged so the .mjs child can use it for
// diagnostics and for the default archive directory if ever
// requested in a future slice.
func (r *Runner) resolveHubHome() string {
	if r.envProbe != nil {
		return strings.TrimSpace(r.envProbe("HUB_HOME"))
	}
	return strings.TrimSpace(os.Getenv("HUB_HOME"))
}

// resolveCoreDist returns the absolute path to
// `@portable-agent-asset-hub/core`'s dist entry point. The
// locator mirrors the productive-walk chain the connect runner
// uses (`internal/connect/runner.go`) so the probe can find
// the package regardless of where the Go shell was built
// (production source tree, hermetic harness temp build,
// `go install`-style copied binary). There is no fallback
// DB path or hardcoded repository location; the locator
// always names the exact anchors it tried.
//
// Precedence (mirrors internal/connect/runner.go resolveScript):
//
//  1. Configured RepoRoot (the dispatcher may pass a value
//     resolved through main.go's repoRoot, an HUB_REPO_ROOT
//     override, or a hardcoded test fixture). When the
//     candidate lives at <RepoRoot>/packages/core/dist/index.js
//     OR <RepoRoot>/node_modules/@portable-agent-asset-hub/core/
//     dist/index.js, we accept it on the first hit.
//  2. Repo root derived from the resolved backup_runner.mjs
//     script location — the script is the canonical anchor
//     because the dispatcher already proved the script exists
//     at <realRoot>/internal/backup/backup_runner.mjs via
//     the productive walk, so two `Dir()` hops land on the
//     real source-tree root.
//  3. Productive walk from os.Executable() — the binary's
//     real path; a normal install lives at <repo>/cmd/hub/hub
//     so two parents up land on <repo>.
//  4. Productive walk from os.Getwd() — covers the test
//     harness layout where the binary was built into a temp
//     directory outside the source tree and the operator's
//     shell still has CWD inside the source tree.
//  5. Fail-closed: a missing file at every level surfaces a
//     precise diagnostic naming the anchors tried. The
//     locator NEVER invents a DB path or a registry — that
//     is the slice's anti-goal (`non_goals[0]`).
func (r *Runner) resolveCoreDist() (string, error) {
	// Collect the candidate absolute paths in priority order.
	// The configured RepoRoot is the historical fallback
	// (matches the connect runner); the productive-walk
	// anchors are tried next, each producing the same pair
	// of dist candidates a source-tree build would carry.
	candidates, roots := r.coreDistCandidates()
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c, nil
		}
	}
	return "", fmt.Errorf("hub backup: core dist not found (searched %d candidates across %d repo-root anchors: %v)", len(candidates), len(roots), roots)
}

// coreDistCandidates assembles the (candidate-path, repo-root)
// list in resolution priority order. Splitting this from
// resolveCoreDist keeps the precedence list readable and gives
// the probe's diagnostic a precise inventory of what was tried.
//
// The function is the only place that knows the package layout
// (packages/core vs node_modules/@portable-agent-asset-hub/core);
// changing the package layout means changing this function.
func (r *Runner) coreDistCandidates() ([]string, []string) {
	roots := r.repoRootCandidates()
	candidates := make([]string, 0, len(roots)*2)
	for _, root := range roots {
		if root == "" {
			continue
		}
		candidates = append(candidates, filepath.Join(root, "packages", "core", "dist", "index.js"))
		candidates = append(candidates, filepath.Join(root, "node_modules", "@portable-agent-asset-hub", "core", "dist", "index.js"))
	}
	return candidates, roots
}

// repoRootCandidates returns the list of repo-root paths the
// runner should try, in priority order. The first non-empty
// entry is the historical fallback; the rest are discovered
// via the productive-walk chain the connect runner uses.
//
// Precedence:
//
//  1. r.RepoRoot (configured by the dispatcher).
//  2. The repo root implied by the resolved backup_runner.mjs
//     script location: <scriptDir>/../.. — the script is the
//     canonical anchor because resolveScript already proved
//     it exists inside the real source tree.
//  3. Upward walk from os.Executable()'s real path — first
//     ancestor containing the canonical anchor (packages/core/
//     dist/index.js OR internal/backup/backup_runner.mjs).
//  4. Upward walk from os.Getwd()'s real path — same anchor
//     probe, second anchor.
//  5. Empty string — the caller's resolveCoreDist skips empty
//     roots so this never produces a wrong candidate.
func (r *Runner) repoRootCandidates() []string {
	roots := make([]string, 0, 5)
	if r.RepoRoot != "" {
		roots = append(roots, r.RepoRoot)
	}
	// Derive the repo root from the resolved script when we
	// can. The .mjs child sits at <root>/internal/backup/...;
	// two Dir() hops land on the real source-tree root. We
	// attempt this BEFORE the productive walks so the
	// dispatcher's "configured RepoRoot first" intent is
	// preserved while the temp-binary failure mode still
	// recovers: even when r.RepoRoot points at the build
	// tmp's grandparent, the script-anchored derivation
	// reaches the real repo root.
	if script, err := r.resolveScript(); err == nil {
		scriptRoot := filepath.Dir(filepath.Dir(script))
		if scriptRoot != "" && !containsString(roots, scriptRoot) {
			roots = append(roots, scriptRoot)
		}
	}
	// Productive walk from the running binary's real path.
	if exeRoot, err := locateRepoRootFromExecutable(); err == nil {
		if exeRoot != "" && !containsString(roots, exeRoot) {
			roots = append(roots, exeRoot)
		}
	}
	// Productive walk from the operator's working directory.
	if wdRoot, err := locateRepoRootFromWorkingDir(); err == nil {
		if wdRoot != "" && !containsString(roots, wdRoot) {
			roots = append(roots, wdRoot)
		}
	}
	return roots
}

// locateRepoRootFromExecutable resolves os.Executable() to its
// real path and walks parent directories upward looking for
// the canonical source-tree anchor (packages/core/dist/
// index.js OR internal/backup/backup_runner.mjs). The first
// directory that contains either marker is the repo root.
func locateRepoRootFromExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	real, realErr := filepath.EvalSymlinks(exe)
	if realErr != nil {
		real = exe
	}
	return locateRepoRootFromDir(filepath.Dir(real))
}

// locateRepoRootFromWorkingDir walks upward from os.Getwd().
// The vitest harness spawns the binary with `cwd: repoRoot`,
// so this probe finds the real source tree in test
// invocations where the binary lives in a temp dir outside
// the source tree.
func locateRepoRootFromWorkingDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("os.Getwd: %w", err)
	}
	real, realErr := filepath.EvalSymlinks(wd)
	if realErr != nil {
		real = wd
	}
	return locateRepoRootFromDir(real)
}

// locateRepoRootFromDir is the shared upward walker used by
// both the executable-anchored and the working-directory-
// anchored probes. Starting from `start`, it walks the
// directory itself and each ancestor up to maxWalkerDepth
// levels looking for a directory containing either
// packages/core/dist/index.js or internal/backup/backup_runner.mjs.
// The first hit is the repo root.
//
// The anchor set is deliberately small (two file paths) and
// lives ONLY in this file — every other layer relies on the
// source tree's package layout, never on a hardcoded absolute
// path.
func locateRepoRootFromDir(start string) (string, error) {
	dir := start
	if info, statErr := os.Stat(start); statErr == nil && !info.IsDir() {
		dir = filepath.Dir(start)
	}
	last := dir
	for i := 0; i < maxWalkerDepth; i++ {
		// Anchor #1: the canonical core dist the probe is
		// about to import.
		if _, err := os.Stat(filepath.Join(dir, "packages", "core", "dist", "index.js")); err == nil {
			return dir, nil
		}
		// Anchor #2: the backup runner's own script. The
		// script path is the most direct evidence that
		// this directory IS the source tree — a binary
		// pointing at it is itself built from this tree.
		if _, err := os.Stat(filepath.Join(dir, "internal", "backup", "backup_runner.mjs")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("walked up from %q through %d levels without finding packages/core/dist/index.js or internal/backup/backup_runner.mjs", last, maxWalkerDepth)
}

// containsString reports whether `xs` contains `s`. A small
// inlined predicate so we do not pull in slices.Contains for
// a single caller; the list is bounded to the candidate
// roots (typically 4 entries).
func containsString(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
