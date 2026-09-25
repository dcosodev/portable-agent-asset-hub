// Package backup is the T9 dispatcher surface for `hub backup`.
// Per docs/roadmap/slices.json slice `T9` the backup verb is
// exactly:
//
//	hub backup --out <archive>      (snapshot)
//	hub backup --restore <archive>  (restore)
//
// The package is the Go-side orchestrator: it parses argv, applies
// the fail-closed flag contract, resolves HUB_HOME/state/backups
// for the default archive location, then forks a small Node child
// (`backup_runner.mjs`) that performs the actual filesystem
// operations (tar.gz staging, atomic rename, atomic restore).
//
// The package deliberately does NOT open SQLite, derive a database
// path from HUB_HOME, or carry a parallel DB fallback. The single
// source of truth for the database path is
// `@portable-agent-asset-hub/core`'s `resolveHubDatabasePath`,
// reached through the .mjs child — never re-implemented here. This
// is the T9 slice's "no fallback / no parallel DB" invariant
// enforced by construction.
//
// Security invariants this package enforces by construction:
//
//   - Mode 0600 on every archive. The .mjs child enforces 0600
//     on the archive file before any bytes are written AND
//     re-stats the path after rename to refuse a silent
//     permission widening. The dispatcher never creates the
//     archive itself, so the contract is a single seam.
//
//   - Bearer hygiene (I-07). The runner strips every
//     HUB_BEARER_TOKEN* from the inherited environment before
//     forking the .mjs child. argv never carries a bearer-shaped
//     value (only absolute paths and JSON-encoded flags). Every
//     stderr line goes through output.Redact so a captured token
//     in a config file never reaches the operator.
//
//   - Token / secret exclusion (I-15). The snapshot set is the
//     resolver-canonical SQLite DB only — never a HUB_HOME DB,
//     never a parallel DB, never the tokens directory, never a
//     secret-shaped file. The child also carries a defensive
//     secret-shape predicate on the extraction side so a hostile
//     archive cannot smuggle secret-shaped entries back in
//     through restore.
//
//   - Bounded input. The runner caps child stdout at
//     MaxCaptureBytes and enforces a hard archive size cap
//     (512 MiB) inside the .mjs child so a runaway adapter cannot
//     exhaust the operator's tty or disk.
//
//   - Atomic output. The archive is staged to a sibling tmpfile
//     and renamed into place; a power loss mid-write leaves the
//     prior archive (or none) on disk, never a half-written file
//     visible to the operator.
//
//   - Secure extraction. The .mjs child uses `tar --no-absolute-
//     names --no-acls --no-xattrs --no-mac-metadata` and rejects
//     any entry whose resolved path escapes the staging root, so
//     a malicious archive cannot escape the destination.
//
// Determinism: every payload that leaves the dispatcher passes
// through output.Redact and the .mjs child emits sorted-key JSON,
// so two consecutive invocations on the same input produce
// byte-identical envelopes (modulo volatile bytes like
// createdAt / archiveBytes, which are real outcomes).
package backup

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// BackupAction enumerates the two and only two authorised
// directions for the backup verb. The string values double as the
// argv[1] passed to backup_runner.mjs so the .mjs child and the
// Go dispatcher share the exact same vocabulary.
type BackupAction string

const (
	// ActionSnapshot writes the canonical DB to <archive>.
	ActionSnapshot BackupAction = "snapshot"
	// ActionRestore copies <archive> over the canonical DB.
	ActionRestore BackupAction = "restore"
)

// BackupFlags is the parsed argv for `hub backup`. The struct is
// the single typed surface the dispatcher hands to the runner so
// the runner never has to re-walk argv.
type BackupFlags struct {
	// Action is the parsed direction (snapshot | restore). Empty
	// means the operator did not select a direction — the
	// dispatcher treats this as a contract violation because
	// the amendment pins exactly two mutually-exclusive
	// operations.
	Action BackupAction
	// Out is the explicit --out value (absolute path).
	// Required when Action == ActionSnapshot; ignored when
	// Action == ActionRestore.
	Out string
	// Restore is the explicit --restore value (absolute path).
	// Required when Action == ActionRestore; ignored when
	// Action == ActionSnapshot.
	Restore string
	// Help is true when --help / -h was set. The dispatcher
	// short-circuits to print the help block before any other
	// validation fires.
	Help bool
}

