package paths_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hub/internal/paths"
)

// withEnv sets KEY=VALUE for the duration of the test and restores the
// previous state. We never call t.Setenv more than once per key
// inside a single test so the restore is unambiguous.
func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	prev := map[string]string{}
	for k := range kv {
		prev[k] = os.Getenv(k)
	}
	for k, v := range kv {
		t.Setenv(k, v)
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
}

// TestDefaultHomeOverrideHonoured — explicit HUB_HOME wins over XDG
// and HOME.
func TestDefaultHomeOverrideHonoured(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":      "/custom/hub/from-env",
		"XDG_DATA_HOME": "/should/be/ignored",
		"HOME":          "/should/be/ignored",
	})
	got, err := paths.DefaultHome(os.Getenv("HUB_HOME"))
	if err != nil {
		t.Fatalf("DefaultHome: %v", err)
	}
	want := "/custom/hub/from-env"
	if got != want {
		t.Fatalf("DefaultHome = %q, want %q", got, want)
	}
}

// TestDefaultHomeXDGDataHome — when HUB_HOME is empty, XDG_DATA_HOME
// wins.
func TestDefaultHomeXDGDataHome(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":      "",
		"XDG_DATA_HOME": "/xdg/root",
		"HOME":          "/home/user",
	})
	got, err := paths.DefaultHome("")
	if err != nil {
		t.Fatalf("DefaultHome: %v", err)
	}
	want := filepath.Join("/xdg/root", "hub")
	if got != want {
		t.Fatalf("DefaultHome = %q, want %q", got, want)
	}
}

// TestDefaultHomeXDGDefault — when neither HUB_HOME nor XDG_DATA_HOME
// is set, $HOME/.local/share/hub wins (the XDG spec's recommendation
// for macOS / Linux).
func TestDefaultHomeXDGDefault(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":      "",
		"XDG_DATA_HOME": "",
		"HOME":          "/home/user",
	})
	got, err := paths.DefaultHome("")
	if err != nil {
		t.Fatalf("DefaultHome: %v", err)
	}
	want := filepath.Join("/home/user", ".local", "share", "hub")
	if got != want {
		t.Fatalf("DefaultHome = %q, want %q", got, want)
	}
}

// TestDefaultHomeSandboxFallback — when no env vars are set, the
// package returns the relative `.hub` fallback (sandbox-only) rather
// than panicking or returning a host-specific path.
func TestDefaultHomeSandboxFallback(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":      "",
		"XDG_DATA_HOME": "",
		"HOME":          "",
	})
	got, err := paths.DefaultHome("")
	if err != nil {
		t.Fatalf("DefaultHome: %v", err)
	}
	if got == "" {
		t.Fatalf("DefaultHome returned empty string in sandbox")
	}
	if filepath.IsAbs(got) {
		t.Fatalf("DefaultHome returned an absolute path %q in sandbox", got)
	}
}

// TestDefaultHomeRejectsRelativeOverride — an explicit override must
// be absolute. The contract forbids hardcoded relative paths because
// they make `hub` non-portable.
func TestDefaultHomeRejectsRelativeOverride(t *testing.T) {
	_, err := paths.DefaultHome("./hub")
	if err == nil {
		t.Fatalf("DefaultHome accepted relative override")
	}
	if !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("error %q should mention absolute", err.Error())
	}
}

// TestDefaultHomeRejectsEmpty — an explicit empty override is treated
// as "no override" and falls through to XDG. This guards the
// zero-value pin in env parsers.
func TestDefaultHomeEmptyOverrideFallsThrough(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME":      "",
		"XDG_DATA_HOME": "/xdg/empty",
		"HOME":          "/home/empty",
	})
	got, err := paths.DefaultHome("   ")
	if err != nil {
		t.Fatalf("DefaultHome: %v", err)
	}
	want := filepath.Join("/xdg/empty", "hub")
	if got != want {
		t.Fatalf("DefaultHome whitespace override = %q, want %q", got, want)
	}
}

// TestLayoutForStableShape — LayoutFor must produce the four
// subdirectories, hub.log, and hub.token at exactly the documented
// paths. The audit relies on this stability.
func TestLayoutForStableShape(t *testing.T) {
	withEnv(t, map[string]string{"HUB_HOME": "/h"})
	l, err := paths.LayoutFor("/h")
	if err != nil {
		t.Fatalf("LayoutFor: %v", err)
	}
	cases := map[string]string{
		"Home":      l.Home,
		"State":     l.State,
		"Runtime":   l.Runtime,
		"Logs":      l.Logs,
		"Tokens":    l.Tokens,
		"LogFile":   l.LogFile,
		"TokenFile": l.TokenFile,
	}
	want := map[string]string{
		"Home":      "/h",
		"State":     "/h/state",
		"Runtime":   "/h/runtime",
		"Logs":      "/h/logs",
		"Tokens":    "/h/tokens",
		"LogFile":   "/h/logs/hub.log",
		"TokenFile": "/h/tokens/hub.token",
	}
	for k, v := range want {
		if cases[k] != v {
			t.Fatalf("LayoutFor %s = %q, want %q", k, cases[k], v)
		}
	}
}

// TestEnsureDirIdempotent — EnsureDir must succeed twice without
// error so the shell can safely create HUB_HOME on every invocation.
func TestEnsureDirIdempotent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "hub-home", "logs")
	if err := paths.EnsureDir(dir); err != nil {
		t.Fatalf("first EnsureDir: %v", err)
	}
	if err := paths.EnsureDir(dir); err != nil {
		t.Fatalf("second EnsureDir: %v", err)
	}
	st, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !st.IsDir() {
		t.Fatalf("EnsureDir produced a non-directory at %q", dir)
	}
}

// TestEnsureDirEmptyInput — EnsureDir must reject an empty path with
// a structured error rather than calling os.MkdirAll on the empty
// string (which is documented as "platform-dependent" in Go).
func TestEnsureDirEmptyInput(t *testing.T) {
	if err := paths.EnsureDir(""); err == nil {
		t.Fatalf("EnsureDir accepted empty path")
	}
}

// TestDefaultHomeNoUserPath — a regression guard: the package MUST
// NOT embed the user's $HOME into the returned path when HUB_HOME is
// set. Without this guard, an operator whose $HOME contains a
// sensitive token would leak it via the audit trail.
func TestDefaultHomeNoUserPath(t *testing.T) {
	withEnv(t, map[string]string{
		"HUB_HOME": "/srv/hub",
		"HOME":     "/home/sensitive-leak-target",
	})
	got, err := paths.DefaultHome("/srv/hub")
	if err != nil {
		t.Fatalf("DefaultHome: %v", err)
	}
	if strings.Contains(got, "sensitive-leak-target") {
		t.Fatalf("DefaultHome leaked the operator HOME: %q", got)
	}
}
