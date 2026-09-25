// cmd/hub/cmd_connect.go
//
// T8 dispatcher for `hub hub connect preview|apply|rollback`.
//
// The connect verb is a thin orchestrator: parse argv in the Go
// shell, fork the canonical `internal/connect/connect_runner.mjs`
// child with a JSON request payload, capture the response, render
// the result (JSON or human), and translate exit codes. No digest
// computation, no SQLite handle, no in-memory runId map — the Go
// side is purely transport + receipt I/O.
//
// Exit-code contract (mirrors docs/architecture/go-product-shell.md):
//
//   0  success — preview / apply / rollback produced a payload on stdout
//   1  operator / runtime error — adapter failure, missing target, etc.
//   2  contract violation — bad flags, unknown action, format violation
//
// The dispatcher NEVER reaches into a forbidden path (no SqliteStore
// import, no `packages/storage-sqlite/**` import, no domain
// materializer implementation). It only consumes the
// `internal/connect.ConnectFlags` / `Runner` surface that the
// amendment authorises.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"hub/internal/config"
	"hub/internal/connect"
	"hub/internal/output"
)

// runConnect is the dispatcher for `hub hub connect …`. The argv
// slice is the REST of the dispatcher's argv (i.e. everything after
// `hub hub connect`). The jsonFlag honours a top-level `hub --json`
// so `hub --json hub connect preview` works without forcing the
// operator to repeat --json on every subcommand.
func runConnect(sink *output.Sink, stdout, stderr io.Writer, cfg config.Config, rest []string, jsonFlag bool) (int, error) {
	flags, err := connect.ParseConnectFlags(rest)
	if err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}
	if jsonFlag {
		flags.JSON = true
	}
	if err := flags.ValidateAfterParse(); err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}

	// Help surfaces are dispatched before any runner resolution so
	// `hub hub connect --help` works even when Node is missing on
	// the operator's PATH.
	if flags.Help {
		switch flags.Action {
		case connect.ActionNone:
			printConnectHelp(sink)
			return exitOK, nil
		case connect.ActionPreview:
			printConnectPreviewHelp(sink)
			return exitOK, nil
		case connect.ActionApply:
			printConnectApplyHelp(sink)
			return exitOK, nil
		case connect.ActionRollback:
			printConnectRollbackHelp(sink)
			return exitOK, nil
		}
	}

	runner := connect.NewRunner(repoRoot)
	ctx := connectRunContext()
	result, err := runConnectVerb(ctx, runner, flags)
	if err != nil {
		// Transport-level failure: Node missing, runner missing, IO
		// failure. The slice classifies these as operator / runtime
		// errors (exit 1) so a CI pipeline can distinguish "the
		// adapter refused" (exit 1 + payload) from "the harness is
		// broken" (exit 1 + no payload).
		emitError(sink, "%v", err)
		return exitOperatorError, nil
	}
	if result.Exit != 0 {
		// Adapter refusal. Emit the structured payload on the
		// appropriate channel. The .mjs child emits a JSON envelope
		// with { code, message, httpCode, command, action }; we
		// forward it verbatim on stderr (the diagnostic channel) so
		// the operator sees the adapter's typed error.
		if len(result.PayloadJSON) > 0 {
			// Try to surface the structured payload. If it does
			// not parse as JSON (e.g. an oversize guard), emit
			// the raw bytes through the redactor.
			var env map[string]any
			if jerr := json.Unmarshal(result.PayloadJSON, &env); jerr == nil {
				if msg, ok := env["message"].(string); ok {
					emitError(sink, "%s", msg)
				} else {
					emitError(sink, "%s", output.Redact(string(result.PayloadJSON)))
				}
			} else {
				emitError(sink, "%s", output.Redact(string(result.PayloadJSON)))
			}
		}
		if result.StderrPreview != "" {
			emitError(sink, "%s", result.StderrPreview)
		}
		// Exit-code mapping: the .mjs child uses exit 2 for CLI
		// contract violations detected downstream (e.g. format
		// issues that bypassed the Go parser). The dispatcher
		// surfaces those as exit 2 too so the audit trail is
		// unambiguous. Everything else is exit 1.
		if result.Exit == 2 {
			return exitContractViolation, nil
		}
		return exitOperatorError, nil
	}

	// Success path. The .mjs child emits one JSON envelope per
	// invocation. Two output channels share the same envelope:
	//
	//   * flags.JSON → emit the raw redacted JSON envelope
	//     verbatim. The framing bytes are byte-deterministic;
	//     `runId` / `generatedAt` / `observedDigest` reflect the
	//     real materializer output (canonical JSON, stable key
	//     order). This is the contract surface for CI pipelines
	//     and audit tooling that consume JSON.
	//
	//   * !flags.JSON → emit the pre-rendered `humanReadable`
	//     substring the .mjs child attached to the envelope. The
	//     substring carries ONLY the stable anchors (planDigest,
	//     profileId, snapshotId, harness) — observedDigest /
	//     runId / generatedAt are deliberately excluded so two
	//     previews of the same logical input produce byte-
	//     identical human output (timestamps stripped or not).
	//     This is the contract surface for operators reading the
	//     terminal.
	//
	// apply / rollback envelopes currently do NOT carry a
	// `humanReadable` field. To keep those surfaces unchanged in
	// this narrow fix, when !flags.JSON and the parsed envelope
	// has no nonempty humanReadable string we fall back to the
	// raw JSON envelope — the SAME shape flags.JSON gets — so a
	// future PR can add the human form for apply / rollback
	// without churning the dispatcher.
	//
	// The dispatcher never re-stamps runId / planDigest or
	// recomputes any digest: it is a transport, not a renderer
	// of the manifest. All volatile bytes flow through verbatim.
	emitConnectResult(stdout, flags.JSON, result.PayloadJSON)
	return exitOK, nil
}

