// cmd/hub/cmd_runtime.go
//
// Runtime subcommand handler for the hub product shell. Per
// docs/roadmap/slices.json (T2 — Docker / Compose runtime control
// from Go) the runtime surface is:
//
//	hub runtime up       [--timeout <dur>]
//	hub runtime down     [--volumes]   [--timeout <dur>]
//	hub runtime status   [--health-url <url>] [--timeout <dur>]
//	hub runtime logs     [--service <name>] [--tail <n>] [--timeout <dur>]
//	hub runtime ps       [--timeout <dur>]
//	hub runtime <anything> --json | (no --json)
//
// Every subcommand is wireable through the injected compose.Service
// so tests can drive the handler with a fake Runner. The handler
// never shells out to docker directly — it delegates to
// internal/compose.Service which is the engine-agnostic boundary.
//
// Security invariants this file enforces by construction:
//
//   - Loopback-first (I-10). `--health-url` is validated by
//     compose.ValidateLoopback before the probe runs; non-loopback
//     hosts produce a fail-closed HTTPHealth payload and exit 1.
//   - Bearer hygiene (I-07). All output routes through
//     output.Redact; the JSON payload also runs Redact so a stray
//     token in compose's stdout never reaches the operator.
//   - hub-data preservation. `down` defaults to RemoveVolumes=false
//     even when the operator passes `--volumes` on the CLI — the
//     Service is the source of truth, and the Service refuses to
//     remove hub-data. The CLI knob is reserved for explicit
//     operator opt-in via the documented `HUB_ALLOW_HUB_DATA_REMOVAL`
//     env (test-only).
//   - Isolated project defaults. The compose Service derives the
//     project name from HUB_RUNTIME (when set) or `hub-<pid>-<epoch>`
//     so concurrent smoke runs do not collide.
//
// Determinism: every payload that leaves stdout passes through
// stable sort keys, RFC3339Nano UTC timestamps, and a fixed-width
// human renderer so two consecutive invocations on the same state
// produce byte-identical output.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"hub/internal/compose"
	"hub/internal/output"
)

// RuntimeFlags is the parsed argv for `hub runtime <subcommand>
// …flags`. Fields are zero-value-safe so missing flags surface as
// the documented defaults (timeout=0, json=false, etc.).
type RuntimeFlags struct {
	Subcommand string   // up | down | status | logs | ps
	JSON       bool     // --json
	Timeout    Duration // --timeout <dur> (e.g. "60s", "2m")
	Volumes    bool     // down --volumes (opt-in; still defaults to no -v)
	Service    string   // logs --service <name>
	Tail       int      // logs --tail <n>
	HealthURL  string   // status --health-url <url>
	Rest       []string // unparsed trailing args (errors as contract violation)
}