// ParseBackupFlags translates argv into a typed BackupFlags.
// The parser is strict: unknown flags, unknown positionals,
// missing values, and the mutually-exclusive combination of
// --out / --restore are all contract violations (exit 2).
//
// Empty argv (`hub backup` with no flags) defaults to
// ActionSnapshot so the dispatcher can derive the canonical
// default archive location ($HUB_HOME/state/backups/<ts>.tar.gz)
// — this matches the round-trip suite's "default archive
// location" case. The amendment pins the two flag forms and the
// default-location behaviour; the bare command is the
// no-argument entry point the operator reaches from a shell
// muscle-memory `hub backup` invocation.
//
// Accepted shapes:
//
//	--help, -h
//	  → { Help: true }
//
//	--out <archive>
//	  → { Action: ActionSnapshot, Out: <archive> }
//
//	--restore <archive>
//	  → { Action: ActionRestore, Restore: <archive> }
//
//	(none)
//	  → { Action: ActionSnapshot }   // default-location snapshot
//
// Everything else is a contract violation. The function never
// panics and never silently picks a non-default action.
func ParseBackupFlags(argv []string) (BackupFlags, error) {
	flags := BackupFlags{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch arg {
		case "--help", "-h":
			flags.Help = true
			continue
		case "--out":
			if i+1 >= len(argv) {
				return BackupFlags{}, errors.New("hub backup: --out requires a value")
			}
			if flags.Action != "" {
				return BackupFlags{}, errors.New("hub backup: --out and --restore are mutually exclusive")
			}
			i++
			flags.Action = ActionSnapshot
			flags.Out = argv[i]
			continue
		case "--restore":
			if i+1 >= len(argv) {
				return BackupFlags{}, errors.New("hub backup: --restore requires a value")
			}
			if flags.Action != "" {
				return BackupFlags{}, errors.New("hub backup: --out and --restore are mutually exclusive")
			}
			i++
			flags.Action = ActionRestore
			flags.Restore = argv[i]
			continue
		default:
			// Anything else is outside the pinned surface.
			// Positionals (e.g. `hub backup snapshot`) and
			// unknown flags (e.g. `--archive`, `--upload`)
			// both surface here. The amendment rejects
			// every entry on this branch.
			return BackupFlags{}, fmt.Errorf("hub backup: unknown argument %q (expected --out <archive> or --restore <archive>)", arg)
		}
	}
	// Empty argv (no flags at all) defaults to ActionSnapshot
	// so the dispatcher derives the canonical default archive
	// location. This is the operator muscle-memory entry point
	// (bare `hub backup` → snapshot to $HUB_HOME/state/backups/
	// <timestamp>.tar.gz). The mutual-exclusion guard above
	// already enforced that --out and --restore cannot both
	// appear; the only way to reach this branch with a non-help
	// Action set is when neither flag was passed. Help is
	// honoured as-is; the dispatcher short-circuits before
	// touching Action.
	if !flags.Help && flags.Action == "" {
		flags.Action = ActionSnapshot
	}
	return flags, nil
}

// ValidateAfterParse is the post-parse shape check. The flag
// parser already enforces mutual exclusion and value presence;
// this function normalises the value paths and refuses anything
// non-absolute so the runner never has to second-guess the input.
//
// Per-action shape:
//
//	ActionSnapshot  — Out MAY be empty. The dispatcher derives the
//	                  canonical default archive location
//	                  ($HUB_HOME/state/backups/<timestamp>.tar.gz)
//	                  when the operator omits --out, so a bare
//	                  `hub backup` is a well-formed snapshot
//	                  invocation. When Out is set, it MUST be an
//	                  absolute path.
//	ActionRestore   — Restore MUST be set and absolute. The
//	                  dispatcher NEVER reads Out for restore; Out
//	                  is a snapshot-only concept and the parse
//	                  contract treats the two as mutually exclusive.
//
// The check is intentionally narrow: absolute-path validation
// + non-empty value (where required) + clean Absolute form.
// Anything more (e.g. parent-traversal rejection) is handled by
// the .mjs child's own NUL/absolute checks so the dispatcher
// stays a transport.
func (f *BackupFlags) ValidateAfterParse() error {
	if f.Help {
		return nil
	}
	switch f.Action {
	case ActionSnapshot:
		if strings.TrimSpace(f.Out) != "" && !filepath.IsAbs(f.Out) {
			return fmt.Errorf("hub backup: --out value must be an absolute path, got %q", f.Out)
		}
	case ActionRestore:
		if strings.TrimSpace(f.Restore) == "" {
			return errors.New("hub backup: --restore value is empty")
		}
		if !filepath.IsAbs(f.Restore) {
			return fmt.Errorf("hub backup: --restore value must be an absolute path, got %q", f.Restore)
		}
	default:
		return fmt.Errorf("hub backup: internal error: action %q has no validated shape", f.Action)
	}
	return nil
}
