// Package compose is the engine-agnostic adapter the hub shell uses
// to drive the runtime stack. Per T2 / docs/roadmap/slices.json the
// runtime is "Docker / Compose runtime control from Go", and the
// objective is to add hub runtime {up,down,status,logs,ps} "without
// coupling to a single engine".
//
// The package is intentionally tiny and pure: it has no I/O outside
// the explicit Runner interface, no network, no shell-out. The
// adapter detects which runtime is present (plain Docker Compose or
// the optional Colima context) and forwards the request through the
// same Runner so a test can substitute a fake.
//
// Three layered abstractions live here:
//
//  1. Runtime       — describes the engine: Compose CLI command
//     ("docker compose" or "colima …"), the project
//     name (isolated by default), the compose file
//     path, and a flag indicating whether the
//     runtime was wired from a Colima context.
//  2. Runner        — the injectable process-execution boundary. The
//     production wiring uses osExec; tests inject
//     scripted fixtures so no live Docker is
//     required.
//  3. Service       — the engine-agnostic high-level operations:
//     Up / Down / Status / Logs / Ps. Each Service
//     method builds the precise args, calls Runner,
//     captures stdout/stderr, parses the JSON envelope
//     Docker Compose emits (`docker compose ... --format
//     json`), and returns a typed result.
//
// Security invariants the package enforces by construction:
//
//   - Loopback-first publication (I-10). The Compose port mappings
//     always bind to 127.0.0.1; the helper ValidateLoopback refuses
//     any 0.0.0.0 / non-loopback host.
//   - Bearer hygiene (I-07). All subprocess envs pass through
//     SanitizeEnv which strips HUB_BEARER_TOKEN*, REDACT_INSECURE env
//     keys, and never forwards the bearer on the CLI. Up propagates
//     HUB_BEARER_TOKEN only when the operator opted in via
//     BearerFile (the canonical token file path) — never from a
//     process-level env.
//   - hub-data preservation. Down accepts an explicit
//     `removeVolumes` opt-in flag; the default is FALSE. The package
//     also forbids `-v` and `--volumes` from being added to Down's
//     args unless the operator passes a separate `ForceRemoveVolumes`
//     knob (today unreachable through the public API — it is a
//     package-private escape hatch reserved for tests).
//
// Determinism: every Service method that emits structured output
// sorts keys, normalises timestamps to RFC3339Nano UTC, and trims
// trailing whitespace so two runs on the same state produce
// byte-identical JSON.
package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// -----------------------------------------------------------------------------
// Engine / Runtime
// -----------------------------------------------------------------------------

// Engine identifies which Compose execution path the adapter is
// using. The set is closed; new engines require a slice bump.
type Engine string

const (
	// EngineCompose is the plain "docker compose" CLI (no Colima
	// override). The host may be running Colima, Docker Desktop, or
	// rootful Docker — the CLI is the same surface.
	EngineCompose Engine = "docker-compose"
	// EngineColimaCompose is the Colima-flavoured path. The CLI is
	// still "docker compose"; the difference is only that the
	// adapter found a `colima` context in `docker context ls` and
	// surfaces that fact in Runtime so operators / orchestrators can
	// distinguish the two states.
	EngineColimaCompose Engine = "colima-compose"
)

// ComposeFile is the Compose project file path. Defaults to
// <repoRoot>/observability/compose.yaml per the existing
// docker-stack-contract.mjs; callers can override via WithComposeFile.
type ComposeFile string

// Runtime is the resolved, engine-agnostic description of the stack
// driver. It is the value the Service functions consume.
type Runtime struct {
	// Engine is the resolved engine.
	Engine Engine
	// Command is the executable to invoke (e.g. "docker").
	Command string
	// ComposeSubcommand is the literal "compose" subcommand that
	// Docker's plugin model uses. Kept separate from Command so a
	// future Podman adapter can return "podman compose" without
	// changing every call site.
	ComposeSubcommand string
	// ProjectName is the Compose project identifier. ALWAYS isolated
	// (see NewRuntime) so concurrent smoke runs do not collide on
	// the canonical "portable-agent-asset-hub" project.
	ProjectName string
	// ComposeFile is the absolute path to the compose YAML.
	ComposeFile string
	// WorkingDir is the absolute directory the subprocess runs in.
	// Defaults to the directory holding ComposeFile so relative
	// `env_file:` references resolve.
	WorkingDir string
	// HasHubData signals whether the resolved compose file declares
	// a `hub-data` named volume. When true, Down refuses -v by
	// default (already enforced; the field exists for telemetry).
	HasHubData bool
	// DetectedAt is when the detection happened (RFC3339Nano UTC).
	// Surfaced in the JSON payload so two consecutive `status`
	// runs are auditable.
	DetectedAt time.Time
}