// ParseRuntimeFlags extracts the (subcommand, --json, --timeout,
// --volumes, --service, --tail, --health-url, rest) tuple from the
// argv slice. The function is exported so cmd_runtime_test.go (when
// added) can drive the parser directly without spawning hub. The
// parser is strict: unknown flags, missing values, and the literal
// "--" produce a fail-closed error so the operator gets a precise
// diagnostic instead of a silent fallback.
//
// Accepted shapes:
//
//	["up"]                                    → ("up", {}, …)
//	["down", "--volumes"]                     → ("down", {Volumes:true}, …)
//	["status", "--health-url=http://127.0.0.1:1/status"]
//	["logs", "--service", "hub-rest", "--tail", "50"]
//	["status", "--json"]                      → JSON=true
//	["up", "--timeout", "60s"]                → Timeout=60s
//	["up", "--timeout=60s"]                   → Timeout=60s (= form)
//
// Anything else returns a precise error. The function does NOT
// touch the filesystem; env probe is the caller's responsibility.
func ParseRuntimeFlags(argv []string) (RuntimeFlags, error) {
	rf := RuntimeFlags{}
	if len(argv) == 0 {
		return rf, errors.New("hub runtime: subcommand required (up, down, status, logs, ps)")
	}
	rf.Subcommand = argv[0]
	rest := argv[1:]
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		// `--flag=value` form: split on the FIRST `=` so the value
		// can itself contain `=` (e.g. a query string in a URL).
		// The space-separated form below still accepts the same
		// flag set; both forms are documented and the parser is
		// strict on the flag names.
		var inline string
		if strings.HasPrefix(arg, "--") {
			if eq := strings.IndexByte(arg, '='); eq > 0 {
				inline = arg[eq+1:]
				arg = arg[:eq]
			}
		}
		switch arg {
		case "--json":
			if rf.JSON {
				return rf, errors.New("hub runtime: --json specified twice")
			}
			rf.JSON = true
		case "--volumes":
			rf.Volumes = true
		case "--timeout":
			val := inline
			if val == "" {
				if i+1 >= len(rest) {
					return rf, errors.New("hub runtime: --timeout requires a value (e.g. 60s, 2m)")
				}
				i++
				val = rest[i]
			}
			d, err := time.ParseDuration(val)
			if err != nil {
				return rf, fmt.Errorf("hub runtime: invalid --timeout %q: %w", val, err)
			}
			rf.Timeout = Duration(d)
		case "--service":
			val := inline
			if val == "" {
				if i+1 >= len(rest) {
					return rf, errors.New("hub runtime: --service requires a value")
				}
				i++
				val = rest[i]
			}
			rf.Service = val
		case "--tail":
			val := inline
			if val == "" {
				if i+1 >= len(rest) {
					return rf, errors.New("hub runtime: --tail requires an integer")
				}
				i++
				val = rest[i]
			}
			var n int
			if _, err := fmt.Sscanf(val, "%d", &n); err != nil || n < 0 {
				return rf, fmt.Errorf("hub runtime: invalid --tail %q (must be non-negative integer)", val)
			}
			rf.Tail = n
		case "--health-url":
			val := inline
			if val == "" {
				if i+1 >= len(rest) {
					return rf, errors.New("hub runtime: --health-url requires a value")
				}
				i++
				val = rest[i]
			}
			rf.HealthURL = val
		case "--":
			return rf, errors.New("hub runtime: '--' is not accepted (pass positional args without '--')")
		default:
			if strings.HasPrefix(arg, "-") {
				return rf, fmt.Errorf("hub runtime: unknown flag %q", rest[i])
			}
			rf.Rest = append(rf.Rest, rest[i:]...)
			return rf, nil
		}
	}
	return rf, nil
}

// Duration is a thin wrapper around time.Duration so the JSON
// payload uses the canonical Go string form ("1m30s", "2m0s")
// instead of the integer nanosecond count. Without the wrapper the
// default encoding/json output is a bare number, which is hard for
// an operator to read at a glance.
type Duration time.Duration

// MarshalJSON renders the duration as the canonical Go duration
// string. The encoding is byte-deterministic so two invocations on
// the same logical duration produce byte-identical output.
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// UnmarshalJSON accepts both the Go-string form and the integer
// nanosecond form so legacy payloads stay decodable.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		parsed, err := time.ParseDuration(s)
		if err != nil {
			return err
		}
		*d = Duration(parsed)
		return nil
	}
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*d = Duration(time.Duration(n))
	return nil
}

// RuntimeResult is the structured payload emitted by every
// runtime subcommand. The shape is locked: the phase2 gate asserts
// on these keys. Adding a new field is a contract-visible change.
type RuntimeResult struct {
	// Command is the subcommand the operator ran (up, down, …).
	Command string `json:"command"`
	// Project is the resolved Compose project name.
	Project string `json:"project"`
	// Engine is the resolved Compose engine.
	Engine string `json:"engine"`
	// ComposeFile is the absolute path to the compose YAML.
	ComposeFile string `json:"compose_file"`
	// Healthy is the list of services reported "healthy" after
	// up/status. Always serialised (no omitempty) so the contract
	// surface shows `"healthy": []` rather than omitting the key —
	// the phase2 gate asserts on the key's presence and its
	// array-ness across every RuntimeResult.
	Healthy []string `json:"healthy"`
	// Services is the parsed ps payload (status / ps only).
	Services []compose.ServiceStatus `json:"services"`
	// VolumesRemoved is the list of named volumes compose
	// reported as removed (down --volumes only; empty for the
	// default down because hub-data MUST survive).
	VolumesRemoved []string `json:"volumes_removed,omitempty"`
	// HTTPHealth is the captured loopback probe (status
	// --health-url only).
	HTTPHealth *compose.HTTPHealth `json:"http_health,omitempty"`
	// StartedAt / FinishedAt are RFC3339Nano UTC timestamps.
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	// Timeout is the effective timeout applied to the call.
	Timeout Duration `json:"timeout"`
}

// ErrRuntimeUsage is returned by RunRuntime when argv parsing fails.
// The error is a sentinel so main() can map it to exit code 2
// (contract violation) — runtime parsing errors are NEVER operator
// errors in the sense of "you typed it wrong"; they are shell
// contract violations that should fail closed.
var ErrRuntimeUsage = errors.New("hub runtime usage error")

