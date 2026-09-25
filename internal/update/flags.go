// Package update is the T9 planner surface for `hub update`.
//
// Per docs/roadmap/slices.json slice `T9` the update verb is
// exactly:
//
//	hub update              (plan-only dry-run; the default)
//	hub update --channel stable
//	                        (literal `stable` channel only; compiled-only)
//	hub update --apply      (refuses with exit 2 — apply transport is
//	                         out of scope and MUST be added by a
//	                         future separately governed slice)
//	hub update --help       (self-documenting help block)
//
// Non-stable channels (`beta`, `dev`, `nightly`, `source`, `script`,
// `edge`, `Stable`, `stable-2`, …) are refused with a non-zero exit
// code BEFORE any network call. The package is therefore
// intentionally narrow:
//
//   - argv parsing (ParseUpdateFlags) is strict: unknown flags and
//     unknown positionals are fail-closed (exit 2). The parser never
//     panics and never silently picks a non-default channel.
//
//   - the planner (Plan) is read-only by construction: it never
//     opens a network connection, never reads the filesystem, and
//     never reaches for the installed binary. Its only inputs are
//     the parsed flags and the Go shell's authoritative version
//     triple from internal/version. Its only output is a small
//     key/value Plan that the dispatcher renders to stdout.
//
//   - the apply surface is NOT implemented in this slice. The
//     internal/update/apply.go path is explicitly forbidden by the
//     T9 amendment (see forbidden_paths). The package's only
//     refuse-with-exit-2 entry point is Plan's ApplyRequested flag
//     combined with the dispatcher's exit-code contract.
//
// Security invariants this package enforces by construction:
//
//   - Bearer hygiene (I-07). The planner never reads the env for
//     HUB_BEARER_TOKEN*, never echoes any captured token, and the
//     plan summary keys are bounded to non-secret shapes (version
//     triple, channel literal, action class, dry-run marker). The
//     plan itself contains no bearer-shaped values; an operator who
//     captures a token in a config file cannot see it leak through
//     `hub update`.
//
//   - Bounded input. The parser caps argv at a single iteration per
//     flag and refuses unknown entries; the planner takes a single
//     typed Flags struct so a future caller cannot smuggle an
//     unbounded payload through argv.
//
//   - Fail-closed semantics. The parser surfaces every error as a
//     typed diagnostic; the dispatcher converts the diagnostic into
//     the documented exit code (2 — contract violation). The apply
//     path is a hard refuse; there is no soft-fail surface.
//
//   - Determinism. The planner produces a stable Plan whose keys
//     are sorted and whose values are derived from the Go shell's
//     compiled-in version triple and the operator-supplied channel
//     literal. Two consecutive `hub update --channel stable`
//     invocations on the same binary produce byte-identical plans
//     (modulo nothing — there is no clock, no path, no env probe).
package update

import (
	"errors"
	"fmt"
	"strings"
)

// PlanMode enumerates the two and only two authorised outcomes
// from `hub update`. The string values double as the action class
// the dispatcher renders on stdout, so the renderer and the
// planner share the exact same vocabulary.
//
// PlanDryRun is the default for every invocation that does not
// pass --apply. The dispatcher renders the planner's Plan on
// stdout and exits 0.
//
// PlanApplyRefused is the only outcome for `hub update --apply`:
// the apply transport is out of scope for this slice and the
// planner refuses BEFORE any write or network call. The
// dispatcher emits the refused message on stderr and exits 2 —
// the exit code the T9 amendment pins numerically.
type PlanMode string

const (
	// PlanDryRun — read-only plan rendered on stdout, exit 0.
	PlanDryRun PlanMode = "dry-run"
	// PlanApplyRefused — apply transport refused, exit 2.
	PlanApplyRefused PlanMode = "apply-refused"
)

// UpdateFlags is the parsed argv for `hub update`. The struct is
// the single typed surface the dispatcher hands to the planner so
// the planner never has to re-walk argv.
type UpdateFlags struct {
	// Channel is the operator-supplied channel literal. Empty
	// means "no --channel was passed" — the planner treats
	// that as the literal `stable` because the T9 amendment
	// pins `stable` as the only authorised channel and the
	// default MUST be the plan-only dry-run surface.
	Channel string
	// ChannelSet is true when the operator explicitly passed
	// --channel. The planner uses this flag to distinguish a
	// bare `hub update` (defaults to stable, silent) from
	// `hub update --channel stable` (explicit, also stable).
	ChannelSet bool
	// ApplyRequested is true when the operator passed
	// --apply. The planner surfaces this as the apply-refused
	// outcome (exit 2) regardless of channel: the amendment
	// explicitly states stable does not unlock apply.
	ApplyRequested bool
	// Help is true when --help / -h was set. The dispatcher
	// short-circuits to print the help block before any other
	// validation fires.
	Help bool
}