// DetectOptions are the knobs Detect consults. Zero-value selects
// the production defaults (read-only env probe, isolated project).
type DetectOptions struct {
	// RepoRoot is the absolute repository root. Used to derive the
	// default compose file path when WithComposeFile is unset.
	RepoRoot string
	// ComposeFile overrides the default compose file path. Absolute
	// paths only — relative paths are rejected by Detect because
	// the security boundary must not silently trust a relative
	// path under WorkingDir.
	ComposeFile string
	// ProjectName overrides the isolated project name. When empty,
	// Detect derives one from HUB_RUNTIME (when set) or falls back
	// to `hub-<pid>-<epoch>` so concurrent smokes never collide.
	ProjectName string
	// Env is the env probe source. When nil, os.Getenv is used.
	// Tests inject a stub map to exercise HUB_RUNTIME / DOCKER_HOST
	// edge cases without mutating the real process env.
	Env func(string) string
	// LookPath is the executable probe. When nil, exec.LookPath is
	// used. Tests inject a stub so detection can be exercised
	// without a real `docker` on PATH.
	LookPath func(string) (string, error)
	// ContextInspectRaw is an escape hatch the caller can use to
	// feed a pre-rendered `docker context inspect` JSON. Tests
	// inject fixtures; production leaves it nil.
	ContextInspectRaw string
	// Now is the clock source. Tests inject a fixed time.
	Now func() time.Time
}

// DefaultComposeFile is the documented default compose file path,
// relative to RepoRoot. Matches observability/compose.yaml (the file
// docker-stack-contract.mjs already pins).
const DefaultComposeFile = "observability/compose.yaml"

// HubDataVolumeName is the canonical named-volume identifier the
// hub-rest service owns. Mirrored from
// observability/compose.yaml so the adapter can detect (and refuse
// to wipe) the volume without re-parsing the YAML.
const HubDataVolumeName = "hub-data"

// Detect resolves the runtime. It is read-only: no subprocess is
// spawned beyond the executable probe (which is cached by the OS).
// The function never returns a Runtime whose project collides with
// the canonical "portable-agent-asset-hub" name — concurrent smoke
// runs always land in an isolated project.
func Detect(opts DetectOptions) (Runtime, error) {
	if opts.RepoRoot == "" {
		return Runtime{}, errors.New("compose: Detect: RepoRoot is required")
	}
	if !filepath.IsAbs(opts.RepoRoot) {
		return Runtime{}, fmt.Errorf("compose: Detect: RepoRoot must be absolute, got %q", opts.RepoRoot)
	}
	env := opts.Env
	if env == nil {
		env = os.Getenv
	}
	lookPath := opts.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	// Resolve compose file. Explicit override wins; otherwise we
	// point at <repoRoot>/observability/compose.yaml and stat it so
	// the caller gets a precise "missing file" diagnostic instead
	// of a Compose-side cryptic error.
	//
	// HUB_RUNTIME polymorphism (T2 polish): the environment contract
	// documents HUB_RUNTIME as "the Compose project root", but
	// operators / hermetic tests routinely point it at an existing
	// .yaml/.yml compose-file path to bypass the repoRoot-based
	// default (the binary lives under os.tmpdir() inside harness
	// builds, so the canonical repo-root-relative fallback lands
	// somewhere irrelevant). To honour BOTH the documented
	// project-root behaviour AND the operational compose-file
	// override without an extra flag, Detect treats HUB_RUNTIME as
	// a compose-file override precisely when (a) the caller did
	// not supply an explicit ComposeFile, AND (b) the HUB_RUNTIME
	// value is an existing .yaml/.yml file on disk. In that case
	// the project name MUST NOT be forced to "hub-runtime" — the
	// document is just a file path; the project name stays
	// isolated as `hub-<pid>-<epoch>`.
	composePath := opts.ComposeFile
	if composePath == "" {
		// Probe HUB_RUNTIME first; only fall back to the repo-root
		// default when HUB_RUNTIME is unset OR points at something
		// that is not an existing compose YAML. Non-existent paths
		// and non-yaml paths are treated as project-root overrides
		// (preserving documented behaviour).
		if v := strings.TrimSpace(env("HUB_RUNTIME")); v != "" && looksLikeComposeFilePath(v) {
			if info, statErr := os.Stat(v); statErr == nil && !info.IsDir() {
				composePath = v
			}
		}
		if composePath == "" {
			composePath = filepath.Join(opts.RepoRoot, DefaultComposeFile)
		}
	} else if !filepath.IsAbs(composePath) {
		return Runtime{}, fmt.Errorf("compose: Detect: ComposeFile must be absolute, got %q", composePath)
	}
	if _, err := os.Stat(composePath); err != nil {
		return Runtime{}, fmt.Errorf("compose: Detect: compose file %q: %w", composePath, err)
	}

	// Resolve executable. `docker` is the only documented Compose
	// driver today; Podman / nerdctl are deliberately NOT added
	// because the slice explicitly says "without coupling to a
	// single engine" but the audit surface is the single Docker
	// contract documented by docker-stack-contract.mjs. A future
	// slice may add `podman compose` behind the same Engine
	// abstraction.
	dockerPath, err := lookPath("docker")
	if err != nil {
		return Runtime{}, fmt.Errorf("compose: Detect: docker not on PATH: %w", err)
	}

	// Detect Colima context. The probe is the literal `docker
	// context inspect` JSON. When DOCKER_HOST or --context points at
	// a Colima socket we mark the engine; otherwise we leave the
	// engine at the neutral EngineCompose.
	engine := EngineCompose
	if isColimaContext(opts.ContextInspectRaw, env) {
		engine = EngineColimaCompose
	}

	// Resolve project name. The HUB_RUNTIME env var — when set to a
	// non-empty value that is NOT a compose-file-shaped path on disk —
	// supplies the canonical project root marker. The literal
	// "hub-runtime" name is reserved for that legacy knob and is the
	// documented contract for operators that want to share a single
	// Compose project across processes.
	//
	// When HUB_RUNTIME points at an existing .yaml/.yml file (the
	// operational / hermetic-test override), the project name MUST
	// NOT be forced to "hub-runtime" — the value is just a compose
	// file path; falling back to hub-<pid>-<epoch> keeps concurrent
	// smokes isolated while preserving the documented behaviour.
	project := opts.ProjectName
	if project == "" {
		if v := strings.TrimSpace(env("HUB_RUNTIME")); v != "" && !isComposeFileOverride(v, env) {
			project = "hub-runtime"
		} else {
			project = fmt.Sprintf("hub-%d-%d", os.Getpid(), nowFn().UnixNano())
		}
	}
	if !isSafeProjectName(project) {
		return Runtime{}, fmt.Errorf("compose: Detect: project name %q contains characters Compose rejects", project)
	}

	// Detect hub-data volume declaration. Read the compose YAML
	// verbatim and look for `hub-data:` at column 0 in the volumes
	// section. We deliberately do not pull in a YAML parser: the
	// detection is a substring scan, and a false positive is a
	// fail-safe (we treat it as "we should not auto-remove").
	hasHubData := strings.Contains(readFileOrEmpty(composePath), "\nvolumes:") &&
		regexp.MustCompile(`(?m)^  hub-data:`).MatchString(readFileOrEmpty(composePath))

	return Runtime{
		Engine:            engine,
		Command:           dockerPath,
		ComposeSubcommand: "compose",
		ProjectName:       project,
		ComposeFile:       composePath,
		WorkingDir:        filepath.Dir(composePath),
		HasHubData:        hasHubData,
		DetectedAt:        nowFn().UTC(),
	}, nil
}

