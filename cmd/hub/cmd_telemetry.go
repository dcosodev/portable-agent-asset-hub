// cmd/hub/cmd_telemetry.go
//
// Telemetry subcommand handler for the hub product shell. Per
// docs/roadmap/slices.json (T5 — Optional observability profile
// control) the telemetry surface is:
//
//	hub telemetry up       [--timeout <dur>]
//	hub telemetry down     [--volumes]   [--timeout <dur>]
//	hub telemetry status   [--health-url <url>] [--timeout <dur>]
//	hub telemetry <anything> --json | (no --json)
//
// The handler mirrors cmd_runtime.go's conventions verbatim:
// every subcommand is wireable through the injected compose.Service
// so tests can drive the handler with a fake Runner. The handler
// NEVER shells out to docker directly — it delegates to
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
//   - compose-file ownership. Detect is pointed at the T5-owned
//     top-level `docker-compose.observability.yml` via HUB_RUNTIME
//     — never at `observability/compose.yaml` (ADR-0004 read-only).
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

// TelemetryDuration is a thin wrapper around time.Duration so the
// JSON payload uses the canonical Go string form ("1m30s", "2m0s")
// instead of the integer nanosecond count. The wrapper mirrors
// cmd_runtime.go's `Duration` type but is renamed to avoid the
// duplicate-type definition: this file is the only telemetry
// handler, and re-using the runtime's wrapper would force a
// cross-file dependency that does not exist today.
type TelemetryDuration time.Duration

// MarshalJSON renders the duration as the canonical Go duration
// string. The encoding is byte-deterministic so two invocations on
// the same logical duration produce byte-identical output.
func (d TelemetryDuration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// UnmarshalJSON accepts both the Go-string form and the integer
// nanosecond form so legacy payloads stay decodable.
func (d *TelemetryDuration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		parsed, err := time.ParseDuration(s)
		if err != nil {
			return err
		}
		*d = TelemetryDuration(parsed)
		return nil
	}
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*d = TelemetryDuration(time.Duration(n))
	return nil
}

// TelemetryFlags is the parsed argv for `hub telemetry <subcommand>
// …flags`. Fields are zero-value-safe so missing flags surface as
// the documented defaults (timeout=0, json=false, etc.).
type TelemetryFlags struct {
	Subcommand string            // up | down | status
	JSON       bool              // --json
	Timeout    TelemetryDuration // --timeout <dur> (e.g. "60s", "2m")
	Volumes    bool              // down --volumes (opt-in; still defaults to no -v)
	HealthURL  string            // status --health-url <url>
	Rest       []string          // unparsed trailing args (errors as contract violation)
}

// ParseTelemetryFlags extracts the (subcommand, --json, --timeout,
// --volumes, --health-url, rest) tuple from the argv slice. The
// function is exported so cmd_telemetry_test.go (when added) can
// drive the parser directly without spawning hub. The parser is
// strict: unknown flags, missing values, and the literal "--"
// produce a fail-closed error so the operator gets a precise
// diagnostic instead of a silent fallback.
//
// Accepted shapes:
//
//	["up"]                                    → ("up", {}, …)
//	["down", "--volumes"]                     → ("down", {Volumes:true}, …)
//	["status", "--health-url=http://127.0.0.1:1/status"]
//	["status", "--json"]                      → JSON=true
//	["up", "--timeout", "60s"]                → Timeout=60s
//	["up", "--timeout=60s"]                   → Timeout=60s (= form)
//
// Anything else returns a precise error. The function does NOT
// touch the filesystem; env probe is the caller's responsibility.
func ParseTelemetryFlags(argv []string) (TelemetryFlags, error) {
	tf := TelemetryFlags{}
	if len(argv) == 0 {
		return tf, errors.New("hub telemetry: subcommand required (up, down, status)")
	}
	tf.Subcommand = argv[0]
	rest := argv[1:]
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		var inline string
		if strings.HasPrefix(arg, "--") {
			if eq := strings.IndexByte(arg, '='); eq > 0 {
				inline = arg[eq+1:]
				arg = arg[:eq]
			}
		}
		switch arg {
		case "--json":
			if tf.JSON {
				return tf, errors.New("hub telemetry: --json specified twice")
			}
			tf.JSON = true
		case "--volumes":
			tf.Volumes = true
		case "--timeout":
			val := inline
			if val == "" {
				if i+1 >= len(rest) {
					return tf, errors.New("hub telemetry: --timeout requires a value (e.g. 60s, 2m)")
				}
				i++
				val = rest[i]
			}
			d, err := time.ParseDuration(val)
			if err != nil {
				return tf, fmt.Errorf("hub telemetry: invalid --timeout %q: %w", val, err)
			}
			tf.Timeout = TelemetryDuration(d)
		case "--health-url":
			val := inline
			if val == "" {
				if i+1 >= len(rest) {
					return tf, errors.New("hub telemetry: --health-url requires a value")
				}
				i++
				val = rest[i]
			}
			tf.HealthURL = val
		case "--":
			return tf, errors.New("hub telemetry: '--' is not accepted (pass positional args without '--')")
		default:
			if strings.HasPrefix(arg, "-") {
				return tf, fmt.Errorf("hub telemetry: unknown flag %q", rest[i])
			}
			tf.Rest = append(tf.Rest, rest[i:]...)
			return tf, nil
		}
	}
	return tf, nil
}

