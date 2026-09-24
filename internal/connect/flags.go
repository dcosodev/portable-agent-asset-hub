// Package connect is the T8 owner of `hub hub connect …` — a thin
// orchestrator that drives the existing TypeScript materializers via
// a small child Node process (internal/connect/connect_runner.mjs).
//
// The package exists because the T8 contract surfaces a brand-new
// CLI shape (subcommand-root `hub` followed by `connect`) without
// touching forbidden paths. Everything here is additively wired
// into cmd/hub via cmd/hub/cmd_connect.go; the existing T0–T7
// dispatcher in cmd/hub/main.go is preserved verbatim.
//
// This file owns only the argv parser. The parser is strict on
// flag names (every unknown flag is a contract violation), narrow
// on semantics (the slice mandates a closed-by-default apply), and
// pure (no subprocess, no filesystem, no env probe beyond the
// resolver indirection in runner.go).
package connect

import (
	"errors"
	"fmt"
	"strings"
)

// Action names the three T8 verbs. The type is exported so
// cmd/hub/cmd_connect.go can branch on the value without
// re-typing the strings.
type Action string

const (
	ActionNone     Action = ""
	ActionPreview  Action = "preview"
	ActionApply    Action = "apply"
	ActionRollback Action = "rollback"
)

// ConnectFlags is the parsed argv for `hub hub connect …`.
//
// The struct is the canonical argument contract for T8 and mirrors
// the field set the slice commits to. New fields land here on a
// documented T8.x change.
type ConnectFlags struct {
	// Action is the resolved sub-verb (preview | apply | rollback).
	// An empty value plus Help=true means "no action, just print
	// the root help block".
	Action Action
	// JSON toggles the structured-payload form on every verb. The
	// Go dispatcher honours it both ways (top-level and inline).
	JSON bool
	// Help is set when --help / -h is present anywhere in rest.
	// The verb-specific help block wins over the root help block
	// when both are requested.
	Help bool

	// Harness is the renderer id ("hermes" or "openclaw"). The
	// slice authorises the hermes harness today; "openclaw" is
	// recognised by the parser but apply refused before the
	// adapter is invoked. The preview path accepts it and lets
	// the underlying materializer validate.
	Harness string
	// Profile is the prf_… profile id. The regex is enforced here
	// (closed-by-default) before any subprocess is spawned.
	Profile string
	// Snapshot is the snap_… snapshot id. Same regex policy.
	Snapshot string
	// TargetRoot is the absolute filesystem path the connector
	// operates against. The apply + preview paths require it;
	// rollback does not (runId is the only required input).
	TargetRoot string
	// LockDir is the absolute lock directory. The slice mandates
	// it for apply so concurrent writers cannot stomp on each
	// other; the preview path ignores it.
	LockDir string
	// Reason is the operator-supplied audit reason for every mutating
	// verb. The slice requires it; missing reason is exit 2.
	Reason string
	// RequestID is an optional correlation id the operator can pin
	// to a CI run or ticket.
	RequestID string
	// ReviewedDigest is the close-by-default cas-pin for apply.
	// The slice requires it (lowercase hex exactly 64 chars) and
	// the parser refuses any other shape; the adapter would
	// surface a mismatch but the audit contract demands the
	// refusal happen in the Go shell.
	ReviewedDigest string
	// ObservedDigest is the optional drift signal for apply. The
	// slice exposes it; missing it means "trust the preview as
	// the live state" (no drift check).
	ObservedDigest string
	// RunID is the rollback target. The parser enforces the
	// run_<id> regex at this boundary so an invalid value never
	// reaches the adapter.
	RunID string
}