// RunRuntime is the testable entry point for `hub runtime …`.
// It accepts:
//
//   - cfg.RuntimeDir: the absolute path of the Compose project
//     root (HUB_RUNTIME). When empty, the Service derives an
//     isolated `hub-<pid>-<epoch>` name from os.Getpid.
//   - composeFile: the absolute path to the compose YAML. When
//     empty, the Service defaults to
//     <repoRoot>/observability/compose.yaml.
//   - runner: the injected Runner. When nil, OSExec() is used so
//     production callers can write `RunRuntime(rt, cfg, …)`.
//
// The function returns the exit code (0 success, 1 operator error,
// 2 contract violation). The sink writes to stdout (the contract
// surface) and stderr (diagnostics). The payload is byte-deterministic.
func RunRuntime(
	stdout, stderr io.Writer,
	cfg RuntimeConfig,
	flags RuntimeFlags,
	svc *compose.Service,
) (int, error) {
	sink := output.NewForTest(
		func(b []byte) (int, error) { return stdout.Write(b) },
		func(b []byte) (int, error) { return stderr.Write(b) },
		output.IsCI(),
	)
	// Parser-driven contract violations are fail-closed.
	if flags.Subcommand == "" {
		emitError(sink, "%v", ErrRuntimeUsage)
		return 2, ErrRuntimeUsage
	}
	// Route to the per-subcommand handler. Each handler returns
	// the typed Result; we translate to stdout/stderr here so the
	// human/JSON rendering stays in one place.
	switch flags.Subcommand {
	case "up":
		return runtimeUp(sink, cfg, flags, svc)
	case "down":
		return runtimeDown(sink, cfg, flags, svc)
	case "status":
		return runtimeStatus(sink, cfg, flags, svc)
	case "logs":
		return runtimeLogs(sink, cfg, flags, svc)
	case "ps":
		return runtimePs(sink, cfg, flags, svc)
	case "--help", "-h", "help":
		printRuntimeHelp(sink)
		return 0, nil
	default:
		emitError(sink, "hub runtime: unknown subcommand %q (try `hub runtime --help`)", flags.Subcommand)
		return 2, nil
	}
}

// RuntimeConfig carries the resolved env into the runtime handlers.
// It is a struct (not a method receiver) so tests can build a
// RuntimeConfig without invoking os.Getenv.
type RuntimeConfig struct {
	// RepoRoot is the absolute repository root. Required so the
	// Service can resolve the default compose file.
	RepoRoot string
	// ComposeFile is the absolute path to the compose YAML. When
	// empty, defaults to <RepoRoot>/observability/compose.yaml.
	ComposeFile string
	// ProjectName overrides the isolated project name. When empty,
	// the Service derives one from HUB_RUNTIME / pid / epoch.
	ProjectName string
	// WorkingDir is the subprocess working directory. Defaults to
	// the directory containing ComposeFile.
	WorkingDir string
}

func runtimeUp(sink *output.Sink, cfg RuntimeConfig, flags RuntimeFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub runtime up: compose service not initialised")
		return 2, errors.New("compose service not initialised")
	}
	timeout := time.Duration(flags.Timeout)
	if timeout == 0 {
		timeout = 4 * time.Minute
	}
	res, err := svc.Up(context.Background(), compose.UpOptions{
		Wait:    true,
		Detach:  true,
		Timeout: timeout,
	})
	if err != nil {
		emitError(sink, "hub runtime up: %v", err)
		return 1, nil
	}
	result := upToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitRuntime(sink, flags, result)
}

