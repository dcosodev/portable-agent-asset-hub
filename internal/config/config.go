// Package config is the single env-loading boundary for the hub shell.
// Per docs/architecture/go-product-shell.md the shell reads (and
// MUST NOT write) the following three path-shaped env vars at T0.5:
//
//	HUB_HOME      — override HUB_HOME (XDG-style fallback applies)
//	HUB_RUNTIME   — override the Compose project root (deferred)
//	HUB_OPENAPI   — override the path to openapi/openapi.yaml
//
// Each variable is independently optional; each is validated to be
// either empty or an absolute path. There is no implicit inheritance
// from $HOME — the shell never reads an operator's home directory
// without their explicit env-var permission.
//
// The Config struct is the only object main.go reads to wire the
// shell's environment contract. All three fields are populated by the
// single Load() entry point so the audit trail shows one call site.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"hub/internal/paths"
)

// EnvKey* are the canonical env-var names. Exported so the s11 gate
// can assert on the contract surface from outside the package.
const (
	EnvKeyHome    = "HUB_HOME"
	EnvKeyRuntime = "HUB_RUNTIME"
	EnvKeyOpenAPI = "HUB_OPENAPI"
)

// Config is the validated environment contract. Strings are absolute
// paths or "" (the unset case). Path-shaped values are normalised via
// filepath.Clean.
type Config struct {
	// Home is the resolved HUB_HOME. Always populated; default is the
	// XDG-style fallback computed by paths.DefaultHome.
	Home string
	// Layout is the four subdirectories derived from Home. Always
	// populated; mirrors paths.LayoutFor.
	Layout paths.Layout
	// Runtime is $HUB_RUNTIME. Empty when the operator did not override.
	// Absolute paths only — any other form triggers a validation error.
	Runtime string
	// OpenAPI is the resolved openapi.yaml path. Default is
	// <repo>/openapi/openapi.yaml when env is unset; "" when default
	// could not be derived (e.g. shell invoked outside a repo tree).
	OpenAPI string
	// Source records, per-field, where the value came from. The audit
	// requires this so a later run can prove which env var produced
	// each path. Values are "env:<NAME>", "default", or "xdg".
	Source SourceMap
}

// SourceMap is the audit-side ledger of where each Config field came
// from. Keys are the field names (e.g. "home", "runtime", "openapi")
// and values are the source labels.
type SourceMap struct {
	Home    string
	Runtime string
	OpenAPI string
}

// Load reads the three env vars, applies defaults, validates, and
// returns the canonical Config. The function is the single entry
// point main.go calls so a future addition (HUB_BEARER_TOKEN, …) lands
// here without changing the call sites.
//
// repoRoot is the absolute path to the repository root — used to
// derive the default openapi.yaml location. Pass the repo root from
// main so the package never re-discovers the working directory.
func Load(repoRoot string) (Config, error) {
	cfg := Config{Source: SourceMap{Home: "default", Runtime: "default", OpenAPI: "default"}}

	// --- HUB_HOME ---------------------------------------------------------
	envHome := strings.TrimSpace(os.Getenv(EnvKeyHome))
	if envHome != "" {
		// Reject parent-traversal segments from the ORIGINAL input
		// (e.g. "/tmp/../x"). The downstream paths.DefaultHome also
		// rejects ".." but only on the CLEANED path, which silently
		// collapses "/tmp/../x" to "/x" before the check fires. This
		// pre-check runs on the raw operator-supplied string so the
		// security boundary holds regardless of how filepath.Clean
		// normalises the path.
		if err := rejectParentTraversal(envHome, EnvKeyHome); err != nil {
			return Config{}, err
		}
		cfg.Source.Home = "env:" + EnvKeyHome
	}
	home, err := paths.DefaultHome(envHome)
	if err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	layout, err := paths.LayoutFor(envHome)
	if err != nil {
		return Config{}, fmt.Errorf("config: layout: %w", err)
	}
	if home != layout.Home {
		// Defensive: both functions share the same DefaultHome
		// derivation, so this branch is impossible under normal
		// operation. If it ever fires, the audit reveals the drift.
		return Config{}, errors.New("config: LayoutFor home differs from DefaultHome")
	}
	cfg.Home = home
	cfg.Layout = layout

	// --- HUB_RUNTIME ------------------------------------------------------
	envRuntime := strings.TrimSpace(os.Getenv(EnvKeyRuntime))
	if envRuntime == "" {
		cfg.Runtime = ""
	} else {
		cleaned, err := cleanAbsolute(envRuntime, EnvKeyRuntime)
		if err != nil {
			return Config{}, err
		}
		cfg.Runtime = cleaned
		cfg.Source.Runtime = "env:" + EnvKeyRuntime
	}

	// --- HUB_OPENAPI ------------------------------------------------------
	envOpenAPI := strings.TrimSpace(os.Getenv(EnvKeyOpenAPI))
	if envOpenAPI == "" {
		if repoRoot != "" {
			cleaned, err := cleanAbsolute(filepath.Join(repoRoot, "openapi", "openapi.yaml"), EnvKeyOpenAPI)
			if err != nil {
				return Config{}, err
			}
			cfg.OpenAPI = cleaned
		}
	} else {
		cleaned, err := cleanAbsolute(envOpenAPI, EnvKeyOpenAPI)
		if err != nil {
			return Config{}, err
		}
		cfg.OpenAPI = cleaned
		cfg.Source.OpenAPI = "env:" + EnvKeyOpenAPI
	}

	return cfg, nil
}