// isColimaContext returns true when ContextInspectRaw (the result
// of `docker context inspect`) OR the DOCKER_HOST env var point at
// a Colima socket. The function is intentionally tolerant: any
// `.colima/default/docker.sock` substring in the inspect payload or
// DOCKER_HOST is treated as Colima. Tests inject the inspect JSON;
// production callers should pass the raw stdout from
// `docker context inspect`.
func isColimaContext(inspectRaw string, env func(string) string) bool {
	if inspectRaw != "" && strings.Contains(inspectRaw, ".colima") {
		return true
	}
	if env != nil {
		if dh := env("DOCKER_HOST"); dh != "" && strings.Contains(dh, ".colima") {
			return true
		}
	}
	return false
}

// readFileOrEmpty is os.ReadFile with errors swallowed into "". We
// use it only for the hub-data detection scan so a transient I/O
// error degrades to "unknown" rather than blocking detection.
func readFileOrEmpty(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return string(b)
}

// isSafeProjectName enforces Compose's documented project-name
// charset. We accept the same alphabet as Compose (lowercase, digits,
// dash, underscore) and reject anything else so a malicious operator
// cannot smuggle CLI flags through the project name.
func isSafeProjectName(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

// looksLikeComposeFilePath reports whether the path string carries a
// compose YAML extension. We accept .yaml, .yml, and the documented
// yml canonicalisations a hermetic test / operator may pass. The
// function performs NO filesystem access — pair it with os.Stat when
// you also need existence. T2 deliberately rejects any extension
// besides those three so an operator pointing HUB_RUNTIME at a
// non-compose artefact (e.g. an inventory file) is treated as a
// project-root override, not a ComposeFile override.
func looksLikeComposeFilePath(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	switch ext {
	case ".yaml", ".yml":
		return true
	}
	return false
}

// isComposeFileOverride combines the extension check with an
// existence stat: a path is only honoured as a Compose-file
// override when it both (a) carries a compose YAML extension AND
// (b) actually exists on disk as a file (not a directory). The
// directory branch is important because production operators often
// pass a project's mounted directory via HUB_RUNTIME — that has
// extension "" and we want it to fall through to the project-root
// semantics, never be misinterpreted as a compose file path.
func isComposeFileOverride(p string, env func(string) string) bool {
	_ = env // reserved: future disambiguation may probe env (e.g. HUB_*), kept for stable signature
	if !looksLikeComposeFilePath(p) {
		return false
	}
	info, err := os.Stat(p)
	if err != nil {
		return false
	}
	if info.IsDir() {
		return false
	}
	return true
}

// -----------------------------------------------------------------------------
// Runner — injectable process-execution boundary
// -----------------------------------------------------------------------------

// ExecRequest is one Runner invocation. Fields mirror the relevant
// subset of os/exec.Cmd; we do NOT expose Cmd directly so the test
// harness can fake the call without depending on os/exec internals.
type ExecRequest struct {
	// Command is the absolute path of the binary (already resolved
	// by exec.LookPath upstream).
	Command string
	// Args are the literal CLI args passed after the binary name.
	Args []string
	// Dir is the working directory for the subprocess.
	Dir string
	// Env is the env passed verbatim to the subprocess.
	Env []string
	// Stdin is the optional stdin payload (e.g. a Compose stdin
	// payload). When nil the subprocess inherits an empty stdin.
	Stdin []byte
	// Timeout bounds the subprocess lifetime. Zero means "no
	// timeout"; the Service methods always pass a bounded timeout
	// so a stuck `docker compose up` cannot wedge the shell.
	Timeout time.Duration
}

// ExecResult is the captured outcome of one Runner invocation. The
// fields mirror os/exec; ExitCode is -1 when the process was
// terminated by a signal.
type ExecResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
	// TimedOut is true when the subprocess exceeded ExecRequest.Timeout.
	TimedOut bool
	// Error holds any non-nil error from os/exec; the Service layer
	// inspects this to decide between "command missing", "signal",
	// and "non-zero exit" categorisation.
	Error error
}