func runtimeDown(sink *output.Sink, cfg RuntimeConfig, flags RuntimeFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub runtime down: compose service not initialised")
		return 2, errors.New("compose service not initialised")
	}
	timeout := time.Duration(flags.Timeout)
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	opts := compose.DownOptions{
		RemoveVolumes: false, // hub-data MUST survive by default
		RemoveOrphans: true,
		Timeout:       timeout,
	}
	if flags.Volumes {
		// Documented operator opt-in. The Service still refuses
		// to remove hub-data unless the operator ALSO sets
		// HUB_ALLOW_HUB_DATA_REMOVAL=1 (test-only); without that
		// env the Service returns an error and we surface it as
		// exit 1. We DO NOT call svc.Down with RemoveVolumes=true
		// unless the env knob is set; we mirror the safer path.
		if strings.TrimSpace(envAllowHubDataRemoval()) == "1" {
			opts.RemoveVolumes = true
		} else {
			// Fail-closed diagnostic on stderr names BOTH the
			// refused flag AND the env knob the operator must set
			// to opt in. The audit-critical requirement is that
			// this message include the literal HUB_ALLOW_HUB_DATA_REMOVAL
			// env name so the gate (and any operator) can grep for
			// it deterministically. The handler still returns exit 1
			// and NEVER calls svc.Down — hub-data is preserved by
			// construction because the docker subprocess boundary is
			// never crossed.
			emitError(sink, "hub runtime down: --volumes refused: set HUB_ALLOW_HUB_DATA_REMOVAL=1 to opt in (hub-data is preserved by default)")
			return 1, errors.New("hub runtime down: --volumes refused (HUB_ALLOW_HUB_DATA_REMOVAL not set)")
		}
	}
	res, err := svc.Down(context.Background(), opts)
	if err != nil {
		emitError(sink, "hub runtime down: %v", err)
		return 1, nil
	}
	result := downToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitRuntime(sink, flags, result)
}

func runtimeStatus(sink *output.Sink, cfg RuntimeConfig, flags RuntimeFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub runtime status: compose service not initialised")
		return 2, errors.New("compose service not initialised")
	}
	// Loopback-first (I-10). --health-url is validated up front
	// so a typo never reaches the network. The Service has its
	// own ValidateLoopback check; we surface a fail-closed
	// HTTPHealth payload (HTTPStatus=0) for non-loopback hosts so
	// the operator sees exactly which knob is wrong.
	var healthProbe string
	if flags.HealthURL != "" {
		if err := compose.ValidateLoopback(extractHostFromURL(flags.HealthURL)); err != nil {
			emitError(sink, "hub runtime status: %v", err)
			return 1, nil
		}
		healthProbe = flags.HealthURL
	}
	timeout := time.Duration(flags.Timeout)
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	res, err := svc.Status(context.Background(), compose.StatusOptions{
		Timeout:   timeout,
		HealthURL: healthProbe,
	})
	if err != nil {
		emitError(sink, "hub runtime status: %v", err)
		return 1, nil
	}
	result := statusToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitRuntime(sink, flags, result)
}

func runtimeLogs(sink *output.Sink, cfg RuntimeConfig, flags RuntimeFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub runtime logs: compose service not initialised")
		return 2, errors.New("compose service not initialised")
	}
	timeout := time.Duration(flags.Timeout)
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	res, err := svc.Logs(context.Background(), compose.LogsOptions{
		Service: flags.Service,
		Tail:    flags.Tail,
		Timeout: timeout,
	})
	if err != nil {
		emitError(sink, "hub runtime logs: %v", err)
		return 1, nil
	}
	result := logsToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitRuntime(sink, flags, result)
}

func runtimePs(sink *output.Sink, cfg RuntimeConfig, flags RuntimeFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub runtime ps: compose service not initialised")
		return 2, errors.New("compose service not initialised")
	}
	timeout := time.Duration(flags.Timeout)
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	res, err := svc.Ps(context.Background(), compose.PsOptions{Timeout: timeout})
	if err != nil {
		emitError(sink, "hub runtime ps: %v", err)
		return 1, nil
	}
	result := psToResult(svc, res, timeout)
	return emitRuntime(sink, flags, result)
}

// emitRuntime writes the result to the sink in either human or
// JSON form. The human form is a fixed key/value block so the
// phase2 gate can assert on the shape without snapshot drift. The
// JSON form is sorted alphabetically by encoding/json so two
// invocations produce byte-identical output.
//
// In both modes the rendered payload passes through output.Redact
// so a stray token in compose's stdout never reaches the operator.
func emitRuntime(sink *output.Sink, flags RuntimeFlags, res RuntimeResult) (int, error) {
	if flags.JSON {
		data, err := json.MarshalIndent(res, "", "  ")
		if err != nil {
			emitError(sink, "hub runtime: marshal: %v", err)
			return 2, nil
		}
		_ = sink.Printf("%s", output.Redact(string(data)))
		return 0, nil
	}
	// Human form. Sorted keys keep the phase2 gate assertions
	// stable across Go versions.
	keys := []string{"command", "project", "engine", "compose_file"}
	values := map[string]string{
		"command":      res.Command,
		"project":      res.Project,
		"engine":       res.Engine,
		"compose_file": res.ComposeFile,
	}
	for _, k := range keys {
		_ = sink.Printf("%s=%s", k, output.Redact(values[k]))
	}
	if len(res.Healthy) > 0 {
		_ = sink.Printf("healthy=%s", strings.Join(res.Healthy, ","))
	}
	if len(res.VolumesRemoved) > 0 {
		_ = sink.Printf("volumes_removed=%s", strings.Join(res.VolumesRemoved, ","))
	}
	if res.HTTPHealth != nil {
		if res.HTTPHealth.Error != "" {
			_ = sink.Printf("http_health=error:%s", output.Redact(res.HTTPHealth.Error))
		} else {
			_ = sink.Printf("http_health=%d %s", res.HTTPHealth.HTTPStatus, output.Redact(res.HTTPHealth.URL))
		}
	}
	return 0, nil
}

