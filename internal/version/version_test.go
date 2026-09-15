package version_test

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"hub/internal/version"
)

// TestCurrentValuesKnownShape — every documented field is present and
// non-empty. The s11 gate relies on this contract.
func TestCurrentValuesKnownShape(t *testing.T) {
	v := version.Current()
	if v.Service != version.ServiceLabel {
		t.Fatalf("Service = %q, want %q", v.Service, version.ServiceLabel)
	}
	if v.Hub != version.Hub {
		t.Fatalf("Hub = %q, want %q", v.Hub, version.Hub)
	}
	if v.REST == "" || v.OpenAPI == "" || v.Go == "" {
		t.Fatalf("Current() returned an empty contract field: %+v", v)
	}
}

// TestCurrentValuesMarshalsToJSON — the JSON payload must round-trip
// through encoding/json and contain every documented key. The
// orchestrator parses this payload, so its shape is part of the
// contract.
func TestCurrentValuesMarshalsToJSON(t *testing.T) {
	v := version.Current()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := string(data)
	for _, want := range []string{`"service"`, `"hub"`, `"rest"`, `"openapi"`, `"go"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("JSON payload missing %s: %s", want, got)
		}
	}
}

// TestInfoStringDeterministic — two adjacent calls produce the same
// line. The format is the s11 gate's `hub version` shape.
func TestInfoStringDeterministic(t *testing.T) {
	info := version.CurrentInfo()
	first := info.String()
	second := version.CurrentInfo().String()
	if first != second {
		t.Fatalf("Info.String() not deterministic: %q vs %q", first, second)
	}
	// Format: "<service> <hub> (<go>)"
	pattern := regexp.MustCompile(`^hub 0\.[0-9]+\.[0-9]+ \(go1\.[0-9]+\.[0-9]+\)$`)
	if !pattern.MatchString(first) {
		t.Fatalf("Info.String() = %q does not match expected pattern", first)
	}
}

// TestConstantsArePinned — Hub and ServiceLabel are the contract. A
// drift here means the contract drifted.
func TestConstantsArePinned(t *testing.T) {
	if version.Hub != "0.1.0" {
		t.Fatalf("Hub = %q, want %q (T0.5 contract pin)", version.Hub, "0.1.0")
	}
	if version.ServiceLabel != "hub" {
		t.Fatalf("ServiceLabel = %q, want %q (canonical product name)", version.ServiceLabel, "hub")
	}
	if version.REST != "unknown" {
		t.Fatalf("REST = %q, want %q (deferred to T1)", version.REST, "unknown")
	}
	if version.OpenAPI != "unknown" {
		t.Fatalf("OpenAPI = %q, want %q (deferred to T6)", version.OpenAPI, "unknown")
	}
}

// TestGoVersionReported — GoVersion must be non-empty and start with
// "go" (runtime.Version contract).
func TestGoVersionReported(t *testing.T) {
	if !strings.HasPrefix(version.GoVersion, "go") {
		t.Fatalf("GoVersion = %q, want prefix 'go'", version.GoVersion)
	}
}