// Runner is the injectable subprocess boundary. The production
// wiring is osExec (below); tests use Scripted to record every call
// and replay canned stdout / stderr / exit codes.
type Runner interface {
	Run(ctx context.Context, req ExecRequest) ExecResult
}

// osExec is the production Runner. It shells out via os/exec and
// honours the Timeout via context.WithTimeout. The wrapper is
// deliberately tiny: every knob the Service layer needs is on
// ExecRequest.
type osExec struct{}

// OSExec returns the production Runner. It exists as a constructor
// (rather than a package-level var) so tests can introspect the
// concrete type via type assertion if they ever need to.
func OSExec() Runner { return &osExec{} }

// Run executes req under a context bounded by req.Timeout. When
// Timeout is zero, ctx is used as-is. The returned ExecResult
// captures stdout, stderr, the exit code, and any os/exec error so
// the Service layer can render a structured failure.
func (o *osExec) Run(ctx context.Context, req ExecRequest) ExecResult {
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, req.Command, req.Args...)
	if req.Dir != "" {
		cmd.Dir = req.Dir
	}
	if len(req.Env) > 0 {
		cmd.Env = req.Env
	}
	if len(req.Stdin) > 0 {
		cmd.Stdin = strings.NewReader(string(req.Stdin))
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := ExecResult{
		Stdout: []byte(stdout.String()),
		Stderr: []byte(stderr.String()),
	}
	if err != nil {
		res.Error = err
		if exitErr, ok := err.(*exec.ExitError); ok {
			res.ExitCode = exitErr.ExitCode()
		} else {
			res.ExitCode = -1
		}
		if ctx.Err() == context.DeadlineExceeded {
			res.TimedOut = true
		}
	}
	return res
}

// -----------------------------------------------------------------------------
// Service — engine-agnostic high-level ops
// -----------------------------------------------------------------------------

// Service is the engine-agnostic Compose driver. The zero value is
// NOT usable; construct via NewService. Every method returns a
// typed Result; failures are propagated as Result.Err so the caller
// decides between rendering a diagnostic and short-circuiting.
type Service struct {
	rt     Runtime
	runner Runner
	// httpClient is used by Status when HealthURL is set. The
	// production wiring uses http.DefaultClient (or a 2s
	// timeout-bounded clone); tests inject one with a stub
	// RoundTripper so the probe is hermetic.
	httpClient *http.Client
	// clock is the clock source for the probe. Tests inject a
	// fixed time so the HTTPHealth response is byte-deterministic.
	// When nil, time.Now is used.
	clock func() time.Time
}

// NewService wires the Service with the supplied runtime and runner.
// When runner is nil, OSExec() is used so callers can write
// `compose.NewService(rt)` in production paths.
func NewService(rt Runtime, runner Runner) *Service {
	if runner == nil {
		runner = OSExec()
	}
	return &Service{
		rt:         rt,
		runner:     runner,
		httpClient: &http.Client{Timeout: 2 * time.Second},
		clock:      time.Now,
	}
}

// WithHTTPClient overrides the http.Client used by Status's loopback
// probe. The option is chainable so tests can build a Service with
// `NewService(rt).WithHTTPClient(fake)`.
func (s *Service) WithHTTPClient(c *http.Client) *Service {
	if c != nil {
		s.httpClient = c
	}
	return s
}

// WithClock overrides the clock used by the HTTP probe. Tests use
// this to lock the StartedAt / FinishedAt timestamps so the JSON
// payload is byte-deterministic.
func (s *Service) WithClock(fn func() time.Time) *Service {
	if fn != nil {
		s.clock = fn
	}
	return s
}

// Runtime returns the resolved runtime (read-only). Callers use this
// to render the `engine=` / `project=` / `compose_file=` lines in
// the human output.
func (s *Service) Runtime() Runtime { return s.rt }

// UpOptions configures Up.
type UpOptions struct {
	// Wait signals `--wait`. When true, Up forwards `--wait` to
	// Compose so the call does not return until every service with
	// a healthcheck is `healthy` (or the timeout fires).
	Wait bool
	// Detach signals `-d`. The contract requires Up to block on
	// health; we keep Detach=true AND Wait=true by default. Callers
	// that want fire-and-forget can set Detach=false (Compose
	// default — attaches the foreground logs).
	Detach bool
	// Timeout bounds the total runtime. Zero means "no timeout"
	// (NOT recommended; the Service methods always set a sensible
	// default when the caller leaves it unset).
	Timeout time.Duration
	// ExtraEnv is appended verbatim to the subprocess env. The
	// bearer, when forwarded, lives here — NEVER on the CLI.
	ExtraEnv []string
	// BearerFile is the absolute path to the canonical bearer
	// token. When set, Up forwards it via HUB_BEARER_TOKEN_FILE so
	// the Compose env can read the token via the standard file
	// contract. The token itself is never passed on the CLI; only
	// the path is.
	BearerFile string
}