// emitConnectResult renders the .mjs child's stdout to the
// operator's stdout.
//
// Two channels:
//
//   - rawJSON=true → forward the redacted JSON envelope
//     verbatim, ensuring exactly one trailing newline.
//   - rawJSON=false → parse the envelope and emit only the
//     non-volatile `humanReadable` substring (if present and
//     nonempty) followed by one trailing newline. If the
//     envelope lacks a humanReadable string (current apply /
//     rollback surfaces), preserve the raw-JSON fallback so
//     this fix stays narrow.
//
// The redactor runs on every byte that leaves the process so a
// captured bearer never reaches the operator's terminal. The
// function is the single seam where stdout is written for the
// connect verb.
func emitConnectResult(stdout io.Writer, rawJSON bool, payload []byte) {
	if len(payload) == 0 {
		return
	}
	redacted := output.Redact(string(payload))
	if rawJSON {
		_, _ = stdout.Write([]byte(redacted))
		// Ensure exactly one trailing newline so a CI pipeline
		// piping the output gets clean line-buffered behaviour
		// regardless of whether the child terminated with \n.
		writeTrailingNewline(stdout, redacted)
		return
	}
	// Human channel. Parse the envelope; if the child supplied
	// a non-empty `humanReadable` string, emit ONLY that
	// substring (followed by one newline). Volatile keys
	// (observedDigest, runId, generatedAt) are deliberately
	// dropped — they belong to the JSON channel.
	var env struct {
		HumanReadable string `json:"humanReadable"`
	}
	if err := json.Unmarshal([]byte(redacted), &env); err == nil && env.HumanReadable != "" {
		_, _ = stdout.Write([]byte(env.HumanReadable))
		writeTrailingNewline(stdout, env.HumanReadable)
		return
	}
	// Fallback: no humanReadable on this envelope (current apply
	// / rollback surfaces). Preserve the raw-JSON contract so
	// those verbs are not silently changed by this narrow fix.
	_, _ = stdout.Write([]byte(redacted))
	writeTrailingNewline(stdout, redacted)
}

