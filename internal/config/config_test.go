package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hub/internal/config"
)

// withEnv sets and restores env vars across the test. Keys with empty
// values are unset rather than set to ""; that matches the operator's
// intuition (an unset variable and an empty string are equivalent for
// the loaders).
func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	prev := map[string]string{}
	for k := range kv {
		prev[k] = os.Getenv(k)
	}
	t.Cleanup(func() {
		for k, v := range prev {
			if v == "" {
				_ = os.Unsetenv(k)
			} else {
				_ = os.Setenv(k, v)
			}
		}
	})
	for k, v := range kv {
		if v == "" {
			_ = os.Unsetenv(k)
		} else {
			t.Setenv(k, v)
		}
	}
}

// TestLoadDefaults — without env overrides, Load returns the
// XDG-derived HUB_HOME and the repo-root-derived openapi.yaml.
func TestLoadDefaults(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":      "",
		"HUB_RUNTIME":   "",
		"HUB_OPENAPI":   "",
		"XDG_DATA_HOME": "/xdg",
		"HOME":          "/home/defaults",
	})
	cfg, err := config.Load("/repo")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := cfg.Home; got != filepath.Join("/xdg", "hub") {
		t.Fatalf("Home = %q, want %q", got, filepath.Join("/xdg", "hub"))
	}
	if got := cfg.OpenAPI; got != filepath.Join("/repo", "openapi", "openapi.yaml") {
		t.Fatalf("OpenAPI = %q, want %q", got, filepath.Join("/repo", "openapi", "openapi.yaml"))
	}
	if got := cfg.Runtime; got != "" {
		t.Fatalf("Runtime = %q, want empty", got)
	}
	if cfg.Source.Home != "default" {
		t.Fatalf("Source.Home = %q, want %q", cfg.Source.Home, "default")
	}
	if cfg.Source.OpenAPI != "default" {
		t.Fatalf("Source.OpenAPI = %q, want %q", cfg.Source.OpenAPI, "default")
	}
}

// TestLoadEnvOverrides — explicit env vars take precedence over the
// defaults and the Source map records the provenance.
func TestLoadEnvOverrides(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":    "/srv/hub",
		"HUB_RUNTIME": "/srv/runtime",
		"HUB_OPENAPI": "/etc/openapi.yaml",
	})
	cfg, err := config.Load("/repo")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Home != "/srv/hub" {
		t.Fatalf("Home = %q, want %q", cfg.Home, "/srv/hub")
	}
	if cfg.Runtime != "/srv/runtime" {
		t.Fatalf("Runtime = %q, want %q", cfg.Runtime, "/srv/runtime")
	}
	if cfg.OpenAPI != "/etc/openapi.yaml" {
		t.Fatalf("OpenAPI = %q, want %q", cfg.OpenAPI, "/etc/openapi.yaml")
	}
	if cfg.Source.Home != "env:HUB_HOME" {
		t.Fatalf("Source.Home = %q, want %q", cfg.Source.Home, "env:HUB_HOME")
	}
	if cfg.Source.Runtime != "env:HUB_RUNTIME" {
		t.Fatalf("Source.Runtime = %q, want %q", cfg.Source.Runtime, "env:HUB_RUNTIME")
	}
	if cfg.Source.OpenAPI != "env:HUB_OPENAPI" {
		t.Fatalf("Source.OpenAPI = %q, want %q", cfg.Source.OpenAPI, "env:HUB_OPENAPI")
	}
}

// TestLoadRejectsRelativeHome — HUB_HOME must be absolute; relative
// paths leak the operator's cwd into the contract.
func TestLoadRejectsRelativeHome(t *testing.T) {
	withEnv(t, map[string]string{"HUB_HOME": "relative/hub"})
	if _, err := config.Load("/repo"); err == nil {
		t.Fatalf("Load accepted relative HUB_HOME")
	}
}

// TestLoadRejectsRelativeRuntime — HUB_RUNTIME must be absolute when
// set. Empty is allowed (deferred).
func TestLoadRejectsRelativeRuntime(t *testing.T) {
	withEnv(t, map[string]string{"HUB_RUNTIME": "./runtime"})
	_, err := config.Load("/repo")
	if err == nil {
		t.Fatalf("Load accepted relative HUB_RUNTIME")
	}
	if !strings.Contains(err.Error(), "HUB_RUNTIME") {
		t.Fatalf("error %q must mention HUB_RUNTIME", err.Error())
	}
}