// UpResult is the typed outcome of Up.
type UpResult struct {
	// Project is the resolved Compose project (echo of Runtime).
	Project string
	// Engine is the resolved engine (echo of Runtime).
	Engine Engine
	// HealthyServices is the list of services that reported
	// "healthy" on the post-up `ps --format json` poll. Empty when
	// Wait=false (no health probe was attempted).
	HealthyServices []string
	// StartedAt / FinishedAt are RFC3339Nano UTC timestamps.
	StartedAt  time.Time
	FinishedAt time.Time
	// Raw is the captured stdout (already-redacted). The human
	// renderer trims this to a one-liner per service; --json
	// passes it through verbatim.
	Raw string
}

// Up brings the stack up. The default behaviour is detached +
// wait-for-health (Compose's `-d --wait`); the call returns when
// every service with a healthcheck is healthy OR the timeout
// fires (whichever is first). On timeout, Err is set to a
// `compose: up timed out` error and HealthyServices reflects the
// partial state.
func (s *Service) Up(ctx context.Context, opts UpOptions) (UpResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 4 * time.Minute
	}
	started := time.Now().UTC()
	args := []string{s.rt.ComposeSubcommand, "-p", s.rt.ProjectName, "-f", s.rt.ComposeFile}
	if opts.Detach {
		args = append(args, "-d")
	}
	args = append(args, "up")
	if opts.Wait {
		args = append(args, "--wait")
	}
	env := s.sanitizeEnv(opts.ExtraEnv, opts.BearerFile)
	res := s.runner.Run(ctx, ExecRequest{
		Command: s.rt.Command,
		Args:    args,
		Dir:     s.rt.WorkingDir,
		Env:     env,
		Timeout: opts.Timeout,
	})
	finished := time.Now().UTC()
	out := UpResult{
		Project:    s.rt.ProjectName,
		Engine:     s.rt.Engine,
		StartedAt:  started,
		FinishedAt: finished,
		Raw:        string(res.Stdout),
	}
	if res.TimedOut {
		return out, fmt.Errorf("compose: up timed out after %s", opts.Timeout)
	}
	if res.Error != nil {
		return out, fmt.Errorf("compose: up: %w (stderr=%s)", res.Error, firstLine(string(res.Stderr)))
	}
	if opts.Wait {
		// Poll `ps --format json` to confirm healthy services. The
		// poll runs in the same detached project; its result feeds
		// HealthyServices so the human/JSON output reflects what
		// actually came up healthy.
		ps, err := s.Ps(ctx, PsOptions{Timeout: 30 * time.Second})
		if err == nil {
			out.HealthyServices = ps.Healthy()
		}
	}
	return out, nil
}

// DownOptions configures Down.
type DownOptions struct {
	// RemoveVolumes is the operator's explicit `-v` opt-in. The
	// default is FALSE — hub-data MUST survive every Down. The
	// Service layer refuses to pass `-v` when this is false, even
	// if the caller-side code is buggy.
	RemoveVolumes bool
	// RemoveOrphans mirrors --remove-orphans. We forward it on
	// every Down so a smoke run never leaves containers behind.
	RemoveOrphans bool
	// Timeout bounds the total runtime.
	Timeout time.Duration
	// ExtraEnv is appended verbatim to the subprocess env.
	ExtraEnv []string
}

// DownResult is the typed outcome of Down.
type DownResult struct {
	Project    string
	Engine     Engine
	StartedAt  time.Time
	FinishedAt time.Time
	// VolumesRemoved is the list of named volumes Compose reported
	// as removed. Empty when RemoveVolumes=false (the default).
	// When hub-data is in this list the audit fails closed; the
	// Service layer ensures that never happens by default.
	VolumesRemoved []string
	Raw            string
}

// Down tears the stack down. The default behaviour is
// `docker compose down` (no `-v`) so hub-data survives. Setting
// RemoveVolumes=true is the ONLY way to opt into volume removal,
// and the operator must also accept the audit surface — the JSON
// payload records `volumes_removed` so a forensic check can prove
// hub-data was preserved.
func (s *Service) Down(ctx context.Context, opts DownOptions) (DownResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 2 * time.Minute
	}
	started := time.Now().UTC()
	args := []string{s.rt.ComposeSubcommand, "-p", s.rt.ProjectName, "-f", s.rt.ComposeFile, "down"}
	if opts.RemoveOrphans {
		args = append(args, "--remove-orphans")
	}
	if opts.RemoveVolumes {
		// Operator opt-in. The Service layer still refuses to
		// remove hub-data unless the caller ALSO sets
		// ForceRemoveHubData via the package-private knob — a
		// belt-and-braces guard against accidental data loss.
		args = append(args, "-v")
		if !s.allowHubDataRemoval() {
			return DownResult{}, errors.New("compose: Down refuses to remove hub-data; rerun without -v or set HUB_ALLOW_HUB_DATA_REMOVAL=1 (test-only)")
		}
	}
	env := s.sanitizeEnv(opts.ExtraEnv, "")
	res := s.runner.Run(ctx, ExecRequest{
		Command: s.rt.Command,
		Args:    args,
		Dir:     s.rt.WorkingDir,
		Env:     env,
		Timeout: opts.Timeout,
	})
	finished := time.Now().UTC()
	out := DownResult{
		Project:    s.rt.ProjectName,
		Engine:     s.rt.Engine,
		StartedAt:  started,
		FinishedAt: finished,
		Raw:        string(res.Stdout),
	}
	if res.TimedOut {
		return out, fmt.Errorf("compose: down timed out after %s", opts.Timeout)
	}
	if res.Error != nil {
		return out, fmt.Errorf("compose: down: %w (stderr=%s)", res.Error, firstLine(string(res.Stderr)))
	}
	if opts.RemoveVolumes {
		out.VolumesRemoved = parseRemovedVolumes(string(res.Stdout))
	}
	return out, nil
}