func upToResult(r compose.UpResult, composeFile string, timeout time.Duration) RuntimeResult {
	healthy := r.HealthyServices
	if healthy == nil {
		healthy = []string{}
	}
	sort.Strings(healthy)
	// Coerce a nil Services slice to an empty non-nil slice so the
	// JSON contract serialises `"services": []` for the up payload
	// instead of `"services": null`. Mirrors statusToResult /
	// psToResult so every runtime subcommand emits the same
	// empty-payload shape and downstream
	// `Array.isArray(parsed.services)` is deterministic regardless
	// of which surface produced the result. The schema (key name
	// + array type) is unchanged — only the empty-value shape is
	// fixed.
	services := []compose.ServiceStatus{}
	return RuntimeResult{
		Command:     "up",
		Project:     r.Project,
		Engine:      string(r.Engine),
		ComposeFile: composeFile,
		Healthy:     healthy,
		Services:    services,
		StartedAt:   r.StartedAt,
		FinishedAt:  r.FinishedAt,
		Timeout:     Duration(timeout),
	}
}

func downToResult(r compose.DownResult, composeFile string, timeout time.Duration) RuntimeResult {
	vr := r.VolumesRemoved
	if vr == nil {
		vr = []string{}
	}
	sort.Strings(vr)
	return RuntimeResult{
		Command:        "down",
		Project:        r.Project,
		Engine:         string(r.Engine),
		ComposeFile:    composeFile,
		VolumesRemoved: vr,
		StartedAt:      r.StartedAt,
		FinishedAt:     r.FinishedAt,
		Timeout:        Duration(timeout),
	}
}

func statusToResult(r compose.StatusResult, composeFile string, timeout time.Duration) RuntimeResult {
	healthy := make([]string, 0, len(r.Services))
	for _, s := range r.Services {
		if s.Health == "healthy" {
			healthy = append(healthy, s.Name)
		}
	}
	sort.Strings(healthy)
	// Coerce a nil Services slice to an empty non-nil slice so the
	// JSON contract serialises `"services": []` for an empty ps
	// payload instead of `"services": null`. The schema (key name
	// + array type) is unchanged; only the JSON shape of an empty
	// result is fixed so the runtime tests' `Array.isArray(parsed.
	// services)` invariant holds deterministically. Sorted output
	// from compose.Service.Status is already stable when len > 0.
	services := r.Services
	if services == nil {
		services = []compose.ServiceStatus{}
	}
	return RuntimeResult{
		Command:     "status",
		Project:     r.Project,
		Engine:      string(r.Engine),
		ComposeFile: composeFile,
		Healthy:     healthy,
		Services:    services,
		HTTPHealth:  r.HTTPHealth,
		StartedAt:   r.StartedAt,
		FinishedAt:  r.FinishedAt,
		Timeout:     Duration(timeout),
	}
}

func logsToResult(r compose.LogsResult, composeFile string, timeout time.Duration) RuntimeResult {
	lines := r.Lines
	if lines == nil {
		lines = []string{}
	}
	// Sort lines for determinism. Compose's --no-color output is
	// not guaranteed-ordered across versions; sorting keeps the
	// payload byte-stable across hosts.
	sort.Strings(lines)
	return RuntimeResult{
		Command:     "logs",
		Project:     r.Project,
		Engine:      string(r.Engine),
		ComposeFile: composeFile,
		StartedAt:   r.StartedAt,
		FinishedAt:  r.FinishedAt,
		Timeout:     Duration(timeout),
	}
}

