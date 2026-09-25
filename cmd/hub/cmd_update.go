// cmd/hub/cmd_update.go
//
// T9 dispatcher for `hub update …`.
//
// Per docs/roadmap/slices.json slice `T9` the update verb is
// exactly:
//
//	hub update                   (plan-only dry-run by default)
//	hub update --channel stable  (literal `stable` channel only)
//	hub update --apply           (refuses with exit code 2;
//	                             apply transport is out of scope)
//	hub update --help            (self-documenting help block)
//
// The dispatcher is a thin orchestrator: parse argv in the Go
// shell, refuse non-stable channels pre-network with a typed
// diagnostic, run the planner from internal/update to compute
// a deterministic Plan, and render either the Plan summary on
// stdout (dry-run, exit 0) or the apply-refused diagnostic on
// stderr (--apply, exit 2). No network calls, no install
// mutation, no subprocess — the planner is pure.
//
// Exit-code contract (mirrors docs/architecture/go-product-shell.md):
//
//   0  success — plan summary rendered on stdout
//   1  reserved (operator / runtime errors today; the update
//                path is hermetic and has no operator class
//                yet, so this code is reserved but not raised)
//   2  contract violation — bad flags, unknown positional,
//                            non-stable channel refused,
//                            --apply refused (apply transport
//                            out of scope)
//
// The dispatcher NEVER reaches into a forbidden path:
//   * no internal/update/apply.go (the install-mutating
//     applier is explicitly forbidden by the T9 amendment;
//     only the planner exists today)
//   * no network transport (the dispatcher's plan summary
//     contains no download URL, no remote release data, no
//     transport)
//   * no filesystem write under HUB_HOME (the planner is pure
//     and the dispatcher never creates, modifies, or deletes
//     any file under $HUB_HOME)
//   * no subprocess fork (no Node child, no shell-out)
//   * no token / secret inspection (the dispatcher never
//     reads HUB_BEARER_TOKEN*; the plan summary carries no
//     bearer-shaped value)

package main

import (
	"io"

	"hub/internal/config"
	"hub/internal/output"
	"hub/internal/update"
	"hub/internal/version"
)

// runUpdate is the dispatcher for `hub update …`. The argv
// slice is the REST of the dispatcher's argv (i.e. everything
// after `hub update`). The function owns:
//  1. argv → UpdateFlags translation (fail-closed on bad
//     flags, unknown positionals, missing values, mutually
//     exclusive combinations).
//  2. Channel literal validation (the LITERAL `stable`
//     only, case-sensitive, exact match).
//  3. Apply-path refusal: when --apply is set, the
//     dispatcher prints the refused diagnostic on stderr
//     and exits 2 — no write, no network, no install
//     mutation. The amendment pins exit 2 for the apply
//     refuse.
//  4. Dry-run rendering: when --apply is NOT set, the
//     dispatcher asks the planner for a Plan, renders the
//     Plan summary on stdout via the renderer, and exits 0.
//  5. Help rendering: when --help is set, the dispatcher
//     short-circuits to print the help block on stdout and
//     exits 0.
//
// The function never mutates the filesystem, never opens a
// network connection, and never invokes a subprocess. The
// planner it delegates to is pure (see internal/update).
func runUpdate(sink *output.Sink, stdout, stderr io.Writer, cfg config.Config, rest []string) (int, error) {
	// cfg is accepted for symmetry with the other
	// dispatchers (runBackup / runRuntime / etc.) and to
	// make a future T10..Tn wiring (e.g. an
	// HUB_UPDATE_ENDPOINT knob read through cfg) a
	// localized change. Today the dispatcher never reads
	// from cfg.
	_ = cfg

	flags, err := update.ParseUpdateFlags(rest)
	if err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}
	if flags.Help {
		printUpdateHelp(sink)
		return exitOK, nil
	}
	if err := flags.ValidateAfterParse(); err != nil {
		// Channel refusal: non-stable literal. The
		// dispatcher emits the diagnostic on stderr and
		// exits with a non-zero code; the amendment's
		// audit requirement is "rejected with a clear
		// error before any network call" without
		// pinning 1 vs 2. We use 2 because the failure
		// is a contract violation (the operator asked
		// for an out-of-spec channel), not a transient
		// runtime failure.
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}

	plan := update.BuildPlan(flags, version.Current())

	if plan.ApplyRequested {
		// Apply-refused path. The amendment pins exit
		// code 2 with a message declaring the apply
		// transport out of scope; no install mutation
		// occurs on refuse. The renderer writes the
		// refusal message to stderr (the diagnostic
		// channel) and returns.
		update.RenderRefusal(stderr, plan)
		return exitContractViolation, nil
	}

	// Dry-run path. The dispatcher renders the Plan
	// summary on stdout via the renderer and exits 0.
	// stdout is the explicit writer (not sink) so the
	// redacted dry-run summary bypasses the sink's
	// pass-through stderr channel — the test contract
	// asserts stdout != "" and stderr == "" on the
	// default invocation, and the renderer's stdout
	// payload is the planner's Plan summary (no
	// bearer-shaped content).
	update.RenderSummary(stdout, plan)
	return exitOK, nil
}

// printUpdateHelp writes the help block to stdout. The text
// comes from internal/update.Help so the contract surface
// lives in exactly one place and a future caller (e.g. a
// s11-style gate) can assert on the help shape without
// duplicating the strings.
func printUpdateHelp(sink *output.Sink) {
	for _, line := range update.Help() {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}
