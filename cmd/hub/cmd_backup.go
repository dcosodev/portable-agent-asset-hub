// cmd/hub/cmd_backup.go
//
// T9 dispatcher for `hub backup --out <archive>` and
// `hub backup --restore <archive>`.
//
// The backup verb is a thin orchestrator: parse argv in the Go
// shell, derive the default archive location under
// $HUB_HOME/state/backups when --out is omitted, probe the
// canonical DB path through a tiny Node consumer so the Go side
// NEVER opens SQLite or derives a DB path from HUB_HOME, fork
// the `internal/backup/backup_runner.mjs` child with a JSON
// request payload, capture the response, render the result
// (human-readable or redacted JSON envelope), and translate
// exit codes. No digest computation, no SQLite handle, no
// archive staging — the Go side is purely transport + receipt
// rendering.
//
// Exit-code contract (mirrors docs/architecture/go-product-shell.md):
//
//   0  success — snapshot written or restore applied (per the
//                pinned flag)
//   1  operator / runtime error — Node missing, runner
//                                missing, probe failure, child
//                                non-zero with operator-class
//                                error code
//   2  contract violation — bad flags, unknown positional,
//                           mutually-exclusive --out/--restore,
//                           bad archive path, missing required
//                           flag
//
// The dispatcher NEVER reaches into a forbidden path (no
// SqliteStore import, no `packages/storage-sqlite/**` import,
// no domain materializer implementation, no direct SQLite
// handle). It only consumes the `internal/backup.BackupFlags`
// and `Runner` surface that the amendment authorises.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hub/internal/backup"
	"hub/internal/config"
	"hub/internal/output"
)

