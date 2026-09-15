// Package paths is the single source of truth for filesystem locations
// the hub shell reads or writes. Per docs/architecture/go-product-shell.md
// the canonical layout under HUB_HOME is:
//
//	state/    — TypeScript hub-rest runtime state (deferred; T1..T9)
//	runtime/  — Compose project root (docker-stack orchestration; deferred)
//	logs/     — hub.log (0600)
//	tokens/   — hub.token (0600; bearer)
//
// On macOS the package follows XDG-style fallbacks so HUB_HOME has a
// stable, non-hardcoded default:
//
//	$XDG_DATA_HOME/hub          when XDG_DATA_HOME is set
//	$HOME/.local/share/hub      when neither is set (XDG spec default on macOS)
//
// HUB_HOME may also be overridden directly via the HUB_HOME env var.
//
// The package NEVER embeds a username, the user's $HOME, or any other
// host-specific path in its return values. The only username-bearing
// string the shell ever emits is whatever the operator typed into
// $HOME — and even that is filtered through filepath.Clean so trailing
// slashes and `..` segments are normalised before any further use.
//
// The package is intentionally tiny and pure (no I/O, no syscalls
// outside os.Getenv). main.go is the only place that creates
// directories; this package only DESCRIBES paths.
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Subdirectory is the logical layout under HUB_HOME. main.go maps
// each role to a fixed relative path so the contract stays stable.
type Subdirectory string

const (
	// SubState is the TypeScript hub-rest state root. T1..T9 wire the
	// real REST process here; today the directory is reserved.
	SubState Subdirectory = "state"
	// SubRuntime is the Compose project root. Deferred to T2 (or
	// whichever slice lands Docker); today the directory is reserved.
	SubRuntime Subdirectory = "runtime"
	// SubLogs is the hub.log directory. The shell writes here in
	// later slices.
	SubLogs Subdirectory = "logs"
	// SubTokens is the bearer token directory. hub.token lives here
	// with mode 0600 (deferred — T1 at the earliest).
	SubTokens Subdirectory = "tokens"
)

// Layout is the computed filesystem layout for the current process.
// Fields are absolute paths derived from HUB_HOME and the XDG-style
// fallback chain.
type Layout struct {
	Home      string
	State     string
	Runtime   string
	Logs      string
	Tokens    string
	LogFile   string
	TokenFile string
}

// DefaultHome derives the canonical HUB_HOME value. Order of
// precedence (highest first):
//
//  1. The passed `override` (HUB_HOME env var when called from main).
//  2. $XDG_DATA_HOME/hub.
//  3. $HOME/.local/share/hub.
//
// Falls back to a non-username-bearing placeholder when neither
// $HOME nor $XDG_DATA_HOME is set. The placeholder is the literal
// ".hub" (relative to the current working directory) and is reserved
// for sandboxed test runs; real shells always have $HOME set.
func DefaultHome(override string) (string, error) {
	override = strings.TrimSpace(override)
	if override != "" {
		clean, err := cleanAbs(override)
		if err != nil {
			return "", fmt.Errorf("paths: invalid HUB_HOME %q: %w", override, err)
		}
		return clean, nil
	}
	if v := os.Getenv("XDG_DATA_HOME"); strings.TrimSpace(v) != "" {
		clean, err := cleanAbs(filepath.Join(v, "hub"))
		if err != nil {
			return "", fmt.Errorf("paths: invalid XDG_DATA_HOME %q: %w", v, err)
		}
		return clean, nil
	}
	if v := os.Getenv("HOME"); strings.TrimSpace(v) != "" {
		clean, err := cleanAbs(filepath.Join(v, ".local", "share", "hub"))
		if err != nil {
			return "", fmt.Errorf("paths: invalid HOME %q: %w", v, err)
		}
		return clean, nil
	}
	// No HOME, no XDG_DATA_HOME — sandbox. Use a relative fallback
	// so the contract surface still resolves cleanly. cleanAbs would
	// reject this (it enforces absolute paths for env-supplied values),
	// so we hand back the documented literal directly.
	return ".hub", nil
}

// LayoutFor computes the full Layout for the supplied HUB_HOME
// override (empty string means "use the XDG fallback"). Callers pass
// the validated HUB_HOME string here so the package never silently
// re-parses an invalid path.
func LayoutFor(homeOverride string) (Layout, error) {
	home, err := DefaultHome(homeOverride)
	if err != nil {
		return Layout{}, err
	}
	l := Layout{Home: home}
	l.State = filepath.Join(home, string(SubState))
	l.Runtime = filepath.Join(home, string(SubRuntime))
	l.Logs = filepath.Join(home, string(SubLogs))
	l.Tokens = filepath.Join(home, string(SubTokens))
	l.LogFile = filepath.Join(l.Logs, "hub.log")
	l.TokenFile = filepath.Join(l.Tokens, "hub.token")
	return l, nil
}

// cleanAbs returns the cleaned absolute form of `p`. A relative input
// is rejected because the contract explicitly forbids hardcoded user
// paths — only an env-supplied absolute path is honoured.
func cleanAbs(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", errors.New("paths: empty path")
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("paths: path %q is not absolute", p)
	}
	cleaned := filepath.Clean(p)
	if cleaned == "" || cleaned == "/" {
		return "", fmt.Errorf("paths: path %q collapses to %q", p, cleaned)
	}
	if strings.Contains(cleaned, "..") {
		return "", fmt.Errorf("paths: path %q may not contain '..'", p)
	}
	return cleaned, nil
}

// EnsureDir creates the directory at `path` with mode 0750 if it does
// not exist. The function is exported because the s11 gate's hermetic
// fixture scaffolding uses it to create a fake HUB_HOME under
// $TMPDIR; the production shell calls it from main.go when initialising
// a fresh home. Idempotent.
func EnsureDir(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("paths: empty ensure path")
	}
	return os.MkdirAll(path, 0o750)
}