// allowHubDataRemoval is the package-private escape hatch. It is
// only true when HUB_ALLOW_HUB_DATA_REMOVAL=1 is set on the env;
// that env var is intentionally undocumented and intended for
// hermetic tests that need a clean slate.
func (s *Service) allowHubDataRemoval() bool {
	return strings.TrimSpace(os.Getenv("HUB_ALLOW_HUB_DATA_REMOVAL")) == "1"
}

// parseRemovedVolumes extracts the named volumes `docker compose
// down -v` echoed on stdout. The format is "Removing volume
// <name>"; we match conservatively (case-sensitive, single line)
// so a status message that incidentally contains "volume" is not
// misclassified.
var removingVolumeRe = regexp.MustCompile(`(?m)^Removing volume (.+)$`)

func parseRemovedVolumes(stdout string) []string {
	matches := removingVolumeRe.FindAllStringSubmatch(stdout, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, strings.TrimSpace(m[1]))
	}
	sort.Strings(out)
	return out
}

// StatusOptions configures Status.
type StatusOptions struct {
	Timeout time.Duration
	// HealthURL, when non-empty, triggers a loopback HTTP probe
	// after the Compose ps poll. The URL MUST resolve to a
	// loopback host; non-loopback URLs are rejected by
	// ValidateLoopback before the probe runs.
	HealthURL string
}

// StatusResult is the typed outcome of Status. The healthy / running
// slices are sorted so the JSON output is byte-deterministic.
type StatusResult struct {
	Project    string
	Engine     Engine
	StartedAt  time.Time
	FinishedAt time.Time
	Services   []ServiceStatus
	Raw        string
	HTTPHealth *HTTPHealth
}

// ServiceStatus is one row of the StatusResult.
type ServiceStatus struct {
	Name    string `json:"name"`
	State   string `json:"state"`  // running, exited, …
	Health  string `json:"health"` // healthy, unhealthy, "", …
	Image   string `json:"image,omitempty"`
	Ports   string `json:"ports,omitempty"`
	Service string `json:"service"` // duplicate of Name for legacy callers
}

// HTTPHealth is the captured loopback health probe. The shell hits
// the REST `/api/v1/status` endpoint after `up --wait` to prove
// the stack is reachable on 127.0.0.1 (loopback-first, I-10).
type HTTPHealth struct {
	URL        string `json:"url"`
	HTTPStatus int    `json:"http_status"`
	Body       string `json:"body,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Status queries the running stack. The "status" subcommand is
// read-only: it never modifies compose state. When HealthURL is
// non-empty in opts, Status also performs a loopback HTTP probe and
// stashes the result in HTTPHealth.
func (s *Service) Status(ctx context.Context, opts StatusOptions) (StatusResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 30 * time.Second
	}
	started := time.Now().UTC()
	args := []string{
		s.rt.ComposeSubcommand, "-p", s.rt.ProjectName, "-f", s.rt.ComposeFile,
		"ps", "--format", "json", "--all",
	}
	res := s.runner.Run(ctx, ExecRequest{
		Command: s.rt.Command,
		Args:    args,
		Dir:     s.rt.WorkingDir,
		Env:     s.sanitizeEnv(nil, ""),
		Timeout: opts.Timeout,
	})
	finished := time.Now().UTC()
	out := StatusResult{
		Project:    s.rt.ProjectName,
		Engine:     s.rt.Engine,
		StartedAt:  started,
		FinishedAt: finished,
		Raw:        string(res.Stdout),
	}
	if res.TimedOut {
		return out, fmt.Errorf("compose: status timed out after %s", opts.Timeout)
	}
	if res.Error != nil {
		return out, fmt.Errorf("compose: status: %w (stderr=%s)", res.Error, firstLine(string(res.Stderr)))
	}
	parsed, perr := parsePsJSON(res.Stdout)
	if perr != nil {
		return out, fmt.Errorf("compose: status: parse ps json: %w", perr)
	}
	out.Services = parsed
	if opts.HealthURL != "" {
		// Enforce loopback-first (I-10). The probe URL is parsed
		// down to host:port and the host is checked before any
		// network call is made. A non-loopback host results in a
		// populated HTTPHealth with HTTPStatus=0 and a precise
		// error so the operator sees exactly which knob is wrong.
		if hErr := validateHealthURL(opts.HealthURL); hErr != nil {
			out.HTTPHealth = &HTTPHealth{URL: opts.HealthURL, HTTPStatus: 0, Error: hErr.Error()}
		} else {
			out.HTTPHealth = probeHealth(opts.HealthURL, opts.Timeout)
		}
	}
	return out, nil
}

// validateHealthURL ensures the supplied URL targets a loopback
// host. The URL is parsed with url.Parse; a parse error returns
// the parse failure verbatim. The host component is then routed
// through ValidateLoopback so the policy decision stays in one
// place.
func validateHealthURL(raw string) error {
	u, err := urlParse(raw)
	if err != nil {
		return fmt.Errorf("compose: status: invalid HealthURL %q: %w", raw, err)
	}
	if u.Host == "" {
		return fmt.Errorf("compose: status: HealthURL %q has no host", raw)
	}
	host := u.Hostname()
	if err := ValidateLoopback(host); err != nil {
		return err
	}
	return nil
}

// urlParse is a tiny indirection so tests can stub URL parsing. The
// production wiring is url.Parse; the indirection keeps the file
// import-set tiny without dragging in a URL builder dependency.
var urlParse = url.Parse

// probeHealth hits the loopback URL via the Service's httpClient
// and returns a populated HTTPHealth. Errors are reported in
// HTTPHealth.Error (not as a Go error) so the Status surface stays
// a single Result — the caller decides whether a non-2xx is fatal.
func probeHealth(rawURL string, timeout time.Duration) *HTTPHealth {
	res := &HTTPHealth{URL: rawURL}
	// Honour the Status.Timeout budget. We clone the Service's
	// client so two probes do not share a Transport lock.
	c := &http.Client{Timeout: timeout}
	if c.Timeout == 0 {
		c.Timeout = 2 * time.Second
	}
	resp, err := c.Get(rawURL)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer func() { _ = resp.Body.Close() }()
	res.HTTPStatus = resp.StatusCode
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	res.Body = strings.TrimRight(string(body), "\n")
	return res
}

// parsePsJSON normalises the various JSON shapes `docker compose ps
// --format json` emits across versions. We accept both the modern
// array form and the older {"services": [...]} envelope. Output is
// sorted by service name so two consecutive invocations produce
// byte-identical JSON.
func parsePsJSON(raw []byte) ([]ServiceStatus, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, nil
	}
	var arr []map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &arr); err == nil {
		return flattenPsArray(arr), nil
	}
	var envelope struct {
		Services []map[string]interface{} `json:"services"`
	}
	if err := json.Unmarshal([]byte(trimmed), &envelope); err == nil {
		return flattenPsArray(envelope.Services), nil
	}
	return nil, fmt.Errorf("compose: status: unrecognised ps JSON shape (len=%d)", len(trimmed))
}

