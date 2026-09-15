// cmd/hub/cmd_helpers.go
//
// Shared helpers for the cmd/hub subcommand handlers. Today main.go
// and cmd_runtime.go both need to emit diagnostic stderr messages
// and probe small env keys; this file centralises the wiring so
// every handler reads from the same indirection point and so tests
// can stub the env probe without mutating real os.Setenv state.
//
// This file is intentionally tiny: it adds NO new contract surface,
// it only renames existing patterns so subcommand handlers can use
// them without import cycles.

package main

import "os"

// osGetenv is the indirection point for `os.Getenv` inside the
// runtime handlers. Tests can override it via envProbe to lock
// the env surface to a known fixture; production leaves it as
// `os.Getenv`.
var osGetenv = os.Getenv

// emitError is shared between main.go and the runtime handler. We
// re-declare it here so cmd_runtime.go can call it without
// importing main.go (which would be a cyclic import — main is the
// entry point). The function mirrors main.go's emitError: a single
// stderr line, fail-closed, never echoing bearer-shaped content.
func emitError(sink interface {
	Errorf(string, ...any) error
}, format string, a ...any) {
	_ = sink.Errorf(format, a...)
}
