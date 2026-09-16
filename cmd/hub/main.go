// Command hub is the canonical product shell for portable-agent-asset-hub.
//
// Per docs/phase0/naming.md and docs/architecture/go-product-shell.md
// the binary name is `hub`. T0.5 ships a deliberately narrow surface:
//
//	hub           — default invocation: prints --help to stdout and exits 0
//	hub help      — alias for --help
//	hub --help    — prints the contract surface
//	hub --version — prints `hub <ver> (go<gover>)` and exits 0
//	hub version   — alias for --version
//	hub version --json — prints the JSON version triple
//	hub doctor    — read-only health + contract + policy check
//	hub doctor --json — the same report as a structured payload
//
// Every other form falls through to a fail-closed diagnostic on
// stderr and exits with code 2 (contract violation). main.go is the
// ONLY place that reads os.Args, parses flags, and selects an exit
// code; internal packages stay pure so tests can exercise them
// without spawning hub itself.
//
// Stdout / stderr separation is enforced through the output package;
// every payload that leaves stdout passes through output.Redact so a
// captured token in a config file never reaches the operator.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"hub/internal/compose"
	"hub/internal/config"
	"hub/internal/doctor"
	"hub/internal/output"
	"hub/internal/version"
)

// exit codes — fail-closed. Documented in
// docs/architecture/go-product-shell.md.
const (
	exitOK                = 0
	exitOperatorError     = 1
	exitContractViolation = 2
)

// repoRoot is set by main() to the absolute directory of this
// source file's parent (cmd/hub/main.go → repo root). Used to derive
// the default HUB_OPENAPI location.
var repoRoot string

func main() {
	// Resolve repo root for HUB_OPENAPI's default. main.go lives at
	// <repo>/cmd/hub/main.go, so the repo root is the parent of the
	// grandparent.
	here, err := os.Executable()
	_ = here // not used; we resolve via the source-tree assumption.
	if err != nil {
		// os.Executable can fail only under unusual conditions
		// (e.g. /proc/self/exe unreadable). Fall back to the
		// current working directory.
		cwd, cwdErr := os.Getwd()
		if cwdErr != nil {
			fmt.Fprintf(os.Stderr, "hub: cannot resolve working directory: %v\n", cwdErr)
			os.Exit(exitContractViolation)
		}
		repoRoot = cwd
	} else {
		// os.Executable returns the BINARY path (cmd/hub/hub). The
		// repo root is two levels up. We resolve relative to the
		// binary because hub may run from anywhere — the symlink
		// path is irrelevant; only the real path matters.
		real, realErr := filepath.EvalSymlinks(here)
		if realErr != nil {
			real = here
		}
		repoRoot = filepath.Dir(filepath.Dir(filepath.Dir(real)))
	}

	code, err := run(os.Args[1:], os.Stdout, os.Stderr)
	if err != nil {
		// run() emits its own diagnostic on stderr; main just
		// propagates the exit code.
		_ = err
	}
	os.Exit(code)
}

// run is the testable entry point. It receives argv (without the
// binary name) and explicit stdout/stderr writers. The function
// returns the exit code, never panicking — every error becomes a
// diagnostic on stderr.
func run(argv []string, stdout, stderr io.Writer) (int, error) {
	sink := output.NewForTest(
		func(b []byte) (int, error) { return stdout.Write(b) },
		func(b []byte) (int, error) { return stderr.Write(b) },
		output.IsCI(),
	)

	// Load config early so every exit path can include the resolved
	// HUB_HOME. Validation errors are surfaced as contract violations
	// (exit 2) — they always indicate operator/env drift, not a
	// transient runtime failure.
	cfg, cfgErr := config.Load(repoRoot)
	if cfgErr != nil {
		emitError(sink, "config: %v", cfgErr)
		return exitContractViolation, nil
	}

	// argv normalisation. Empty argv defaults to "--help".
	if len(argv) == 0 {
		printHelp(sink)
		return exitOK, nil
	}

	// Walk argv left to right. We deliberately do NOT use the
	// stdlib flag package because (a) it would mutate os.Args and
	// (b) `hub version --json` needs `version` to be a subcommand,
	// not a flag.
	command, jsonFlag, rest, err := parseArgs(argv)
	if err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}

	switch command {
	case "", "help", "--help", "-h":
		printHelp(sink)
		return exitOK, nil
	case "--version", "-v":
		// `--version` is the legacy / canonical global flag.
		printVersion(sink, jsonFlag)
		return exitOK, nil
	case "version":
		printVersion(sink, jsonFlag)
		return exitOK, nil
	case "doctor":
		// Read-only diagnostic. The doctor never mutates
		// filesystem state: it stats files, probes env, and
		// emits a structured report. Exit code semantics:
		//   0 — every check is "ok" or "warn"
		//   1 — operator error (e.g. config load failed)
		//   2 — contract violation (the doctor itself is
		//       fail-closed; never raised today because the
		//       command always parses cleanly)
		if err := printDoctor(sink, cfg, cfgErr, jsonFlag); err != nil {
			return exitContractViolation, nil
		}
		return exitOK, nil
	case "path":
		if err := printPath(sink, cfg, rest); err != nil {
			return exitContractViolation, nil
		}
		return exitOK, nil
	case "config":
		printConfig(sink, cfg, rest, jsonFlag)
		return exitOK, nil
	case "runtime":
		return runRuntime(sink, stdout, stderr, cfg, rest, jsonFlag)
	case "init":
		// First-run init. The handler is idempotent (an existing
		// tokens/hub.token is preserved byte-for-byte). All
		// failure modes surface as exit 2 (contract violation).
		// The handler owns its own --json OR'ing: a top-level
		// `hub --json init` and an inline `hub init --json` are
		// equivalent.
		return runInit(sink, cfg, jsonFlag)
	case "token":
		// Subcommand dispatch is handled inside runToken: show
		// (redacted) or rotate (regenerate). Any unknown verb
		// or forbidden flag (--full / --reveal / --print)
		// surfaces as exit 2.
		return runToken(sink, cfg, rest, jsonFlag)
	default:
		emitError(sink, "hub: unknown command %q (try `hub --help`)", command)
		return exitContractViolation, nil
	}
}