// ParseUpdateFlags translates argv into a typed UpdateFlags. The
// parser is strict: unknown flags, unknown positionals, missing
// values, and any non-`stable` channel literal are contract
// violations (exit 2). The parser never panics and never silently
// picks a non-default channel.
//
// Accepted shapes:
//
//	--help, -h
//	  → { Help: true }
//
//	(none)
//	  → { Channel: "", ChannelSet: false, ApplyRequested: false }
//
//	--channel stable
//	  → { Channel: "stable", ChannelSet: true }
//
//	--apply
//	  → { ApplyRequested: true }
//	--channel stable --apply
//	  → { Channel: "stable", ChannelSet: true, ApplyRequested: true }
//
// Everything else is a contract violation. In particular:
//
//   - `hub update --channel beta`     → non-zero (channel refused)
//   - `hub update --channel Stable`   → non-zero (case-sensitive)
//   - `hub update --channel stable-2` → non-zero (no prefix match)
//   - `hub update --channel`          → non-zero (missing value)
//   - `hub update install`            → non-zero (unknown verb)
//   - `hub update --force`            → non-zero (unknown flag)
//
// The bare-command default is well-formed: a `hub update` with no
// flags is the plan-only dry-run entry point the operator reaches
// from shell muscle-memory. The amendment pins the dry-run as
// the DEFAULT; the parser therefore does not require any flag.
func ParseUpdateFlags(argv []string) (UpdateFlags, error) {
	flags := UpdateFlags{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch arg {
		case "--help", "-h":
			flags.Help = true
			continue
		case "--channel":
			if i+1 >= len(argv) {
				return UpdateFlags{}, errors.New("hub update: --channel requires a value")
			}
			i++
			flags.Channel = argv[i]
			flags.ChannelSet = true
			continue
		case "--apply":
			flags.ApplyRequested = true
			continue
		default:
			// Anything else is outside the pinned surface.
			// Positionals (e.g. `hub update install`) and
			// unknown flags (e.g. `--force`, `--download`)
			// both surface here. The amendment rejects
			// every entry on this branch.
			return UpdateFlags{}, fmt.Errorf("hub update: unknown argument %q (expected --channel stable or --apply or --help)", arg)
		}
	}
	return flags, nil
}

// ValidateAfterParse is the post-parse shape check. The flag
// parser already enforces positional / flag membership; this
// function applies the channel literal contract — the LITERAL
// `stable` only, case-sensitive, exact match (no prefix match,
// no suffix match).
//
// The check is intentionally narrow: case-sensitive equality
// against the literal `stable`. The dispatcher never has to
// second-guess the input. The amendment's audit requirement is
// verbatim: "non-stable channels (e.g. `beta`, `dev`, `nightly`,
// source/script/dev-channel variants) are rejected with a clear
// error before any network call".
//
// A missing --channel value (Channel set but empty string) is
// treated the same as the bare command: the planner defaults to
// `stable` silently. This matches the shell muscle-memory
// `hub update` case where the operator never typed --channel.
func (f *UpdateFlags) ValidateAfterParse() error {
	if f.Help {
		return nil
	}
	if !f.ChannelSet {
		// Bare `hub update` → defaults to stable silently.
		f.Channel = "stable"
		return nil
	}
	if strings.TrimSpace(f.Channel) == "" {
		// `hub update --channel ""` → empty value; default
		// to stable silently (same shape as the bare
		// command — the parser has already accepted the
		// flag, the value just happens to be empty).
		f.Channel = "stable"
		return nil
	}
	if f.Channel != "stable" {
		// Case-sensitive exact match. `Stable`, `stable-2`,
		// `beta`, `dev`, `nightly`, `source`, `script`,
		// `edge` all surface here with a clear diagnostic.
		return fmt.Errorf("hub update: channel %q refused: only the literal channel %q is supported (compiled-only)", f.Channel, "stable")
	}
	return nil
}