// writeTrailingNewline emits exactly one trailing newline when
// the emitted bytes do not already end with one. The helper
// preserves the dispatcher's invariant: every channel writes
// produce a single trailing newline so downstream line-buffered
// tooling sees a clean record terminator.
func writeTrailingNewline(stdout io.Writer, emitted string) {
	if strings.HasSuffix(emitted, "\n") {
		return
	}
	_, _ = stdout.Write([]byte("\n"))
}

// runConnectVerb dispatches a single parsed ConnectFlags to the
// matching runner verb. The function lives next to the dispatcher so
// the per-verb shape stays co-located with the argv translation.
func runConnectVerb(ctx context.Context, runner *connect.Runner, flags connect.ConnectFlags) (connect.RunResult, error) {
	switch flags.Action {
	case connect.ActionPreview:
		return runner.RunPreview(ctx, flags)
	case connect.ActionApply:
		return runner.RunApply(ctx, flags)
	case connect.ActionRollback:
		return runner.RunRollback(ctx, flags)
	default:
		return connect.RunResult{}, fmt.Errorf("hub hub connect: unknown action %q", flags.Action)
	}
}

// connectRunContext is the dispatcher-side ctx factory. The slice
// keeps ctx threading explicit so a future signal-handling
// enhancement can cancel a runaway adapter without changing every
// call site. Today it returns context.Background() — there is no
// operator signal surface wired into the dispatch path.
func connectRunContext() context.Context { return context.Background() }

// backgroundContext is the runtime-equivalent of context.Background().
// The runner takes a `context.Context` directly; we forward the
// dispatcher-side ctx so a future cancellation plumbing lands in one
// place.
func backgroundContext() context.Context { return connectRunContext() }

