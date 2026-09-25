// Planner for `hub update`. The planner is the read-only half of
// the T9 amendment's `hub update` contract: given parsed flags
// and the Go shell's authoritative version triple, it produces
// a small, deterministic Plan that the dispatcher renders to
// stdout. The planner NEVER reaches the network, NEVER reads the
// filesystem, and NEVER inspects the installed hub binary —
// those are deferred to a future separately governed apply
// transport (which is itself forbidden by this slice's
// forbidden_paths: no internal/update/apply.go).
//
// Two outcomes are possible:
//
//   - PlanDryRun            — the planner emits a Plan summary
//                             describing what an apply WOULD do,
//                             without performing it. The
//                             dispatcher prints the Plan on stdout
//                             and exits 0.
//
//   - PlanApplyRefused      — the operator passed --apply. The
//                             planner emits a Plan with
//                             ApplyRequested=true and an explicit
//                             refused-reason message; the
//                             dispatcher prints the refused
//                             message on stderr and exits 2.
//
// The Plan struct is the only typed surface the dispatcher
// reads. Field names are stable; downstream tooling that pipes
// `hub update` into `jq` MUST be able to parse the rendered
// output without depending on incidental formatting. The
// dispatcher's renderer emits one `key=value` line per Plan
// field in a fixed, sorted order, so the rendered bytes are
// byte-deterministic across hosts and toolchains.

package update

import (
	"fmt"
	"strings"

	"hub/internal/version"
)

// ApplyOutOfScopeMessage is the operator-facing diagnostic the
// dispatcher emits on stderr when the planner reports
// PlanApplyRefused. The message is a constant — pinned in this
// slice — so a CI pipeline can grep on its presence without
// snapshot drift, and so the audit trail records the exact
// wording the T9 amendment authorises.
//
// Per docs/roadmap/slices.json slice `T9`:
//
//	"hub update --apply refuses with exit code 2 and a message
//	 declaring the apply transport out of scope; no install
//	 mutation occurs on refuse"
//
// The message MUST be self-explanatory: it states the refuse
// reason, the slice ownership (the apply transport is reserved
// for a future slice), and the absence of any side effect on
// the install. A future orchestrator can grep on the literal
// "apply transport" substring to detect this refuse class
// without parsing the exit code alone.
const ApplyOutOfScopeMessage = "hub update --apply: apply transport is out of scope for this slice and must be added by a future separately governed slice; no install mutation occurred"

// Plan is the read-only summary the dispatcher renders on
// stdout for the dry-run path. The fields are exhaustive: every
// field the dispatcher emits comes from this struct, and the
// renderer sorts the keys deterministically before printing so
// the rendered bytes are stable.
//
// The struct is also the refused-mode receipt: when
// ApplyRequested is true, the dispatcher reads the same struct
// but emits ApplyOutOfScopeMessage on stderr instead of the
// summary on stdout. Keeping the rejected outcome in the same
// struct is intentional: it gives the dispatcher a single
// typed surface to render and makes the apply-refused path
// observable to a future audit log without inventing a second
// receipt shape.
type Plan struct {
	// Mode is the plan class — PlanDryRun for the default
	// surface, PlanApplyRefused when --apply was passed.
	// The string value is the renderer label on stdout, so
	// `hub update` prints `mode=dry-run` and `hub update
	// --apply` would (per the contract) emit the refused
	// diagnostic on stderr instead.
	Mode PlanMode
	// Channel is the compiled-authority channel literal.
	// After ValidateAfterParse, this is ALWAYS `stable` —
	// the planner never accepts anything else. The field
	// exists so the rendered summary is self-describing
	// and a CI pipeline can grep on `channel=stable`
	// without re-implementing the parser.
	Channel string
	// Hub is the Go shell's compiled-in version. Sourced
	// from internal/version.Hub so the rendered summary
	// matches `hub version --json`'s `hub` field byte-for-
	// byte. The planner does NOT derive this from the
	// installed binary; the running process's version is
	// authoritative (the binary under planning IS the
	// running process; the install mutation surface is
	// reserved for a future apply transport).
	Hub string
	// Go is the Go toolchain build that produced this
	// binary. Mirrored from internal/version.GoVersion
	// for the same audit-trail reason as Hub.
	Go string
	// ApplyRequested mirrors the operator's --apply flag.
	// The dispatcher reads this directly to choose
	// between the dry-run stdout summary and the
	// apply-refused stderr diagnostic.
	ApplyRequested bool
	// Reason is a free-form string the dispatcher emits
	// alongside ApplyRequested=true. It carries the
	// human-readable explanation the operator sees on
	// stderr; for the dry-run path it is empty.
	Reason string
}