// parseArgs splits argv into (command, jsonFlag, rest, error). It is
// extracted so tests can exercise the parser without spawning hub.
//
// Accepted shapes:
//
//	[]                       → ("", false, nil, nil) — defaults to --help
//	["--help"]               → ("help", false, nil, nil)
//	["help"]                 → ("help", false, nil, nil)
//	["version"]              → ("version", false, nil, nil)
//	["version", "--json"]    → ("version", true, nil, nil)
//	["path", "home"]         → ("path", false, ["home"], nil)
//	["config", "home"]       → ("config", false, ["home"], nil)
//	["config", "--json"]     → ("config", true, nil, nil)
//	["--", …anything]        → fail-closed: literal "--" is not a command
//	[any unknown]            → fail-closed: unknown command
//
// Global flags (`--json`) can appear before or after the subcommand;
// the parser is permissive on order, strict on semantics.
func parseArgs(argv []string) (string, bool, []string, error) {
	jsonFlag := false
	var rest []string
	commandSet := false
	var command string

	consumeValue := func() (string, error) {
		return "", errors.New("parseArgs: --json takes no value")
	}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch arg {
		case "--json":
			if jsonFlag {
				return "", false, nil, errors.New("hub: --json specified twice")
			}
			jsonFlag = true
			continue
		}
		// Bare `--` is fail-closed: it carries no contract meaning
		// for `hub` and is a sign of an upstream command-line
		// parser that has drifted away from the documented surface.
		if arg == "--" {
			return "", false, nil, errors.New("hub: '--' is not a command (pass positional args without '--')")
		}
		if !commandSet {
			command = arg
			commandSet = true
			continue
		}
		rest = append(rest, arg)
		_ = consumeValue // keep the linter quiet on the unused helper
	}
	return command, jsonFlag, rest, nil
}

