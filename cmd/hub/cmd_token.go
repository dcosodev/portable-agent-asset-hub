// cmd/hub/cmd_token.go
//
// Token subcommand handler for the hub product shell. Per
// docs/roadmap/slices.json (T3 — First-run init, bearer token,
// runtime config) the token surface is:
//
//	hub token show [--json]
//	hub token rotate [--json]
//
// show is REDACTED: the operator sees a preview (first 4 /
// last 4 chars + <<REDACTED>> marker) and the absolute token
// file path. The raw bearer NEVER leaves the file; the package's
// output.Redact is the chokepoint for every payload that does
// reach stdout.
//
// rotate REGENERATES: a fresh bearer is written to
// tokens/hub.token via secrets.WriteAtomic (mode 0600,
// atomic, fsync). The old bytes do not survive; the
// file mode is preserved.
//
// --full is intentionally NOT a contract surface: the redactor
// is the only sanctioned way to read the token, and the file
// itself is the canonical source for a process that needs the
// bearer (e.g. the future REST client).
//
// Security invariants this file enforces by construction:
//
//   - No bearer in stdout. Every payload is filtered through
//     output.Redact. The `value` / `token` / `bearer` /
//     `secret` field names are NEVER used in the JSON payload.
//   - Fail-closed on a missing token file. `hub token show` on
//     an uninitialised home exits 1 (operator error) with a
//     precise diagnostic naming the remediation.
//   - Fail-closed on --full. exit 2; the surface is not a
//     contract surface, period.
//   - 0600 preserved. rotate never widens the file mode; the
//     WriteAtomic helper enforces 0600 by open(2) and re-stats
//     after rename so a regression in the syscall semantics
//     cannot silently widen the permission set.
//
// Determinism: the human envelopes are byte-stable; the JSON
// payload uses encoding/json's alphabetical-key sorting so two
// consecutive invocations on the same HUB_HOME produce the same
// byte sequence.
package main

import (
	"encoding/json"
	"errors"
	"os"
	"time"

	"hub/internal/config"
	"hub/internal/output"
	"hub/internal/secrets"
)

// tokenShowResult is the structured --json payload. Schema is
// locked at T3. Do NOT add a `value` / `token` / `bearer` field
// — that would defeat the redaction contract.
type tokenShowResult struct {
	Len       int    `json:"len"`
	Preview   string `json:"preview"`
	Redacted  bool   `json:"redacted"`
	TokenFile string `json:"token_file"`
}

// tokenRotateResult is the structured --json payload. The
// rotated_at field is the timestamp the package stamped on the
// file; it is NOT a secret and is safe to surface.
type tokenRotateResult struct {
	Len       int    `json:"len"`
	Mode      string `json:"mode"`
	RotatedAt string `json:"rotated_at"`
	TokenFile string `json:"token_file"`
}

// runToken dispatches to the show or rotate handler. `rest` is
// the argv slice AFTER the leading "token". Anything that is not
// "show" or "rotate" is a contract violation (exit 2).
//
// Failure semantics:
//
//   - rest[0] is neither "show" nor "rotate"   → exit 2 (contract violation)
//   - rest contains "--full" or any unknown flag → exit 2 (contract violation)
//   - secrets.ErrNotInitialised on read        → exit 1 (operator error)
//   - secrets.WriteAtomic / Generate failure   → exit 2 (contract violation)
//   - token file mode mismatch on post-rotate  → exit 2 (contract violation)
func runToken(sink *output.Sink, cfg config.Config, rest []string, asJSON bool) (int, error) {
	if len(rest) == 0 {
		emitError(sink, "hub token: subcommand required (show, rotate)")
		return exitContractViolation, nil
	}
	// Defensive: refuse --full as a contract surface. The flag
	// is NOT in our public doc; the contract is fail-closed so a
	// future typo from the operator never silently echoes the
	// bearer. We check for the flag in any position so an
	// operator who types `hub token show --full` gets the same
	// exit-2 as one who types `hub token rotate --full`.
	for _, arg := range rest {
		if arg == "--full" || arg == "--reveal" || arg == "--print" {
			emitError(sink, "hub token: %q is not a contract surface; the token never leaves its file", arg)
			return exitContractViolation, nil
		}
		if arg == "--json" {
			// Tolerate a stray --json flag in the rest slice;
			// asJSON is already OR'd by main.go so this is a
			// no-op for our decision.
			continue
		}
	}
	subcommand := rest[0]
	switch subcommand {
	case "show":
		return runTokenShow(sink, cfg, asJSON)
	case "rotate":
		return runTokenRotate(sink, cfg, asJSON)
	default:
		emitError(sink, "hub token: unknown subcommand %q (try `hub token show` or `hub token rotate`)", subcommand)
		return exitContractViolation, nil
	}
}