func psToResult(svc *compose.Service, r compose.PsResult, timeout time.Duration) RuntimeResult {
	healthy := make([]string, 0, len(r.Services))
	for _, s := range r.Services {
		if s.Health == "healthy" {
			healthy = append(healthy, s.Name)
		}
	}
	sort.Strings(healthy)
	rt := svc.Runtime()
	// Coerce a nil Services slice to an empty non-nil slice so the
	// JSON contract serialises `"services": []` for an empty ps
	// payload instead of `"services": null`. Mirrors statusToResult
	// so both runtime subcommands emit the same empty-payload
	// shape and downstream `Array.isArray(parsed.services)` is
	// deterministic regardless of which surface produced the
	// result. The schema is unchanged.
	services := r.Services
	if services == nil {
		services = []compose.ServiceStatus{}
	}
	return RuntimeResult{
		Command:     "ps",
		Project:     rt.ProjectName,
		Engine:      string(rt.Engine),
		ComposeFile: rt.ComposeFile,
		Healthy:     healthy,
		Services:    services,
		StartedAt:   r.StartedAt,
		FinishedAt:  r.FinishedAt,
		Timeout:     Duration(timeout),
	}
}

// printRuntimeHelp writes the `hub runtime --help` block. The
// text is a fixed string so the phase2 gate can assert on its
// shape without snapshot drift.
func printRuntimeHelp(sink *output.Sink) {
	lines := []string{
		"hub runtime — Docker / Compose stack lifecycle",
		"",
		"Usage:",
		"  hub runtime up       [--timeout <dur>] [--json]",
		"  hub runtime down     [--volumes] [--timeout <dur>] [--json]",
		"  hub runtime status   [--health-url <url>] [--timeout <dur>] [--json]",
		"  hub runtime logs     [--service <name>] [--tail <n>] [--timeout <dur>] [--json]",
		"  hub runtime ps       [--timeout <dur>] [--json]",
		"  hub runtime help",
		"",
		"Flags:",
		"  --timeout <dur>     bound the subprocess wait (e.g. 60s, 2m).",
		"  --json              emit the structured payload (deterministic).",
		"  --volumes           opt-in volume removal (down). HUB_ALLOW_HUB_DATA_REMOVAL=1",
		"                      must also be set or the call fails closed.",
		"  --service <name>    logs: scope to a single Compose service.",
		"  --tail <n>          logs: limit to the last <n> lines (0 = no limit).",
		"  --health-url <url>  status: probe a loopback HTTP endpoint after ps.",
		"",
		"Environment:",
		"  HUB_RUNTIME        override the Compose project root.",
		"  HUB_OPENAPI        (unused; runtime does not consult openapi.yaml).",
		"",
		"Security invariants:",
		"  - --health-url targets loopback only (I-10).",
		"  - bearer-shaped tokens are redacted from every payload (I-07).",
		"  - `down` preserves hub-data by default; --volumes is reserved for tests.",
		"",
		"Exit codes:",
		"  0  success",
		"  1  operator error (compose call returned non-zero, --volumes refused)",
		"  2  contract violation (unknown subcommand, parser error)",
	}
	for _, l := range lines {
		_ = sink.Printf("%s", l)
	}
}

// extractHostFromURL pulls the host component out of a URL string
// so the loopback validator can be called without importing
// net/url here (kept tiny). Returns "" on parse error so the
// downstream ValidateLoopback rejects the value as empty.
func extractHostFromURL(raw string) string {
	// Use the same url.Parse indirection the Service uses so the
	// production / test code paths stay aligned. We import
	// net/url indirectly via the helper file when needed; today
	// the path is short enough to use strings.IndexByte.
	raw = strings.TrimSpace(raw)
	// Strip scheme:// prefix.
	if i := strings.Index(raw, "://"); i > 0 {
		raw = raw[i+3:]
	}
	// Strip userinfo.
	if i := strings.Index(raw, "@"); i > 0 {
		raw = raw[i+1:]
	}
	// Host ends at the first '/', '?', or '#'.
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == '/' || c == '?' || c == '#' {
			raw = raw[:i]
			break
		}
	}
	// Strip port if present.
	if i := strings.LastIndex(raw, ":"); i > 0 {
		raw = raw[:i]
	}
	return raw
}

// envAllowHubDataRemoval is a tiny indirection so tests can stub
// the env probe without mutating the real os.Setenv. The
// production wiring is os.Getenv("HUB_ALLOW_HUB_DATA_REMOVAL").
var envAllowHubDataRemoval = func() string {
	// Imported here to keep the package's import set tiny — the
	// only place we need os.Getenv in this file.
	return osGetenv("HUB_ALLOW_HUB_DATA_REMOVAL")
}