// runBackup is the dispatcher for `hub backup …`. The argv
// slice is the REST of the dispatcher's argv (i.e. everything
// after `hub backup`). The function owns:
//  1. argv → BackupFlags translation (fail-closed on bad
//     flags, unknown positionals, missing values, mutually-
//     exclusive combinations).
//  2. Default archive location derivation
//     ($HUB_HOME/state/backups/<timestamp>.tar.gz) when --out
//     is omitted on a snapshot.
//  3. Canonical DB probing through the Node child so the Go
//     side NEVER opens SQLite.
//  4. Adapter invocation through the backup.Runner.
//  5. JSON / human-channel rendering with bearer redaction.
func runBackup(sink *output.Sink, stdout, stderr io.Writer, cfg config.Config, rest []string) (int, error) {
	flags, err := backup.ParseBackupFlags(rest)
	if err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}
	if flags.Help {
		printBackupHelp(sink)
		return exitOK, nil
	}

	// Archive path derivation. The two actions read from
	// DIFFERENT fields:
	//
	//   ActionSnapshot  → flags.Out, with a fallback to the
	//                    canonical default archive location
	//                    $HUB_HOME/state/backups/<timestamp>.tar.gz
	//                    when the operator omitted --out. The
	//                    fallback lives in the dispatcher (not
	//                    in flags.go) so the flag struct stays
	//                    a pure argv parser.
	//   ActionRestore   → flags.Restore. The dispatcher MUST
	//                    NEVER read flags.Out for restore; Out
	//                    is a snapshot-only concept and the
	//                    parse contract treats the two as
	//                    mutually exclusive.
	//
	// The default-location derivation also happens here, before
	// ValidateAfterParse runs, so the validator sees a fully
	// populated path on a snapshot (a bare `hub backup` is
	// well-formed; the dispatcher has the configuration it
	// needs to resolve the canonical location).
	var archivePath string
	switch flags.Action {
	case backup.ActionSnapshot:
		archivePath = flags.Out
		if strings.TrimSpace(archivePath) == "" {
			defaultPath, derr := defaultBackupArchivePath(cfg.Layout.State)
			if derr != nil {
				emitError(sink, "hub backup: %v", derr)
				return exitOperatorError, nil
			}
			archivePath = defaultPath
		}
	case backup.ActionRestore:
		archivePath = flags.Restore
	}
	if err := flags.ValidateAfterParse(); err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}

	// Canonical DB probing. The .mjs child will re-probe via
	// resolveHubDatabasePath, but probing here lets us surface
	// "database not found" failures BEFORE we fork the heavy
	// adapter so the operator sees a clean exit-1 diagnostic
	// instead of an adapter-side failure. The probe is
	// read-only (does not open SQLite, does not import the
	// storage adapter); it only imports
	// `@portable-agent-asset-hub/core`'s
	// resolveHubDatabasePath.
	runner := backup.NewRunner(repoRoot)
	dbPath, dbErr := runner.ProbeDatabase(backupRunContext())
	if dbErr != nil {
		emitError(sink, "hub backup: %v", dbErr)
		return exitOperatorError, nil
	}

	ctx := backupRunContext()
	var result backup.RunResult
	switch flags.Action {
	case backup.ActionSnapshot:
		result, err = runner.RunSnapshot(ctx, dbPath, archivePath)
	case backup.ActionRestore:
		result, err = runner.RunRestore(ctx, dbPath, archivePath)
	default:
		emitError(sink, "hub backup: internal error: unhandled action %q", flags.Action)
		return exitContractViolation, nil
	}
	if err != nil {
		// Transport-level failure: Node missing, runner
		// missing, IO failure. The slice classifies these as
		// operator / runtime errors (exit 1) so a CI pipeline
		// can distinguish "the adapter refused" (exit 1 +
		// payload) from "the harness is broken" (exit 1 +
		// no payload).
		emitError(sink, "%v", err)
		return exitOperatorError, nil
	}
	if result.Exit != 0 {
		// Adapter refusal. Emit the structured payload on
		// the appropriate channel. The .mjs child emits a
		// JSON envelope with { code, message, httpCode,
		// action, ... }; we forward it verbatim on stderr
		// (the diagnostic channel) so the operator sees
		// the adapter's typed error.
		if len(result.PayloadJSON) > 0 {
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
		// Exit-code mapping: the .mjs child uses exit 2 for
		// CLI contract violations detected downstream (e.g.
		// malformed request); the dispatcher surfaces those
		// as exit 2 too. Everything else is exit 1.
		if result.Exit == 2 {
			return exitContractViolation, nil
		}
		return exitOperatorError, nil
	}

	// Success path. Emit the human-readable summary on
	// stdout. The .mjs child emits a sorted-key JSON envelope;
	// the dispatcher parses it and renders a small key/value
	// block. The envelope bytes themselves are NEVER emitted
	// on stdout — the contract surface is the human summary
	// (operators read the terminal) and a quiet success does
	// not leak the resolved DB path or archive bytes onto
	// stdout. The structured envelope is available for future
	// `--json` support without changing this dispatcher.
	emitBackupSummary(stdout, flags.Action, result.PayloadJSON)
	return exitOK, nil
}

// emitBackupSummary renders the .mjs child's success envelope
// to a human-readable summary on stdout. The function is
// intentionally tiny: it parses the envelope and prints one
// `key=value` line per field. Bearer redaction is applied to
// every value through output.Redact so a captured token in a
// value never reaches the operator.
//
// Fail-closed: an envelope parse failure emits a structured
// diagnostic and returns; stdout is empty in that case so a
// downstream pipeline that gates on stdout != "" for success
// sees a clear failure.
func emitBackupSummary(stdout io.Writer, action backup.BackupAction, payload []byte) {
	if len(payload) == 0 {
		return
	}
	var env map[string]any
	if err := json.Unmarshal(payload, &env); err != nil {
		// Silent fallback: do not emit a partial / malformed
		// summary. The exit code is the contract surface
		// for downstream consumers; the stdout envelope is
		// for humans.
		return
	}
	// Order matters for grep-friendliness: action first,
	// then the path-shaped fields, then the volatile
	// fields (createdAt / archiveBytes / dbBytes).
	order := []string{"action", "code", "archivePath", "dbPath", "archiveMode", "archiveBytes", "dbBytes", "createdAt", "restoredAt", "message"}
	seen := map[string]bool{}
	_ = action
	for _, key := range order {
		val, ok := env[key]
		if !ok {
			continue
		}
		seen[key] = true
		s := fmt.Sprintf("%v", val)
		fmt.Fprintf(stdout, "%s=%s\n", key, output.Redact(s))
	}
	// Emit any extra keys deterministically (sorted) so the
	// summary remains stable across envelope revisions
	// without silently dropping a new field.
	extras := make([]string, 0, len(env))
	for k := range env {
		if !seen[k] {
			extras = append(extras, k)
		}
	}
	for _, k := range extras {
		s := fmt.Sprintf("%v", env[k])
		fmt.Fprintf(stdout, "%s=%s\n", k, output.Redact(s))
	}
}