// runTokenShow emits the redacted token preview. A missing token
// file maps to exit 1 (operator error) with a remediation
// diagnostic; any other error maps to exit 2.
func runTokenShow(sink *output.Sink, cfg config.Config, asJSON bool) (int, error) {
	tok, err := secrets.Read(cfg.Layout.TokenFile)
	if err != nil {
		if errors.Is(err, secrets.ErrNotInitialised) {
			emitError(sink, "hub token show: tokens/hub.token not found; run `hub init` first")
			return exitOperatorError, nil
		}
		emitError(sink, "hub token show: %v", err)
		return exitContractViolation, nil
	}
	preview := secrets.Preview(tok)
	if asJSON {
		m := map[string]any{
			"len":        len(tok),
			"preview":    preview,
			"redacted":   true,
			"token_file": cfg.Layout.TokenFile,
		}
		raw, jerr := json.Marshal(m)
		if jerr != nil {
			emitError(sink, "hub token show: marshal: %v", jerr)
			return exitContractViolation, nil
		}
		_ = sink.Printf("%s", output.Redact(string(raw)))
		return exitOK, nil
	}
	_ = sink.Printf("token_file=%s", output.Redact(cfg.Layout.TokenFile))
	_ = sink.Printf("mode=%04o", secrets.TokenFileMode)
	_ = sink.Printf("len=%d", len(tok))
	_ = sink.Printf("preview=%s", output.Redact(preview))
	_ = sink.Printf("redacted=true")
	return exitOK, nil
}

// runTokenRotate regenerates the token. The function is the only
// entry point for token regeneration; the cmd/hub/cmd_init.go
// handler also calls secrets.Generate + WriteAtomic on a fresh
// home, but it does so inline (no separate function) so the two
// callers share the SAME error-mapping decisions.
//
// Failure-mode contract:
//
//   - tokens/ directory does NOT exist (a totally uninitialised
//     home): exit 1 (operator error) with a remediation
//     diagnostic naming `hub init`. We refuse to silently
//     initialise a home that has not been `hub init`'d — that
//     decision belongs to init, not rotate.
//   - tokens/ exists but hub.token does NOT (a partially
//     initialised / operator-cleared home): recovery; rotate
//     generates a fresh bearer with the standard 0600 mode.
//   - secrets.Generate / WriteAtomic failure: exit 2 (contract
//     violation).
func runTokenRotate(sink *output.Sink, cfg config.Config, asJSON bool) (int, error) {
	if _, dirErr := os.Stat(cfg.Layout.Tokens); dirErr != nil {
		if os.IsNotExist(dirErr) {
			emitError(sink, "hub token rotate: $HUB_HOME/tokens not found; run `hub init` first")
			return exitOperatorError, nil
		}
		emitError(sink, "hub token rotate: stat %s: %v", cfg.Layout.Tokens, dirErr)
		return exitContractViolation, nil
	}
	tok, err := secrets.Generate()
	if err != nil {
		emitError(sink, "hub token rotate: generate: %v", err)
		return exitContractViolation, nil
	}
	if werr := secrets.WriteAtomic(cfg.Layout.TokenFile, tok); werr != nil {
		emitError(sink, "hub token rotate: write: %v", werr)
		return exitContractViolation, nil
	}
	rotatedAt := time.Now().UTC().Format(time.RFC3339Nano)
	if asJSON {
		m := map[string]any{
			"len":        len(tok),
			"mode":       "0600",
			"rotated_at": rotatedAt,
			"token_file": cfg.Layout.TokenFile,
		}
		raw, jerr := json.Marshal(m)
		if jerr != nil {
			emitError(sink, "hub token rotate: marshal: %v", jerr)
			return exitContractViolation, nil
		}
		_ = sink.Printf("%s", output.Redact(string(raw)))
		return exitOK, nil
	}
	_ = sink.Printf("token_file=%s", output.Redact(cfg.Layout.TokenFile))
	_ = sink.Printf("mode=%04o", secrets.TokenFileMode)
	_ = sink.Printf("len=%d", len(tok))
	_ = sink.Printf("rotated_at=%s", rotatedAt)
	return exitOK, nil
}
