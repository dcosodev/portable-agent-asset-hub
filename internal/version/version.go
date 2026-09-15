// Package version is the single source of truth for the hub shell's
// version triple. Per docs/phase0/naming.md the shell's canonical
// product name is `hub`; per docs/architecture/go-product-shell.md
// the version subcommand prints three values:
//
//	hub     — Go shell build version
//	rest    — TypeScript REST runtime version (deferred; "unknown" until wired in T1..T9)
//	openapi — openapi/openapi.yaml info.version (deferred; "unknown" until wired in T1..T9)
//
// At T0.5 only the Go shell version is meaningful. The other two are
// reported as the literal string "unknown" so the JSON payload stays
// stable across shells and so downstream contracts do not have to
// branch on "missing field" vs "unknown version".
//
// The Values type is exported as the JSON payload surface used by
// `hub version --json` and inspected by the s11 gate. The Info struct
// is the human-readable shape used by `hub version`.
package version

import (
	"encoding/json"
	"fmt"
	"runtime"
)

// Hub is the canonical Go shell version. Bump on every release that
// ships a contract-visible change; the gate (s11) compares this string
// byte-for-byte against the build output, so do not include a Go
// commit hash that changes per build — the shell version IS a contract
// surface, not a build identifier. The build identifier is GoVersion
// (runtime) and ServiceLabel (constant).
const Hub = "0.1.0"

// ServiceLabel is the canonical product-shell name (see
// docs/phase0/naming.md). It is constant across all hub builds.
const ServiceLabel = "hub"

// REST is the TypeScript REST runtime version. Wired in T1 (hub
// version should reflect the running hub-rest). Until then we emit
// "unknown" so the JSON payload stays well-formed.
const REST = "unknown"

// OpenAPI is the OpenAPI specification version. Wired in T6 (curated
// REST client). Until then we emit "unknown" so the JSON payload
// stays well-formed.
const OpenAPI = "unknown"

// GoVersion is the Go toolchain build that produced this binary.
// Captured at runtime from the standard library and embedded in the
// --json payload so the audit trail can correlate a binary with the
// toolchain that built it.
var GoVersion = runtime.Version()

// Info is the human-readable version surface used by `hub version`
// (no --json).
type Info struct {
	Service string `json:"service"`
	Hub     string `json:"hub"`
	Go      string `json:"go"`
}

// Values is the structured --json surface used by `hub version --json`
// and forwarded to scripts that wire the version handshake (see
// docs/phase0/handshake.md). Field names are stable; downstream
// orchestrators parse this object, never the prose payload.
//
// We hand-roll the JSON encoding rather than relying on the
// struct's reflection-based output. The shell's contract is locked
// to an ALPHABETICAL key order (go, hub, openapi, rest, service)
// so orchestrators that extract substring slices (rare but legal)
// see a deterministic shape — independent of any future field
// re-ordering inside the struct. The s11 gate asserts presence of
// the five canonical keys; the shell tests assert the textual
// order matches the sorted order.
type Values struct {
	Service string `json:"service"`
	Hub     string `json:"hub"`
	REST    string `json:"rest"`
	OpenAPI string `json:"openapi"`
	Go      string `json:"go"`
}

// MarshalJSON renders Values with the locked alphabetical key
// order (go, hub, openapi, rest, service). Every call produces the
// same byte sequence for the same logical value, regardless of
// struct field declaration order.
func (v Values) MarshalJSON() ([]byte, error) {
	// Use a map so encoding/json's documented alphabetical key
	// ordering is the contract surface; the struct tags on the
	// Values type are kept for downstream packages that introspect
	// the shape (e.g. docs) but the marshaled output is sorted
	// regardless.
	payload := map[string]string{
		"service": v.Service,
		"hub":     v.Hub,
		"rest":    v.REST,
		"openapi": v.OpenAPI,
		"go":      v.Go,
	}
	return json.Marshal(payload)
}

// Current returns the canonical version triple. The function is the
// only entry point the rest of the shell uses so any future
// derivation (env-driven overrides, sidecar lookup, ...) happens in
// exactly one place.
func Current() Values {
	return Values{
		Service: ServiceLabel,
		Hub:     Hub,
		REST:    REST,
		OpenAPI: OpenAPI,
		Go:      GoVersion,
	}
}

// CurrentInfo returns the human-readable summary used by `hub version`.
func CurrentInfo() Info {
	return Info{
		Service: ServiceLabel,
		Hub:     Hub,
		Go:      GoVersion,
	}
}

// String renders the human-readable Info as a fixed-width, sorted line
// so the output is byte-deterministic across hosts and Go toolchains.
// Format is:
//
//	hub 0.1.0 (go1.24.3)
//
// The s11 gate asserts this exact format.
func (i Info) String() string {
	// runtime.Version() returns e.g. "go1.27.0" — the "go" prefix is
	// already present, so the format is "<service> <hub> (<go>)"
	// without an extra "go " inside the parens.
	return fmt.Sprintf("%s %s (%s)", i.Service, i.Hub, i.Go)
}