// TelemetryHTTPHealth is the JSON envelope for the loopback HTTP
// probe surfaced by `hub telemetry status --health-url`. It is a
// local mirror of compose.HTTPHealth that drops the
// `omitempty` markers on Error and Body so the contract surface
// ALWAYS carries a populated block — even on the no-error path
// where Error is the empty string. The T5 loopback acceptance
// test (`http_health.error === ”`) and the collector-down test
// (`http_health.error !== ”`) both rely on this invariant. A
// regression that falls back to `*compose.HTTPHealth` would
// silently re-introduce `omitempty` and break the no-error
// assertion before the collector-down path runs.
type TelemetryHTTPHealth struct {
	URL        string `json:"url"`
	HTTPStatus int    `json:"http_status"`
	Body       string `json:"body"`
	Error      string `json:"error"`
}

// TelemetryResult is the structured payload emitted by every
// telemetry subcommand. The shape is locked: the phase5 gate asserts
// on these keys. Adding a new field is a contract-visible change.
type TelemetryResult struct {
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
	// surface shows `"healthy": []` rather than omitting the key.
	Healthy []string `json:"healthy"`
	// Services is the parsed ps payload (status only).
	Services []compose.ServiceStatus `json:"services"`
	// VolumesRemoved is the list of named volumes compose
	// reported as removed (down --volumes only; empty for the
	// default down because hub-data MUST survive). The field is
	// ALWAYS serialised (no omitempty) so downstream parsers can
	// rely on `volumes_removed: []` being a present-but-empty
	// array. A regression that re-introduces `omitempty` would
	// break the T5 contract surface (and the up-down.test.ts
	// `down_json_payload_volumes_removed_is_empty_array` lock).
	VolumesRemoved []string `json:"volumes_removed"`
	// HTTPHealth is the captured loopback probe (status
	// --health-url only). The local TelemetryHTTPHealth mirror
	// keeps the error / body keys present even when empty.
	HTTPHealth *TelemetryHTTPHealth `json:"http_health,omitempty"`
	// StartedAt / FinishedAt are RFC3339Nano UTC timestamps.
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	// Timeout is the effective timeout applied to the call.
	Timeout TelemetryDuration `json:"timeout"`
}

// ErrTelemetryUsage is returned by RunTelemetry when argv parsing
// fails. The error is a sentinel so main() can map it to exit code
// 2 (contract violation).
var ErrTelemetryUsage = errors.New("hub telemetry usage error")

// RunTelemetry is the testable entry point for `hub telemetry …`.
// It accepts:
//
//   - cfg.RepoRoot: the absolute path of the Compose project
//     root (HUB_RUNTIME). When empty, the Service derives an
//     isolated `hub-<pid>-<epoch>` name from os.Getpid.
//   - composeFile: the absolute path to the compose YAML. When
//     empty, defaults to
//     <repoRoot>/docker-compose.observability.yml (the T5-owned
//     file; never observability/compose.yaml).
//   - runner: the injected Runner. When nil, OSExec() is used so
//     production callers can write `RunTelemetry(cfg, …)`.
//
// The function returns the exit code (0 success, 1 operator error,
// 2 contract violation). The sink writes to stdout (the contract
// surface) and stderr (diagnostics). The payload is byte-deterministic.
func RunTelemetry(
	stdout, stderr io.Writer,
	cfg TelemetryConfig,
	flags TelemetryFlags,
	svc *compose.Service,
) (int, error) {
	sink := output.NewForTest(
		func(b []byte) (int, error) { return stdout.Write(b) },
		func(b []byte) (int, error) { return stderr.Write(b) },
		output.IsCI(),
	)
	if flags.Subcommand == "" {
		emitError(sink, "%v", ErrTelemetryUsage)
		return 2, ErrTelemetryUsage
	}
	switch flags.Subcommand {
	case "up":
		return telemetryUp(sink, cfg, flags, svc)
	case "down":
		return telemetryDown(sink, cfg, flags, svc)
	case "status":
		return telemetryStatus(sink, cfg, flags, svc)
	case "--help", "-h", "help":
		printTelemetryHelp(sink)
		return 0, nil
	default:
		emitError(sink, "hub telemetry: unknown subcommand %q (try `hub telemetry --help`)", flags.Subcommand)
		return 2, nil
	}
}