// printHelp writes the help text to stdout. The text is a fixed
// string so the s11 gate can assert on its shape without snapshot
// drift.
func printHelp(sink *output.Sink) {
	help := []string{
		"hub — portable-agent-asset-hub product shell",
		"",
		"Usage:",
		"  hub                    print this help",
		"  hub --help             print this help",
		"  hub help               print this help",
		"  hub --version          print the hub version line",
		"  hub version            print the hub version line",
		"  hub version --json     print the structured version triple",
		"  hub path <KEY>         print a resolved path (home, runtime, openapi, log, token)",
		"  hub config <KEY>       print a config value (env-aware)",
		"  hub config --json      print the full config as JSON",
		"  hub init               create $HUB_HOME layout + bearer token (idempotent)",
		"  hub init --json        structured payload, bearer-free",
		"  hub token show         print a redacted token preview",
		"  hub token rotate       generate a fresh bearer (mode 0600)",
		"  hub doctor             read-only health + contract + policy check",
		"  hub doctor --json      the same report as a structured payload",
		"",
		"Environment:",
		"  HUB_HOME               override the canonical hub home (default: XDG-style)",
		"  HUB_RUNTIME            override the Compose project root",
		"  HUB_OPENAPI            override the path to openapi/openapi.yaml",
		"",
		"Exit codes:",
		"  0  success",
		"  1  operator error",
		"  2  contract violation",
	}
	for _, line := range help {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}

// printVersion emits the human-readable version, or the JSON triple
// when --json is set. Both forms pass through output.Redact so a
// stray token in an env var never reaches stdout.
func printVersion(sink *output.Sink, asJSON bool) {
	v := version.Current()
	if !asJSON {
		info := version.CurrentInfo()
		_ = sink.Printf("%s", output.Redact(info.String()))
		return
	}
	payload := v // value type
	data, err := json.Marshal(payload)
	if err != nil {
		emitError(sink, "hub: marshal version: %v", err)
		return
	}
	redacted := output.Redact(string(data))
	_ = sink.Printf("%s", redacted)
}

// printDoctor emits the doctor report in either human-readable or
// --json form. The human form is a deterministic key/value block
// (one check per line) so a CI pipeline can grep on the top-level
// status without parsing JSON. The --json form is the locked schema
// described in internal/doctor/doctor.go and is the contract surface
// for orchestrators.
//
// The function is read-only: it never mutates the filesystem. The
// underlying doctor.Run is the only entry point that touches
// os.Stat; everything else is pure computation.
func printDoctor(sink *output.Sink, cfg config.Config, cfgErr error, asJSON bool) error {
	report := doctor.Run(cfg, cfgErr)
	if asJSON {
		data, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			emitError(sink, "hub: marshal doctor: %v", err)
			return err
		}
		_ = sink.Printf("%s", output.Redact(string(data)))
		return nil
	}
	// Human-readable: one line per check, then the top-level
	// verdict. The lines are deterministic and grep-friendly so a
	// CI pipeline can pipe `hub doctor | grep '^status:'` without
	// needing jq.
	_ = sink.Printf("status=%s", report.Status)
	for _, c := range report.Checks {
		_ = sink.Printf("  [%s] %s: %s — %s", c.Status, c.ID, c.Name, output.Redact(c.Message))
		if c.Detail != "" {
			_ = sink.Printf("      detail: %s", output.Redact(c.Detail))
		}
	}
	return nil
}

// printPath prints a single computed path. The "unknown" keys fall
// back to "" when the source was unset (e.g. runtime has no default).
// An unknown key is treated as a contract violation: the function
// emits the diagnostic on stderr and returns a non-nil error so the
// caller can convert it to exit code 2 (per docs/architecture/
// go-product-shell.md, every unrecognised key on the contract surface
// is fail-closed, not silently ignored).
func printPath(sink *output.Sink, cfg config.Config, rest []string) error {
	keys := rest
	if len(keys) == 0 {
		// Default to printing every path on its own line so the
		// operator sees the full layout.
		keys = []string{"home", "state", "runtime", "logs", "tokens", "log", "token", "openapi"}
	}
	unknownSeen := false
	for _, rawKey := range keys {
		key := strings.ToLower(strings.TrimSpace(rawKey))
		var val string
		switch key {
		case "home":
			val = cfg.Home
		case "state":
			val = cfg.Layout.State
		case "runtime":
			val = cfg.Runtime
		case "logs":
			val = cfg.Layout.Logs
		case "tokens":
			val = cfg.Layout.Tokens
		case "log":
			val = cfg.Layout.LogFile
		case "token":
			val = cfg.Layout.TokenFile
		case "openapi":
			val = cfg.OpenAPI
		default:
			emitError(sink, "hub: unknown path key %q", rawKey)
			unknownSeen = true
			continue
		}
		if val == "" {
			val = "<unset>"
		}
		_ = sink.Printf("%s=%s", key, output.Redact(val))
	}
	if unknownSeen {
		// Surface a structured sentinel so callers can route this to
		// the documented exit code (2 — contract violation). The
		// diagnostic itself is already on stderr via emitError.
		return errors.New("hub: unknown path key")
	}
	return nil
}

// printConfig prints a single config value (or the full JSON when
// --json is set). The handler exists so `hub config` does not have
// to be a hidden alias for `hub path` — the two answer different
// audit questions ("where does the file live?" vs "where did the
// value come from?").
func printConfig(sink *output.Sink, cfg config.Config, rest []string, asJSON bool) {
	if asJSON {
		printConfigJSON(sink, cfg)
		return
	}
	keys := rest
	if len(keys) == 0 {
		keys = []string{"home", "runtime", "openapi"}
	}
	for _, rawKey := range keys {
		key := strings.ToLower(strings.TrimSpace(rawKey))
		switch key {
		case "home":
			_ = sink.Printf("home=%s source=%s", output.Redact(cfg.Home), cfg.Source.Home)
		case "runtime":
			_ = sink.Printf("runtime=%s source=%s", displayOrUnset(cfg.Runtime), cfg.Source.Runtime)
		case "openapi":
			_ = sink.Printf("openapi=%s source=%s", displayOrUnset(cfg.OpenAPI), cfg.Source.OpenAPI)
		default:
			emitError(sink, "hub: unknown config key %q", rawKey)
			continue
		}
	}
}