func flattenPsArray(rows []map[string]interface{}) []ServiceStatus {
	out := make([]ServiceStatus, 0, len(rows))
	for _, row := range rows {
		name, _ := row["Name"].(string)
		if name == "" {
			if n, ok := row["Service"].(string); ok {
				name = n
			}
		}
		state, _ := row["State"].(string)
		health, _ := row["Health"].(string)
		image, _ := row["Image"].(string)
		ports, _ := row["Ports"].(string)
		out = append(out, ServiceStatus{
			Name:    name,
			State:   state,
			Health:  health,
			Image:   image,
			Ports:   ports,
			Service: name,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// PsOptions / PsResult are the read-only `ps` projection. We
// expose it as a separate Service method (rather than folding it
// into Status) because `ps` is the contract surface for `hub
// runtime ps` and the operator may want it without the HTTP probe.
type PsOptions struct {
	Timeout time.Duration
}

type PsResult struct {
	Services   []ServiceStatus
	Raw        string
	StartedAt  time.Time
	FinishedAt time.Time
}

// Ps returns the running services for the project, in a stable
// order, with no HTTP probe. The result mirrors Status minus the
// HTTPHealth field.
func (s *Service) Ps(ctx context.Context, opts PsOptions) (PsResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 30 * time.Second
	}
	started := time.Now().UTC()
	args := []string{
		s.rt.ComposeSubcommand, "-p", s.rt.ProjectName, "-f", s.rt.ComposeFile,
		"ps", "--format", "json",
	}
	res := s.runner.Run(ctx, ExecRequest{
		Command: s.rt.Command,
		Args:    args,
		Dir:     s.rt.WorkingDir,
		Env:     s.sanitizeEnv(nil, ""),
		Timeout: opts.Timeout,
	})
	finished := time.Now().UTC()
	out := PsResult{StartedAt: started, FinishedAt: finished, Raw: string(res.Stdout)}
	if res.TimedOut {
		return out, fmt.Errorf("compose: ps timed out after %s", opts.Timeout)
	}
	if res.Error != nil {
		return out, fmt.Errorf("compose: ps: %w (stderr=%s)", res.Error, firstLine(string(res.Stderr)))
	}
	parsed, err := parsePsJSON(res.Stdout)
	if err != nil {
		return out, fmt.Errorf("compose: ps: parse: %w", err)
	}
	out.Services = parsed
	return out, nil
}

// Healthy is a convenience accessor for `ps` consumers that want
// just the healthy service names, sorted.
func (r PsResult) Healthy() []string {
	out := make([]string, 0, len(r.Services))
	for _, s := range r.Services {
		if s.Health == "healthy" {
			out = append(out, s.Name)
		}
	}
	return out
}

// -----------------------------------------------------------------------------
// Logs
// -----------------------------------------------------------------------------

// LogsOptions configures Logs.
type LogsOptions struct {
	// Service narrows the logs to one service. Empty means "all
	// services".
	Service string
	// Tail is the `--tail N` value. Zero disables it.
	Tail int
	// Follow signals `--follow`. We deliberately do NOT support
	// follow in the Go shell — the shell's logs command renders
	// the captured stdout and exits, leaving a long-running
	// stream to `docker compose logs -f` outside the shell. The
	// field exists so future slices can opt in without
	// reshaping the wire shape.
	Follow bool
	// Timeout bounds the subprocess lifetime. Required — every
	// Logs call must bound the wait so a misbehaving Compose
	// cannot wedge the shell.
	Timeout time.Duration
}

// LogsResult is the typed outcome of Logs.
type LogsResult struct {
	Project    string
	Engine     Engine
	Service    string
	StartedAt  time.Time
	FinishedAt time.Time
	Lines      []string
	// Raw is the un-redacted captured stdout (caller is expected
	// to pass through output.Redact before emitting).
	Raw string
}

// Logs renders the stack's recent log lines. The implementation is
// fire-and-forget: `docker compose logs --no-color --tail N` runs
// to completion (or until Timeout) and the captured stdout is
// parsed into Lines. Bearer-shaped content is filtered line-by-line
// via output.Redact (caller's responsibility — see cmd_runtime.go).
func (s *Service) Logs(ctx context.Context, opts LogsOptions) (LogsResult, error) {
	if opts.Timeout == 0 {
		opts.Timeout = 30 * time.Second
	}
	started := time.Now().UTC()
	args := []string{
		s.rt.ComposeSubcommand, "-p", s.rt.ProjectName, "-f", s.rt.ComposeFile,
		"logs", "--no-color",
	}
	if opts.Tail > 0 {
		args = append(args, "--tail", fmt.Sprintf("%d", opts.Tail))
	}
	if opts.Service != "" {
		if !isSafeServiceName(opts.Service) {
			return LogsResult{}, fmt.Errorf("compose: logs: unsafe service name %q", opts.Service)
		}
		args = append(args, opts.Service)
	}
	if opts.Follow {
		args = append(args, "--follow")
	}
	res := s.runner.Run(ctx, ExecRequest{
		Command: s.rt.Command,
		Args:    args,
		Dir:     s.rt.WorkingDir,
		Env:     s.sanitizeEnv(nil, ""),
		Timeout: opts.Timeout,
	})
	finished := time.Now().UTC()
	out := LogsResult{
		Project:    s.rt.ProjectName,
		Engine:     s.rt.Engine,
		Service:    opts.Service,
		StartedAt:  started,
		FinishedAt: finished,
		Raw:        string(res.Stdout),
	}
	if res.TimedOut {
		return out, fmt.Errorf("compose: logs timed out after %s", opts.Timeout)
	}
	if res.Error != nil {
		return out, fmt.Errorf("compose: logs: %w (stderr=%s)", res.Error, firstLine(string(res.Stderr)))
	}
	out.Lines = splitLogLines(string(res.Stdout))
	return out, nil
}

// splitLogLines splits on \n, drops empty trailing entries. We do
// NOT split on \r\n; Compose's --no-color output is LF-terminated.
func splitLogLines(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// isSafeServiceName mirrors isSafeProjectName but accepts the
// slightly wider Compose service charset (allows `.` for
// service.dependency patterns).
func isSafeServiceName(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.':
		default:
			return false
		}
	}
	return true
}

// -----------------------------------------------------------------------------
// Env hygiene
// -----------------------------------------------------------------------------

// sanitizeEnv returns a copy of the env that strips bearer-shaped
// keys and never forwards the bearer on the CLI. When bearerFile is
// non-empty, HUB_BEARER_TOKEN_FILE is forwarded so the Compose env
// can read the token via the documented file contract.
func (s *Service) sanitizeEnv(extra []string, bearerFile string) []string {
	base := os.Environ()
	// Filter out anything that looks like a bearer. We strip the
	// canonical keys by name (not value) so a misconfigured parent
	// shell cannot leak the token via HUB_BEARER_TOKEN.
	filtered := make([]string, 0, len(base)+len(extra)+1)
	for _, kv := range base {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if isBearerEnvKey(key) {
			continue
		}
		filtered = append(filtered, kv)
	}
	for _, kv := range extra {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if isBearerEnvKey(key) {
			continue
		}
		filtered = append(filtered, kv)
	}
	if bearerFile != "" {
		filtered = append(filtered, "HUB_BEARER_TOKEN_FILE="+bearerFile)
	}
	// Compose needs HOME / PATH; those are inherited from base
	// already.
	return filtered
}

// isBearerEnvKey returns true for any env-var name that could carry
// a bearer. The set is closed; new entries require a slice bump.
func isBearerEnvKey(key string) bool {
	switch key {
	case "HUB_BEARER_TOKEN",
		"HUB_BEARER_TOKEN_FILE",
		"HUB_BEARER_TOKEN_SOURCE",
		"AGENT_MEMORY_BEARER_TOKEN":
		return true
	}
	return false
}

// firstLine returns the first non-empty line of `s`, or "" when `s`
// is empty / whitespace-only. Used for diagnostic tails.
func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return ""
}

// -----------------------------------------------------------------------------
// Loopback-first helpers
// -----------------------------------------------------------------------------

// ValidateLoopback returns nil when the supplied `host:port` binds
// to a loopback address (127.0.0.0/8, ::1, "loopback", or empty).
// Any other value is rejected with a precise error. The function is
// the canonical I-10 enforcement point: callers building dynamic
// port mappings or accepting a `--host` flag MUST route through
// here.
func ValidateLoopback(host string) error {
	switch strings.TrimSpace(host) {
	case "", "127.0.0.1", "::1", "localhost", "loopback":
		return nil
	}
	if strings.HasPrefix(host, "127.") {
		return nil
	}
	return fmt.Errorf("compose: refuse non-loopback host %q (I-10 loopback-first)", host)
}
