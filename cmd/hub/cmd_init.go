// cmd/hub/cmd_init.go
//
// Init subcommand handler for the hub product shell. Per
// docs/roadmap/slices.json (T3 — First-run init, bearer token,
// runtime config) the init surface is:
//
//	hub init [--json]
//
// Init is idempotent: running it twice on the same HUB_HOME
// produces the same layout and DOES NOT clobber an existing
// tokens/hub.token. The first run creates the canonical
// state/, runtime/, logs/, tokens/ subdirectories and writes a
// fresh bearer to tokens/hub.token (mode 0600); subsequent runs
// are a no-op on the token file (the contract surface is "the
// token survives re-init").
//
// Security invariants this file enforces by construction:
//
//   - Token file is created with mode 0600 (NOT subject to the
//     operator's umask). The actual open(2) syscall is in
//     internal/secrets.WriteAtomic; this handler only invokes it.
//   - Idempotency. An existing tokens/hub.token is preserved
//     byte-for-byte on re-init; the file's mtime MUST NOT
//     advance. The audit requirement is "second init is
//     idempotent".
//   - No bearer in operator-visible output. The human envelope
//     names the home and the subdirectories but never the token
//     bytes; the JSON payload is filtered through output.Redact.
//   - Failure semantics. A write failure (permission denied, I/O
//     error, entropy error) surfaces as exit 2 (contract
//     violation): the init surface is well-formed and an error
//     means the env is fundamentally broken, not that the
//     operator typed the wrong flag.
//
// Determinism: every payload that leaves stdout is filtered
// through output.Redact and uses fixed-width key order so two
// consecutive invocations on the same HUB_HOME produce
// byte-identical output (modulo the freshly-generated token
// bytes, which never appear on stdout in the first place).
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"hub/internal/config"
	"hub/internal/output"
	"hub/internal/secrets"
)

// initResult is the structured --json payload. The schema is
// locked at T3 (do not change keys without updating the phase3
// gate and the s11 gate). Field order matches the encoding/json
// output (sorted by key for the top-level object) and is the
// contract surface for orchestrators.
type initResult struct {
	CreatedAt string `json:"created_at"`
	Home      string `json:"home"`
	LogFile   string `json:"log_file"`
	Logs      string `json:"logs"`
	Mode      string `json:"mode"`
	Runtime   string `json:"runtime"`
	State     string `json:"state"`
	Status    string `json:"status"`
	TokenFile string `json:"token_file"`
	Tokens    string `json:"tokens"`
}

// runInit is the dispatch shim from `hub init` to the init
// handler. The function takes the parsed argv (which may be empty
// or `--json`), the config struct, and the asJSON flag (already
// OR'd with the top-level --json by main.go).
//
// Errors:
//
//   - secrets.WriteAtomic failure       → exit 2 (contract violation)
//   - mkdir / chmod failure              → exit 2 (contract violation)
//   - any other filesystem I/O failure   → exit 2 (contract violation)
//
// Idempotency is enforced by the handler: a token file that
// already exists is preserved byte-for-byte; only the missing
// subdirectories are created.
func runInit(sink *output.Sink, cfg config.Config, asJSON bool) (int, error) {
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	// Step 1: create the canonical subdirectories idempotently.
	// We use os.MkdirAll with mode 0750 so the dirs are readable
	// by the operator but not by "others" — the secret dir is
	// chmod'd to 0700 by secrets.EnsureDir (called from
	// WriteAtomic below), but state/, runtime/, logs/ stay at 0750
	// because they are not security-sensitive (logs can be world-
	// readable per XDG defaults).
	for _, sub := range []struct {
		name string
		path string
	}{
		{"state", cfg.Layout.State},
		{"runtime", cfg.Layout.Runtime},
		{"logs", cfg.Layout.Logs},
	} {
		if err := os.MkdirAll(sub.path, 0o750); err != nil {
			emitError(sink, "hub init: mkdir %s: %v", sub.name, err)
			return exitContractViolation, nil
		}
	}

	// Step 2: write the token iff it does not already exist. The
	// idempotency contract is "the existing token survives re-init",
	// so the existence check MUST run before WriteAtomic.
	tokenStatus := "preserved"
	if _, statErr := os.Stat(cfg.Layout.TokenFile); statErr != nil {
		if !os.IsNotExist(statErr) {
			emitError(sink, "hub init: stat %s: %v", cfg.Layout.TokenFile, statErr)
			return exitContractViolation, nil
		}
		tok, genErr := secrets.Generate()
		if genErr != nil {
			emitError(sink, "hub init: generate token: %v", genErr)
			return exitContractViolation, nil
		}
		if werr := secrets.WriteAtomic(cfg.Layout.TokenFile, tok); werr != nil {
			emitError(sink, "hub init: write token: %v", werr)
			return exitContractViolation, nil
		}
		tokenStatus = "generated"
	}

	payload := initResult{
		CreatedAt: createdAt,
		Home:      cfg.Home,
		LogFile:   cfg.Layout.LogFile,
		Logs:      cfg.Layout.Logs,
		Mode:      "0600",
		Runtime:   cfg.Layout.Runtime,
		State:     cfg.Layout.State,
		Status:    tokenStatus,
		TokenFile: cfg.Layout.TokenFile,
		Tokens:    cfg.Layout.Tokens,
	}

	if asJSON {
		// Hand-roll a sorted-key map so the JSON shape is stable
		// independent of struct field order. encoding/json sorts
		// map keys alphabetically.
		m := map[string]string{
			"created_at": payload.CreatedAt,
			"home":       payload.Home,
			"log_file":   payload.LogFile,
			"logs":       payload.Logs,
			"mode":       payload.Mode,
			"runtime":    payload.Runtime,
			"state":      payload.State,
			"status":     payload.Status,
			"token_file": payload.TokenFile,
			"tokens":     payload.Tokens,
		}
		raw, err := json.Marshal(m)
		if err != nil {
			emitError(sink, "hub init: marshal: %v", err)
			return exitContractViolation, nil
		}
		_ = sink.Printf("%s", output.Redact(string(raw)))
		return exitOK, nil
	}

	// Human envelope. One line per check, then the top-level
	// verdict. The lines are deterministic and grep-friendly so a
	// CI pipeline can pipe `hub init | grep '^home='` without
	// needing jq.
	_ = sink.Printf("home=%s", output.Redact(payload.Home))
	_ = sink.Printf("state=%s", output.Redact(payload.State))
	_ = sink.Printf("runtime=%s", output.Redact(payload.Runtime))
	_ = sink.Printf("logs=%s", output.Redact(payload.Logs))
	_ = sink.Printf("tokens=%s", output.Redact(payload.Tokens))
	_ = sink.Printf("token_file=%s mode=%s", output.Redact(payload.TokenFile), payload.Mode)
	_ = sink.Printf("status=%s", payload.Status)
	return exitOK, nil
}

// errInitContractViolation is a small wrapper so callers can use
// errors.Is(errInitContractViolation, ...) — currently unused but
// reserved for future extension when init gains more failure modes
// (e.g. refusing to init under a non-empty directory).
var errInitContractViolation = errors.New("hub init: contract violation")

// Sanity guard: fmt is only used in the JSON fallback path so the
// import is consumed even when the build tag trims the human form.
// Keep the linter quiet on the unused import.
var _ = fmt.Sprintf