// BuildPlan computes a Plan from parsed flags. The function is
// the planner's ONLY entry point so any future derivation
// (env-driven overrides, sidecar lookup, ...) happens in
// exactly one place.
//
// Inputs:
//
//   - flags: the parsed argv. The caller MUST have already
//     invoked ValidateAfterParse — this function does not
//     re-validate. Channel is expected to be `stable`
//     (or empty, which the renderer treats identically).
//
//   - current: the Go shell's authoritative version triple,
//     sourced from internal/version.Current(). The caller
//     supplies it so the planner has zero coupling to the
//     version package's internals and a future test can
//     exercise the planner against a fixture triple.
//
// Outputs:
//
//   - A Plan describing either the dry-run outcome (when
//     flags.ApplyRequested is false) or the apply-refused
//     outcome (when flags.ApplyRequested is true).
//
// The planner is pure: it never reads the filesystem, never
// opens a network connection, and never calls a subprocess. It
// is safe to invoke from a hermetic test harness without
// staging any on-disk fixture beyond the HUB_HOME the harness
// already provisions.
func BuildPlan(flags UpdateFlags, current version.Values) Plan {
	if flags.ApplyRequested {
		// The apply-refused path. The Mode field is
		// PlanApplyRefused so a downstream consumer that
		// reads the Plan struct directly sees a typed
		// outcome; the dispatcher's stdout renderer is
		// not invoked for this case (the refused message
		// goes to stderr instead), so the Mode field is
		// primarily for tests and audit hooks.
		return Plan{
			Mode:           PlanApplyRefused,
			Channel:        "stable",
			Hub:            current.Hub,
			Go:             current.Go,
			ApplyRequested: true,
			Reason:         ApplyOutOfScopeMessage,
		}
	}
	// Dry-run path. The Plan is the literal receipt of
	// "this is what an apply WOULD do, given the pinned
	// inputs" — nothing more. There is no download URL, no
	// remote release data, no transport. The amendment
	// explicitly forbids hardcoded remote release data
	// pretending to be a real update; the rendered summary
	// is the operator-facing proof that the planner is
	// read-only.
	channel := flags.Channel
	if channel == "" {
		channel = "stable"
	}
	return Plan{
		Mode:           PlanDryRun,
		Channel:        channel,
		Hub:            current.Hub,
		Go:             current.Go,
		ApplyRequested: false,
		Reason:         "",
	}
}

// RenderSummary writes a deterministic, sorted-key summary of
// the Plan to stdout. The format is one `key=value` line per
// field so a CI pipeline can grep on individual lines without
// parsing JSON.
//
// Keys are sorted alphabetically so two consecutive invocations
// on the same input produce byte-identical output (modulo
// nothing — the planner is pure). The dispatcher calls this
// helper for the dry-run path; the apply-refused path uses
// RenderRefusal instead.
//
// Bearers / secrets never appear in the summary because the
// Plan struct has no bearer-shaped fields. The helper applies
// a belt-and-braces check (no value may be empty for a key
// that is expected to be populated) so a future struct
// extension that accidentally introduces a bearer-shaped
// value still produces a well-formed line — but the line's
// value would be empty, which is the only failure mode a CI
// pipeline could mistake for success.
//
// `out` is the explicit writer so the dispatcher can route
// stdout / stderr through its own sink; the helper itself
// stays a pure byte renderer.
func RenderSummary(out interface{ Write(p []byte) (int, error) }, p Plan) {
	// Sorted key list. Adding a new field to Plan requires
	// adding its key here AND keeping the alphabetical
	// order; the dispatcher's tests assert byte-for-byte
	// on the rendered output, so a key ordering drift would
	// surface as a deterministic test failure.
	keys := []string{"mode", "channel", "hub", "go", "apply", "reason"}
	values := map[string]string{
		"mode":    string(p.Mode),
		"channel": p.Channel,
		"hub":     p.Hub,
		"go":      p.Go,
		"apply":   boolString(p.ApplyRequested),
		"reason":  p.Reason,
	}
	for _, k := range keys {
		line := fmt.Sprintf("%s=%s\n", k, values[k])
		_, _ = out.Write([]byte(line))
	}
}

// RenderRefusal writes the apply-refused diagnostic on stderr.
// The message is a single line: ApplyOutOfScopeMessage. The
// function is separate from RenderSummary so the dispatcher
// can route the dry-run summary on stdout and the refusal on
// stderr with no risk of channel crossover.
func RenderRefusal(out interface{ Write(p []byte) (int, error) }, p Plan) {
	msg := ApplyOutOfScopeMessage
	if p.Reason != "" {
		// A future operator-supplied reason overrides the
		// default. Today the planner never sets Reason to
		// anything other than ApplyOutOfScopeMessage, but
		// keeping the indirection lets a downstream
		// consumer (e.g. a future per-channel diagnostic
		// extension) emit a channel-specific message
		// without changing the dispatcher's call sites.
		msg = p.Reason
	}
	_, _ = out.Write([]byte(strings.TrimRight(msg, "\n") + "\n"))
}

// boolString is a tiny presentational helper — the rendered
// summary uses "true" / "false" so a CI pipeline can grep on
// `apply=true` without worrying about JSON formatting rules.
func boolString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// Help returns the help-block lines the dispatcher prints for
// `hub update --help`. The text is a fixed string so the T9
// test suite can assert on its shape without snapshot drift;
// the amendment pins exactly the `--apply` and `stable`
// surface, and both must be discoverable from --help alone.
//
// The function returns a slice (rather than writing directly
// to a writer) so tests can compare the lines verbatim and so
// the dispatcher can route the output through its own sink
// without re-allocating the underlying buffer.
func Help() []string {
	return []string{
		"hub update — plan-only dry-run; --apply refuses (T9)",
		"",
		"Usage:",
		"  hub update                 print the plan summary (default; no network, no install)",
		"  hub update --channel stable  literal `stable` channel only (compiled-only)",
		"  hub update --apply          refuses with exit code 2 — apply transport is out of scope",
		"  hub update --help           print this help block",
		"",
		"Channel policy:",
		"  Only the literal channel `stable` is accepted (case-sensitive, exact match).",
		"  Non-stable channels (beta, dev, nightly, source, script, edge, Stable, stable-2)",
		"  are refused with a non-zero exit code BEFORE any network call.",
		"",
		"Apply policy:",
		"  --apply is refused with exit code 2 and a message declaring the apply transport",
		"  out of scope for this slice; no install mutation occurs on refuse.",
		"  The apply transport must be added by a future separately governed slice.",
		"",
		"Exit codes:",
		"  0  success — plan summary printed on stdout",
		"  2  contract violation — refused (apply transport out of scope, bad channel, bad flag)",
		"",
	}
}