// ParseConnectFlags splits the argv slice for `hub hub connect
// …` into (verb, flags, error).
//
// Accepted shapes:
//
//	["preview", "--harness", "hermes", "--profile", "prf_…",
//	 "--snapshot", "snap_…", "--target-root", <abs path>, …]
//	["apply",    same + "--reviewed-digest", <64-hex>,
//	              "--reason", <text>, "--request-id", <id>,
//	              optional "--observed-digest", <64-hex>,
//	              optional "--lock-dir", <abs path>]
//	["rollback", "--run-id", "run_…", "--reason", <text>,
//	              "--request-id", <id>]
//	["--help"] / ["-h"]                            → Help=true, Action=""
//
// Exit-code mapping (the caller turns these into 1/2):
//
//   - "missing action"       → contract violation
//   - "unknown action"       → contract violation
//   - "unknown flag"         → contract violation
//   - "missing required flag"→ contract violation
//   - "format violation"     → contract violation
//
// The parser is purely lexical — it never inspects the
// filesystem. The runner validates filesystem-shape concerns
// (existence, symlinks) via the underlying adapter.
func ParseConnectFlags(argv []string) (ConnectFlags, error) {
	f := ConnectFlags{}
	if len(argv) == 0 {
		// No verb at all → leave Action="" + Help=false so the
		// dispatcher can emit the documented "no action" diagnostic
		// (matches the harness's exit-2 expectation).
		return f, nil
	}

	// First non-flag argument is the action.
	first := argv[0]
	if !strings.HasPrefix(first, "-") {
		switch first {
		case string(ActionPreview), string(ActionApply), string(ActionRollback):
			f.Action = Action(first)
			argv = argv[1:]
		default:
			// Unknown verb → contract violation. We keep the
			// message terse so the bearer-hygiene regex set
			// stays clean (no env-var-shaped substrings).
			return ConnectFlags{}, fmt.Errorf("hub hub connect: unknown action %q (expected preview|apply|rollback)", first)
		}
	}

	rest := argv
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
		case "--help", "-h":
			f.Help = true
		case "--json":
			if f.JSON {
				return ConnectFlags{}, errors.New("hub hub connect: --json specified twice")
			}
			f.JSON = true
		case "--harness":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.Harness = val
		case "--profile":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.Profile = val
		case "--snapshot":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.Snapshot = val
		case "--target-root":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.TargetRoot = val
		case "--lock-dir":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.LockDir = val
		case "--reason":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.Reason = val
		case "--request-id":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.RequestID = val
		case "--reviewed-digest":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.ReviewedDigest = val
		case "--observed-digest":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.ObservedDigest = val
		case "--run-id":
			val, err := takeValue(rest, &i, inline)
			if err != nil {
				return ConnectFlags{}, err
			}
			f.RunID = val
		case "--":
			return ConnectFlags{}, errors.New("hub hub connect: '--' is not accepted (pass positional args without '--')")
		default:
			if strings.HasPrefix(arg, "-") {
				return ConnectFlags{}, fmt.Errorf("hub hub connect: unknown flag %q", rest[i])
			}
			// Positional residue is fail-closed — the verb is
			// positional-at-index-0 only. Everything after the
			// verb must be a flag.
			return ConnectFlags{}, fmt.Errorf("hub hub connect: unexpected positional %q", rest[i])
		}
	}

	return f, nil
}

// takeValue is the standard `--flag value` / `--flag=value` helper.
// It advances `*i` when a separate value token follows and returns
// the value with no interpretation; the caller decides what
// shape to enforce.
func takeValue(rest []string, i *int, inline string) (string, error) {
	val := inline
	if val == "" {
		idx := *i + 1
		if idx >= len(rest) {
			return "", fmt.Errorf("hub hub connect: %s requires a value", rest[*i])
		}
		*i = idx
		val = rest[idx]
	}
	if val == "" {
		return "", fmt.Errorf("hub hub connect: %s requires a non-empty value", rest[*i])
	}
	return val, nil
}

// ValidateAfterParse runs the slice-mandated closed-by-default
// checks that the parser cannot enforce on its own:
//
//   - Unknown-action is handled by ParseConnectFlags itself (when
//     argv is empty there is NO action). The harness expects that
//     surface to emit an exit-2 diagnostic.
//   - Action is empty AND not a --help request — refuse with a
//     precise message naming the missing selector.
//   - Each verb's required flags must be present AND format-clean.
//   - The apply verb additionally requires --reviewed-digest to
//     match the SHA-256 regex AND lowercase only.
//
// The function returns an error string (NOT a flag) so the
// dispatcher can route every "missing required flag" failure into
// exit 2 (contract violation) with a precise diagnostic.
func (f ConnectFlags) ValidateAfterParse() error {
	if f.Action == ActionNone {
		if f.Help {
			return nil // root --help has no required flags
		}
		return errors.New("hub hub connect: action required (preview|apply|rollback)")
	}
	// Verb-scoped --help: skip required-flag enforcement so the
	// operator can read the help block even when their typed
	// preview/apply/rollback invocation is missing the required
	// flags. The slice pins the help surface; a regression that
	// flags a help request as a missing-flag contract violation
	// would defeat the operator's ability to recover.
	if f.Help {
		return nil
	}
	switch f.Action {
	case ActionPreview:
		return previewMissing(f)
	case ActionApply:
		return applyMissing(f)
	case ActionRollback:
		return rollbackMissing(f)
	}
	return fmt.Errorf("hub hub connect: unknown action %q", f.Action)
}