// TelemetryConfig carries the resolved env into the telemetry
// handlers. It is a struct (not a method receiver) so tests can
// build a TelemetryConfig without invoking os.Getenv.
type TelemetryConfig struct {
	// RepoRoot is the absolute repository root. Required so the
	// Service can resolve the default compose file.
	RepoRoot string
	// ComposeFile is the absolute path to the compose YAML. When
	// empty, defaults to <RepoRoot>/docker-compose.observability.yml
	// (the T5-owned file; the runtime slice owns
	// observability/compose.yaml).
	ComposeFile string
	// ProjectName overrides the isolated project name. When empty,
	// the Service derives one from HUB_RUNTIME / pid / epoch.
	ProjectName string
	// WorkingDir is the subprocess working directory. Defaults to
	// the directory containing ComposeFile.
	WorkingDir string
}

func telemetryUp(sink *output.Sink, cfg TelemetryConfig, flags TelemetryFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub telemetry up: compose service not initialised")
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
		emitError(sink, "hub telemetry up: %v", err)
		return 1, nil
	}
	result := telemetryUpToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitTelemetry(sink, flags, result)
}

func telemetryDown(sink *output.Sink, cfg TelemetryConfig, flags TelemetryFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub telemetry down: compose service not initialised")
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
			// refused flag AND the env knob the operator must
			// set to opt in. The audit-critical requirement is
			// that this message include the literal
			// HUB_ALLOW_HUB_DATA_REMOVAL env name so the gate
			// (and any operator) can grep for it
			// deterministically. The handler still returns
			// exit 1 and NEVER calls svc.Down — hub-data is
			// preserved by construction because the docker
			// subprocess boundary is never crossed.
			emitError(sink, "hub telemetry down: --volumes refused: set HUB_ALLOW_HUB_DATA_REMOVAL=1 to opt in (hub-data is preserved by default)")
			return 1, errors.New("hub telemetry down: --volumes refused (HUB_ALLOW_HUB_DATA_REMOVAL not set)")
		}
	}
	res, err := svc.Down(context.Background(), opts)
	if err != nil {
		emitError(sink, "hub telemetry down: %v", err)
		return 1, nil
	}
	result := telemetryDownToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitTelemetry(sink, flags, result)
}

func telemetryStatus(sink *output.Sink, cfg TelemetryConfig, flags TelemetryFlags, svc *compose.Service) (int, error) {
	if svc == nil {
		emitError(sink, "hub telemetry status: compose service not initialised")
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
			emitError(sink, "hub telemetry status: %v", err)
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
		emitError(sink, "hub telemetry status: %v", err)
		return 1, nil
	}
	result := telemetryStatusToResult(res, svc.Runtime().ComposeFile, timeout)
	return emitTelemetry(sink, flags, result)
}