// cleanAbsolute validates that the supplied path is non-empty and
// absolute, then returns its cleaned form. envName is included in
// the error message so the operator sees which variable is bad.
//
// Parent-traversal segments ("..") are rejected from the ORIGINAL
// input, not from filepath.Clean's result. Cleaning "/tmp/../x"
// yields "/x", so a post-clean check would silently accept the
// hostile value; checking the raw segments catches "/tmp/../x",
// "/srv/hub/../etc", "/tmp/..", and any other escape attempt. The
// downstream paths.cleanAbs still runs its own post-clean check
// (defence in depth), but the security boundary now holds even when
// Clean normalises the segment away.
func cleanAbsolute(p, envName string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("config: %s is empty", envName)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("config: %s must be an absolute path, got %q", envName, p)
	}
	if err := rejectParentTraversal(p, envName); err != nil {
		return "", err
	}
	cleaned := filepath.Clean(p)
	// Defensive: even though rejectParentTraversal scanned the raw
	// input, a custom split rule could miss an edge case. The post-
	// clean check is kept for parity with the downstream paths
	// package and so the test surface (which inspects the error
	// wording) keeps the same message for the unusual case where a
	// ".." somehow survives the cleaner.
	if strings.Contains(cleaned, "..") {
		return "", fmt.Errorf("config: %s may not contain '..', got %q", envName, p)
	}
	return cleaned, nil
}

// rejectParentTraversal returns an error when `p` (the operator-
// supplied value, before filepath.Clean) contains a path segment
// equal to "..". A segment is delimited by the OS path separator
// OR a literal '/'. This split is intentionally wider than
// filepath.Split so both POSIX ("/tmp/../x") and the worst-case
// mixed-separator inputs are rejected with a stable error.
//
// The check is segment-equality, not substring, so legitimate paths
// containing "..." (e.g. "/foo/.../bar") are NOT rejected — only an
// exact ".." segment trips the rule. This keeps the contract
// narrowly targeted at the escape-attack pattern and avoids false
// positives on otherwise-valid operator paths.
func rejectParentTraversal(p, envName string) error {
	for _, seg := range splitPathSegments(p) {
		if seg == ".." {
			return fmt.Errorf("config: %s may not contain '..' segments, got %q", envName, p)
		}
	}
	return nil
}

// splitPathSegments returns the non-empty path elements of `p`,
// splitting on both '/' and the OS path separator. Empty elements
// (from leading '/' or runs of separators) are skipped so the
// caller only sees real path components.
func splitPathSegments(p string) []string {
	if p == "" {
		return nil
	}
	// Treat both '/' and filepath.Separator as boundaries. On POSIX
	// systems they coincide; on Windows the explicit '/' catches
	// hand-typed POSIX-style paths.
	seps := "/"
	if string(filepath.Separator) != "/" {
		seps += string(filepath.Separator)
	}
	raw := strings.FieldsFunc(p, func(r rune) bool {
		return strings.ContainsRune(seps, r)
	})
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