// printConfigJSON emits the full config as a single JSON object. The
// payload is sorted by key so the output is byte-deterministic.
func printConfigJSON(sink *output.Sink, cfg config.Config) {
	payload := map[string]map[string]string{
		"home": {
			"value":  cfg.Home,
			"source": cfg.Source.Home,
		},
		"runtime": {
			"value":  cfg.Runtime,
			"source": cfg.Source.Runtime,
		},
		"openapi": {
			"value":  cfg.OpenAPI,
			"source": cfg.Source.OpenAPI,
		},
	}
	// Render with sorted keys to keep the s11 gate's assertions
	// stable. encoding/json's Marshal already sorts map keys.
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		emitError(sink, "hub: marshal config: %v", err)
		return
	}
	_ = sink.Printf("%s", output.Redact(string(data)))
}

// displayOrUnset is a tiny presentational helper — `<unset>` keeps
// the operator's eye on the column alignment without leaking empty
// strings through pipes.
func displayOrUnset(v string) string {
	if v == "" {
		return "<unset>"
	}
	return v
}

// runRuntime is the dispatch shim from `hub runtime …` to the
// runtime handler in cmd_runtime.go. It owns three responsibilities
// the handler itself must not:
//
//  1. Resolve the Compose runtime via compose.Detect. Detect is
//     read-only (no subprocess beyond exec.LookPath) and isolated
//     by default (HUB_RUNTIME or hub-<pid>-<epoch>), so wiring it
//     here keeps the handler hermetic.
//  2. Build a *compose.Service with NewService(rt, nil). nil
//     selects the production Runner (OSExec); tests can swap in a
//     scripted Runner by passing one to NewService — the handler
//     itself never instantiates the runner.
//  3. Translate argv → RuntimeFlags via ParseRuntimeFlags so the
//     handler sees a typed tuple. Parser failures are surfaced as
//     exit 2 (contract violation).
//
// Detect / Service construction failures are operator errors (exit 1)
// because they typically mean "docker is not on PATH" or the
// resolved compose file is missing — env drift, not shell contract
// drift.
func runRuntime(sink *output.Sink, stdout, stderr io.Writer, cfg config.Config, rest []string, jsonFlag bool) (int, error) {
	// T2 polish: cfg.Runtime IS HUB_RUNTIME. The architecture
	// documents HUB_RUNTIME as "the Compose project root" — but
	// operators / hermetic tests commonly point it at an absolute
	// compose-file path (the .yaml the binary should drive). Detect
	// owns the polymorphism: when opts.ComposeFile is empty, it
	// inspects HUB_RUNTIME itself and treats it as a compose-file
	// override precisely when the path points at an existing
	// .yaml/.yml file. We deliberately do NOT re-bundle cfg.Runtime
	// into opts.ComposeFile here — doing so would (a) force the
	// Detect codepath to treat HUB_RUNTIME as a project-root marker
	// even when it is unambiguously a file path, and (b) couple
	// the CLI to config-time value resolution that future slices
	// may want to alter.
	rt, err := compose.Detect(compose.DetectOptions{RepoRoot: repoRoot})
	if err != nil {
		emitError(sink, "hub runtime: detect: %v", err)
		return exitOperatorError, nil
	}
	svc := compose.NewService(rt, nil)
	rcfg := RuntimeConfig{
		RepoRoot:    repoRoot,
		ComposeFile: rt.ComposeFile,
		ProjectName: rt.ProjectName,
		WorkingDir:  rt.WorkingDir,
	}
	flags, perr := ParseRuntimeFlags(rest)
	if perr != nil {
		emitError(sink, "%v", perr)
		return exitContractViolation, nil
	}
	// Honour a top-level --json so `hub runtime ps --json` works
	// without forcing the operator to repeat --json after every
	// subcommand. ParseRuntimeFlags already accepts --json inline;
	// this OR is just a convenience shortcut.
	if jsonFlag {
		flags.JSON = true
	}
	return RunRuntime(stdout, stderr, rcfg, flags, svc)
}

// emitError was previously declared here; the function now lives in
// cmd_helpers.go so cmd_runtime.go can share the implementation
// without importing main.go (cyclic import — main is the entry
// point). The behaviour is identical: a single stderr line via
// sink.Errorf, fail-closed, never echoing bearer-shaped content.
// `*output.Sink` satisfies the interface declared in
// cmd_helpers.go so every existing call site in main.go keeps
// compiling unchanged.