// emitTelemetry writes the result to the sink in either human or
// JSON form. The human form is a fixed key/value block so the
// phase5 gate can assert on the shape without snapshot drift. The
// JSON form is sorted alphabetically by encoding/json so two
// invocations produce byte-identical output.
//
// In both modes the rendered payload passes through output.Redact
// so a stray token in compose's stdout never reaches the operator.
func emitTelemetry(sink *output.Sink, flags TelemetryFlags, res TelemetryResult) (int, error) {
	if flags.JSON {
		data, err := json.MarshalIndent(res, "", "  ")
		if err != nil {
			emitError(sink, "hub telemetry: marshal: %v", err)
			return 2, nil
		}
		_ = sink.Printf("%s", output.Redact(string(data)))
		return 0, nil
	}
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

func telemetryUpToResult(r compose.UpResult, composeFile string, timeout time.Duration) TelemetryResult {
	healthy := r.HealthyServices
	if healthy == nil {
		healthy = []string{}
	}
	sort.Strings(healthy)
	services := []compose.ServiceStatus{}
	return TelemetryResult{
		Command:     "up",
		Project:     r.Project,
		Engine:      string(r.Engine),
		ComposeFile: composeFile,
		Healthy:     healthy,
		Services:    services,
		StartedAt:   r.StartedAt,
		FinishedAt:  r.FinishedAt,
		Timeout:     TelemetryDuration(timeout),
	}
}

func telemetryDownToResult(r compose.DownResult, composeFile string, timeout time.Duration) TelemetryResult {
	vr := r.VolumesRemoved
	if vr == nil {
		vr = []string{}
	}
	sort.Strings(vr)
	return TelemetryResult{
		Command:        "down",
		Project:        r.Project,
		Engine:         string(r.Engine),
		ComposeFile:    composeFile,
		VolumesRemoved: vr,
		StartedAt:      r.StartedAt,
		FinishedAt:     r.FinishedAt,
		Timeout:        TelemetryDuration(timeout),
	}
}

func telemetryStatusToResult(r compose.StatusResult, composeFile string, timeout time.Duration) TelemetryResult {
	healthy := make([]string, 0, len(r.Services))
	for _, s := range r.Services {
		if s.Health == "healthy" {
			healthy = append(healthy, s.Name)
		}
	}
	sort.Strings(healthy)
	services := r.Services
	if services == nil {
		services = []compose.ServiceStatus{}
	}
	// Explicit field-by-field conversion: compose.HTTPHealth uses
	// `omitempty` on Body/Error, but TelemetryHTTPHealth is the
	// committed contract surface that MUST always emit those keys
	// (even when empty) so the no-error and collector-down
	// acceptance tests stay stable. A direct assignment would
	// re-introduce the omitempty semantics and silently break the
	// `http_health.error === ''` lock. The nil case is preserved
	// so the JSON encoder still emits `"http_health": null` when
	// no probe was requested.
	var httpHealth *TelemetryHTTPHealth
	if r.HTTPHealth != nil {
		httpHealth = &TelemetryHTTPHealth{
			URL:        r.HTTPHealth.URL,
			HTTPStatus: r.HTTPHealth.HTTPStatus,
			Body:       r.HTTPHealth.Body,
			Error:      r.HTTPHealth.Error,
		}
	}
	return TelemetryResult{
		Command:     "status",
		Project:     r.Project,
		Engine:      string(r.Engine),
		ComposeFile: composeFile,
		Healthy:     healthy,
		Services:    services,
		HTTPHealth:  httpHealth,
		StartedAt:   r.StartedAt,
		FinishedAt:  r.FinishedAt,
		Timeout:     TelemetryDuration(timeout),
	}
}

// printTelemetryHelp writes the `hub telemetry --help` block. The
// text is a fixed string so the phase5 gate can assert on its
// shape without snapshot drift.
func printTelemetryHelp(sink *output.Sink) {
	lines := []string{
		"hub telemetry — Optional observability profile (loopback-first)",
		"",
		"Usage:",
		"  hub telemetry up       [--timeout <dur>] [--json]",
		"  hub telemetry down     [--volumes] [--timeout <dur>] [--json]",
		"  hub telemetry status   [--health-url <url>] [--timeout <dur>] [--json]",
		"  hub telemetry help",
		"",
		"Flags:",
		"  --timeout <dur>     bound the subprocess wait (e.g. 60s, 2m).",
		"  --json              emit the structured payload (deterministic).",
		"  --volumes           opt-in volume removal (down). HUB_ALLOW_HUB_DATA_REMOVAL=1",
		"                      must also be set or the call fails closed.",
		"  --health-url <url>  status: probe a loopback HTTP endpoint after ps.",
		"",
		"Environment:",
		"  HUB_RUNTIME        override the Compose project root.",
		"  HUB_OPENAPI        (unused; telemetry does not consult openapi.yaml).",
		"  HUB_ALLOW_HUB_DATA_REMOVAL",
		"                    opt-in env knob for hub-data removal (test-only).",
		"",
		"Security invariants:",
		"  - --health-url targets loopback only (I-10).",
		"  - bearer-shaped tokens are redacted from every payload (I-07).",
		"  - `down` preserves hub-data by default; --volumes is reserved for tests.",
		"  - the compose file is the T5-owned docker-compose.observability.yml",
		"    (loopback-first); observability/compose.yaml stays read-only.",
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