func previewMissing(f ConnectFlags) error {
	missing := ""
	if f.Harness == "" {
		missing += " --harness"
	}
	if f.Profile == "" {
		missing += " --profile"
	}
	if f.Snapshot == "" {
		missing += " --snapshot"
	}
	if f.TargetRoot == "" {
		missing += " --target-root"
	}
	if missing != "" {
		return fmt.Errorf("hub hub connect preview: missing required flag(s):%s", missing)
	}
	// Format checks. prf_/snap_ regexes mirror packages/materializers/src/preview.ts.
	if !profileIDRegex.MatchString(f.Profile) {
		return fmt.Errorf("hub hub connect preview: --profile %q does not match prf_[A-Za-z0-9._-]+", f.Profile)
	}
	if !snapshotIDRegex.MatchString(f.Snapshot) {
		return fmt.Errorf("hub hub connect preview: --snapshot %q does not match snap_[A-Za-z0-9._-]+", f.Snapshot)
	}
	switch f.Harness {
	case "hermes":
		// recognised, dispatch proceeds
	case "openclaw":
		// parser accepts; adapter validates (OpenClaw surface is
		// out of scope for T8.x but the regex stays closed).
	default:
		return fmt.Errorf("hub hub connect preview: --harness %q not recognised (expected hermes|openclaw)", f.Harness)
	}
	return nil
}

func applyMissing(f ConnectFlags) error {
	missing := ""
	if f.Harness == "" {
		missing += " --harness"
	}
	if f.Profile == "" {
		missing += " --profile"
	}
	if f.Snapshot == "" {
		missing += " --snapshot"
	}
	if f.TargetRoot == "" {
		missing += " --target-root"
	}
	if f.Reason == "" {
		missing += " --reason"
	}
	if f.ReviewedDigest == "" {
		missing += " --reviewed-digest"
	}
	if missing != "" {
		return fmt.Errorf("hub hub connect apply: missing required flag(s):%s", missing)
	}
	// Format checks (mirror apply-reviewed-digest.test.ts expectations).
	if !profileIDRegex.MatchString(f.Profile) {
		return fmt.Errorf("hub hub connect apply: --profile %q does not match prf_[A-Za-z0-9._-]+", f.Profile)
	}
	if !snapshotIDRegex.MatchString(f.Snapshot) {
		return fmt.Errorf("hub hub connect apply: --snapshot %q does not match snap_[A-Za-z0-9._-]+", f.Snapshot)
	}
	if !digestRegex.MatchString(f.ReviewedDigest) {
		return fmt.Errorf("hub hub connect apply: --reviewed-digest must be exactly 64 lowercase hex characters")
	}
	if f.ObservedDigest != "" && !digestRegex.MatchString(f.ObservedDigest) {
		return fmt.Errorf("hub hub connect apply: --observed-digest must be exactly 64 lowercase hex characters")
	}
	switch f.Harness {
	case "hermes":
		// recognised, dispatch proceeds
	default:
		return fmt.Errorf("hub hub connect apply: --harness %q not recognised (expected hermes)", f.Harness)
	}
	return nil
}

func rollbackMissing(f ConnectFlags) error {
	missing := ""
	if f.RunID == "" {
		missing += " --run-id"
	}
	if f.Reason == "" {
		missing += " --reason"
	}
	if f.RequestID == "" {
		missing += " --request-id"
	}
	if missing != "" {
		return fmt.Errorf("hub hub connect rollback: missing required flag(s):%s", missing)
	}
	if !runIDRegex.MatchString(f.RunID) {
		return fmt.Errorf("hub hub connect rollback: --run-id %q does not match run_[A-Za-z0-9._-]+", f.RunID)
	}
	// The slice pins rollback's flag surface as minimal (--run-id,
	// --reason, --request-id, --json). --target-root is a parser-
	// level reject: the global argv parser accepts --target-root on
	// every verb, so we MUST gate it here before any child process
	// is spawned or any receipt is read — otherwise an operator
	// could pre-declare a target and the rollback would proceed
	// against the wrong resource.
	if f.TargetRoot != "" {
		return errors.New("hub hub connect rollback: --target-root is not valid for rollback")
	}
	return nil
}