// TestLoadRejectsRelativeOpenAPI — HUB_OPENAPI must be absolute when
// the operator overrides it. Empty defers to the repo-root default.
func TestLoadRejectsRelativeOpenAPI(t *testing.T) {
	withEnv(t, map[string]string{"HUB_OPENAPI": "openapi/openapi.yaml"})
	_, err := config.Load("/repo")
	if err == nil {
		t.Fatalf("Load accepted relative HUB_OPENAPI")
	}
}

// TestLoadRejectsDotDot — `..` segments are rejected so a hostile
// env var can't escape HUB_HOME.
func TestLoadRejectsDotDot(t *testing.T) {
	withEnv(t, map[string]string{"HUB_HOME": "/srv/hub/../etc"})
	_, err := config.Load("/repo")
	if err == nil {
		t.Fatalf("Load accepted HUB_HOME with ..")
	}
}

// TestLoadRejectsDotDotEarlySegment — the security boundary must
// hold even when filepath.Clean normalises the `..` away. A path
// like "/tmp/../x" cleans to "/x", so a post-clean `..` check would
// silently accept the hostile value. The contract requires the
// raw input to be inspected, not the cleaned form.
func TestLoadRejectsDotDotEarlySegment(t *testing.T) {
	withEnv(t, map[string]string{"HUB_HOME": "/tmp/../x"})
	_, err := config.Load("/repo")
	if err == nil {
		t.Fatalf("Load accepted HUB_HOME=/tmp/../x (clean collapses to /x)")
	}
	if !strings.Contains(err.Error(), "HUB_HOME") {
		t.Fatalf("error %q must mention HUB_HOME", err.Error())
	}
}

// TestLoadRejectsDotDotRuntime — same attack pattern via HUB_RUNTIME.
// cleanAbsolute must also reject pre-clean `..` segments.
func TestLoadRejectsDotDotRuntime(t *testing.T) {
	withEnv(t, map[string]string{"HUB_RUNTIME": "/tmp/../runtime"})
	_, err := config.Load("/repo")
	if err == nil {
		t.Fatalf("Load accepted HUB_RUNTIME=/tmp/../runtime")
	}
	if !strings.Contains(err.Error(), "HUB_RUNTIME") {
		t.Fatalf("error %q must mention HUB_RUNTIME", err.Error())
	}
}

// TestLoadRejectsDotDotOpenAPI — same attack pattern via HUB_OPENAPI.
func TestLoadRejectsDotDotOpenAPI(t *testing.T) {
	withEnv(t, map[string]string{"HUB_OPENAPI": "/tmp/../openapi.yaml"})
	_, err := config.Load("/repo")
	if err == nil {
		t.Fatalf("Load accepted HUB_OPENAPI=/tmp/../openapi.yaml")
	}
}

// TestLoadLayoutMirrorsHome — Layout.Home is always identical to
// Config.Home. The audit checks both fields.
func TestLoadLayoutMirrorsHome(t *testing.T) {
	withEnv(t, map[string]string{"HUB_HOME": "/srv/hub"})
	cfg, err := config.Load("/repo")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Layout.Home != cfg.Home {
		t.Fatalf("Layout.Home = %q != cfg.Home %q", cfg.Layout.Home, cfg.Home)
	}
	if cfg.Layout.State != filepath.Join("/srv/hub", "state") {
		t.Fatalf("Layout.State = %q", cfg.Layout.State)
	}
	if cfg.Layout.LogFile != filepath.Join("/srv/hub", "logs", "hub.log") {
		t.Fatalf("Layout.LogFile = %q", cfg.Layout.LogFile)
	}
	if cfg.Layout.TokenFile != filepath.Join("/srv/hub", "tokens", "hub.token") {
		t.Fatalf("Layout.TokenFile = %q", cfg.Layout.TokenFile)
	}
}

// TestLoadEmptyRepoRoot — when repoRoot is empty and HUB_OPENAPI is
// empty, OpenAPI is "" (NOT "<empty>/openapi/openapi.yaml"). The shell
// reports `unknown` for the version triple but keeps the config clean.
func TestLoadEmptyRepoRoot(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":    "/srv/hub",
		"HUB_RUNTIME": "",
		"HUB_OPENAPI": "",
	})
	cfg, err := config.Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.OpenAPI != "" {
		t.Fatalf("OpenAPI = %q, want empty when repoRoot is empty and HUB_OPENAPI is unset", cfg.OpenAPI)
	}
}