// printConnectHelp writes the root help block to stdout. The text is
// a fixed string so the gate scripts can assert on its shape without
// snapshot drift.
func printConnectHelp(sink *output.Sink) {
	for _, line := range []string{
		"hub hub connect — preview / apply / rollback materializations",
		"",
		"Usage:",
		"  hub hub connect preview   --harness hermes --profile <prf_…> --snapshot <snap_…> --target-root <dir>",
		"  hub hub connect apply     --harness hermes --profile <prf_…> --snapshot <snap_…> --target-root <dir>",
		"                          --reason <reason> --request-id <id>",
		"                          --reviewed-digest <sha256>",
		"                          [--observed-digest <sha256>] [--lock-dir <dir>]",
		"  hub hub connect rollback  --run-id <run_…> --reason <reason> --request-id <id>",
		"  hub hub connect --help",
		"  hub hub connect <verb> --help",
		"",
		"Flags:",
		"  --harness         Renderer id (hermes)",
		"  --profile         Profile id (prf_<alnum>._-)",
		"  --snapshot        Snapshot id (snap_<alnum>._-)",
		"  --target-root     Absolute path to the target root",
		"  --lock-dir        Absolute path to the lock directory (apply only; defaults to --target-root)",
		"  --reason          Operator-supplied audit reason (apply, rollback)",
		"  --request-id      Correlation id (apply, rollback)",
		"  --reviewed-digest 64-lowercase-hex SHA-256 of the plan content the operator reviewed (apply)",
		"  --observed-digest Optional 64-lowercase-hex live CAS manifest digest (apply)",
		"  --run-id          run_<alnum>._- run id of an applied materialization (rollback)",
		"  --json            Emit the JSON envelope instead of the human form",
		"  --help, -h        Print this help block",
		"",
		"Exit codes:",
		"  0  success",
		"  1  operator / runtime / adapter error",
		"  2  contract violation (bad flags, unknown action, format violation)",
	} {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}

func printConnectPreviewHelp(sink *output.Sink) {
	for _, line := range []string{
		"hub hub connect preview — read-only materialization preview",
		"",
		"Usage:",
		"  hub hub connect preview --harness hermes --profile <prf_…> --snapshot <snap_…> --target-root <dir>",
		"",
		"Required flags:",
		"  --harness         Renderer id (hermes)",
		"  --profile         Profile id (prf_<alnum>._-)",
		"  --snapshot        Snapshot id (snap_<alnum>._-)",
		"  --target-root     Absolute path to the target root",
		"",
		"Output:",
		"  planDigest=… observedDigest=… profileId=… snapshotId=… harness=hermes",
		"  (or JSON envelope when --json is set)",
		"",
		"Exit codes:",
		"  0  success (preview is read-only; no target mutation, no receipt)",
		"  1  operator / runtime error",
		"  2  contract violation",
	} {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}

func printConnectApplyHelp(sink *output.Sink) {
	for _, line := range []string{
		"hub hub connect apply — recompute-before-apply with --reviewed-digest (plan content) and --observed-digest (live CAS)",
		"",
		"Usage:",
		"  hub hub connect apply --harness hermes --profile <prf_…> --snapshot <snap_…> --target-root <dir>",
		"                          --reason <reason> --request-id <id>",
		"                          --reviewed-digest <64-hex>",
		"                          [--observed-digest <64-hex>] [--lock-dir <dir>]",
		"",
		"Required flags:",
		"  --harness         Renderer id (hermes)",
		"  --profile         Profile id (prf_<alnum>._-)",
		"  --snapshot        Snapshot id (snap_<alnum>._-)",
		"  --target-root     Absolute path to the target root",
		"  --reason          Operator-supplied audit reason",
		"  --request-id      Correlation id",
		"  --reviewed-digest 64-lowercase-hex SHA-256 of the plan content the operator reviewed",
		"",
		"Digest semantics:",
		"  --reviewed-digest is the operator's REVIEW of the preview's planDigest",
		"                    (the plan CONTENT the operator saw). It is byte-",
		"                    deterministic across two previews of the same input.",
		"  --observed-digest is the operator's OPTIONAL drift signal — the live",
		"                    CAS manifest digest against the current authority.",
		"                    Distinct from --reviewed-digest; do not conflate.",
		"",
		"Output:",
		"  runId=… observedDigest=… writtenFiles=<count> backupRoot=…",
		"  (or JSON envelope when --json is set)",
		"",
		"Exit codes:",
		"  0  success — receipt written at $HUB_HOME/state/connect/receipts/<runId>.json",
		"  1  operator / runtime error (CAS drift, lock contention, adapter failure)",
		"  2  contract violation (missing/invalid --reviewed-digest, bad flags)",
	} {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}

func printConnectRollbackHelp(sink *output.Sink) {
	for _, line := range []string{
		"hub hub connect rollback — cross-process rollback via the durable receipt",
		"",
		"Usage:",
		"  hub hub connect rollback --run-id <run_…> --reason <reason> --request-id <id>",
		"",
		"Required flags:",
		"  --run-id          run_<alnum>._- run id of an applied materialization",
		"  --reason          Operator-supplied audit reason",
		"  --request-id      Correlation id",
		"",
		"Output:",
		"  runId=… restored=<count>",
		"  (or JSON envelope when --json is set)",
		"",
		"Exit codes:",
		"  0  success — receipt rehydrated, target restored",
		"  1  operator / runtime error (missing receipt, corrupt receipt, wrong-resource, stale manifest)",
		"  2  contract violation (missing/invalid --run-id, bad flags)",
	} {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}

// Guard the import of `os` so the file compiles cleanly even when
// the dispatcher grows a future env probe. The current surface does
// not need it but cmd_connect.go is the natural home for future
// HUB_CONNECT_* knob readers; keep the import for parity.
var _ = os.Getenv