// defaultBackupArchivePath returns the canonical
// $HUB_HOME/state/backups/<timestamp>.tar.gz path. The
// function is the single source of truth for the default
// location; the .mjs child never re-derives it.
//
// The timestamp format is `YYYYMMDDTHHMMSSZ` (UTC, lexically
// sortable, no colons so the path is portable across POSIX
// filesystems that may reject colons). The test suite accepts
// any digit-bearing stem ending in `.tar.gz`; the chosen
// format guarantees compliance without inventing a format the
// contract never specified.
func defaultBackupArchivePath(stateDir string) (string, error) {
	if strings.TrimSpace(stateDir) == "" {
		return "", fmt.Errorf("default archive location unavailable: state directory is empty")
	}
	backupsDir := filepath.Join(stateDir, "backups")
	if err := os.MkdirAll(backupsDir, 0o700); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", backupsDir, err)
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	return filepath.Join(backupsDir, stamp+".tar.gz"), nil
}

// backupRunContext is the dispatcher-side ctx factory for the
// backup runner. The slice keeps ctx threading explicit so a
// future signal-handling enhancement can cancel a runaway
// adapter without changing every call site. Today it returns
// context.Background() — there is no operator signal surface
// wired into the dispatch path.
func backupRunContext() context.Context { return context.Background() }

// printBackupHelp writes the help block to stdout. The text is
// a fixed string so the T9 test suite can assert on its shape
// without snapshot drift. The amendment pins exactly two flags
// (--out, --restore); the help block enumerates both so an
// operator can reconstruct the surface from `hub backup --help`
// alone.
func printBackupHelp(sink *output.Sink) {
	for _, line := range []string{
		"hub backup — snapshot / restore the canonical resolver database",
		"",
		"Usage:",
		"  hub backup                      snapshot to the default archive location",
		"                                  ($HUB_HOME/state/backups/<timestamp>.tar.gz)",
		"  hub backup --out <archive>      snapshot the canonical DB to <archive>",
		"  hub backup --restore <archive>  restore the canonical DB from <archive>",
		"  hub backup --help               print this help block",
		"",
		"Default archive location:",
		"  $HUB_HOME/state/backups/<timestamp>.tar.gz",
		"  (used when --out is omitted; <timestamp> is UTC YYYYMMDDTHHMMSSZ)",
		"",
		"Archive mode:",
		"  0600 (owner read/write only). The archive is staged to a sibling",
		"  tmpfile and renamed into place; a power loss mid-write leaves the",
		"  prior archive (or none) on disk.",
		"",
		"Snapshot set:",
		"  resolver-canonical SQLite database + config files only.",
		"  No HUB_HOME DB, no alternate / parallel DB, no fallback.",
		"  Excludes $HUB_HOME/tokens/** and every secret-shaped file",
		"  (*.pem, *token*, *secret*, *.env, *.key).",
		"",
		"Environment:",
		"  HUB_HOME              hub home root (default archive parent)",
		"  AGENT_MEMORY_DB_PATH  explicit canonical DB path (forwarded to the",
		"                        resolver; takes precedence over HUB_HOME)",
		"  AGENT_MEMORY_DATA_DIR configured data dir (forwarded to the resolver)",
		"  HUB_NODE_BIN          override the Node binary path",
		"  HUB_BACKUP_RUNNER     override backup_runner.mjs path",
		"",
		"Exit codes:",
		"  0  success — snapshot written or restore applied",
		"  1  operator / runtime error (Node missing, IO failure, missing DB)",
		"  2  contract violation (bad flags, unknown verb, format violation)",
	} {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}
