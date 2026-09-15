package output_test

import (
	"bytes"
	"strings"
	"testing"

	"hub/internal/output"
)

// TestLooksLikeBearer exercises each bearer pattern the redactor and
// the s11 gate recognise. A negative assertion is included so future
// drift (a regex that starts catching ordinary English) is caught.
func TestLooksLikeBearer(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  bool
	}{
		{"empty", "", false},
		{"plain prose", "hub version 0.1.0 (go1.24.3)", false},
		{"bearer-prefix (20+)", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", true},
		{"bearer-prefix lower", "bearer abcdefghijklmnopqrstuvwxyz123456", true},
		{"HUB_BEARER_TOKEN=", "HUB_BEARER_TOKEN=abcdefghijklmnopqrstuvwxyz123456", true},
		{"hub_bearer_token=", "hub_bearer_token=abcdefghijklmnopqrstuvwxyz123456", true},
		{"authorization colon", "authorization: abcdefghijklmnopqrstuvwxyz123456", true},
		{"jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxNzAwMDAwMDAwfQ.signaturepartgoeshere", true},
		{"short random word", "abcdefghij", false},
		{"two short segments", "abc.def", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := output.LooksLikeBearer(tc.input); got != tc.want {
				t.Fatalf("LooksLikeBearer(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

// TestRedact replaces each recognised pattern with the canonical
// marker. The empty-input case is a regression guard.
func TestRedact(t *testing.T) {
	for _, tc := range []struct {
		name     string
		input    string
		mustHave []string
		mustMiss []string
	}{
		{
			"empty",
			"",
			nil,
			nil,
		},
		{
			"prose unchanged",
			"hub version 0.1.0",
			[]string{"hub version 0.1.0"},
			nil,
		},
		{
			"bearer header redacted",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
			[]string{"Bearer <<REDACTED>>"},
			[]string{"abcdefghijklmnopqrstuvwxyz123456"},
		},
		{
			"HUB_BEARER_TOKEN assignment redacted",
			"export HUB_BEARER_TOKEN=abcdefghijklmnopqrstuvwxyz123456",
			[]string{"HUB_BEARER_TOKEN=<<REDACTED>>"},
			[]string{"abcdefghijklmnopqrstuvwxyz123456"},
		},
		{
			"authorization colon redacted",
			"authorization: abcdefghijklmnopqrstuvwxyz123456",
			[]string{"Authorization: <<REDACTED>>"},
			[]string{"abcdefghijklmnopqrstuvwxyz123456"},
		},
		{
			"jwt triple-segment redacted",
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxNzAwMDAwMDAwfQ.signaturepartgoeshere",
			[]string{"<<REDACTED>>.<<REDACTED>>.<<REDACTED>>"},
			nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := output.Redact(tc.input)
			for _, want := range tc.mustHave {
				if !strings.Contains(got, want) {
					t.Fatalf("Redact(%q) = %q, missing %q", tc.input, got, want)
				}
			}
			for _, miss := range tc.mustMiss {
				if strings.Contains(got, miss) {
					t.Fatalf("Redact(%q) = %q, must NOT contain %q", tc.input, got, miss)
				}
			}
		})
	}
}

// TestSinkPrintfWritesToStdout is the byte-exact round-trip guard:
// Printf must land its payload on Out and Errorf must land its payload
// on Err. The contract guarantees a trailing '\n' on every line
// (see internal/output/output.go), so this test asserts the
// newline-terminated shape AND keeps stdout/stderr separated. The
// test runs against an in-memory sink so it cannot pollute the host's
// stdout.
func TestSinkPrintfWritesToStdout(t *testing.T) {
	var stdout, stderr bytes.Buffer
	sink := output.NewForTest(
		func(b []byte) (int, error) { return stdout.Write(b) },
		func(b []byte) (int, error) { return stderr.Write(b) },
		true, // CI mode
	)
	if err := sink.Printf("hello %s", "world"); err != nil {
		t.Fatalf("Printf returned error: %v", err)
	}
	if err := sink.Errorf("oops %d", 42); err != nil {
		t.Fatalf("Errorf returned error: %v", err)
	}
	if got := stdout.String(); got != "hello world\n" {
		t.Fatalf("stdout = %q, want %q", got, "hello world\n")
	}
	if got := stderr.String(); got != "oops 42\n" {
		t.Fatalf("stderr = %q, want %q", got, "oops 42\n")
	}
	// The two streams must remain disjoint: a Printf call never lands
	// on stderr, and an Errorf call never lands on stdout. This is the
	// operator-visible half of the bearer-redaction contract.
	if got := stderr.String(); strings.Contains(got, "hello world") {
		t.Fatalf("stderr unexpectedly contains stdout payload: %q", got)
	}
	if got := stdout.String(); strings.Contains(got, "oops 42") {
		t.Fatalf("stdout unexpectedly contains stderr payload: %q", got)
	}
}

// TestSinkAppendsTrailingNewline pins the newline contract that the
// s11 gate relies on. Every Printf/Errorf call MUST terminate the
// rendered line with a single '\n'. Three rules are encoded:
//
//  1. A non-empty payload without a trailing newline gets exactly one
//     '\n' appended (the typical call shape, e.g. `Printf("%s", line)`).
//  2. A payload that already ends with '\n' is passed through verbatim
//     so we never produce "\n\n" when a caller pre-terminates.
//  3. An empty payload still emits exactly one '\n' so a help-text
//     separator line renders as a real blank line, not a vanished row.
//
// The four cases are table-driven so a future regression (e.g. a
// re-introduction of the pre-trimpath double-newline) fails closed.
func TestSinkAppendsTrailingNewline(t *testing.T) {
	for _, tc := range []struct {
		name    string
		call    func(s *output.Sink) error
		wantOut string
		wantErr string
	}{
		{
			name:    "PrintfAppendsSingleNewline",
			call:    func(s *output.Sink) error { return s.Printf("home=%s", "/abs/path") },
			wantOut: "home=/abs/path\n",
		},
		{
			name:    "ErrorfAppendsSingleNewline",
			call:    func(s *output.Sink) error { return s.Errorf("oops: %d", 7) },
			wantErr: "oops: 7\n",
		},
		{
			name:    "PrintfPreservesExistingTrailingNewline",
			call:    func(s *output.Sink) error { return s.Printf("hub 0.1.0 (go1.27.0)\n") },
			wantOut: "hub 0.1.0 (go1.27.0)\n",
		},
		{
			name:    "PrintfEmptyRendersAsBlankLine",
			call:    func(s *output.Sink) error { return s.Printf("%s", "") },
			wantOut: "\n",
		},
		{
			name:    "ErrorfEmptyRendersAsBlankLine",
			call:    func(s *output.Sink) error { return s.Errorf("%s", "") },
			wantErr: "\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			sink := output.NewForTest(
				func(b []byte) (int, error) { return stdout.Write(b) },
				func(b []byte) (int, error) { return stderr.Write(b) },
				true,
			)
			if err := tc.call(sink); err != nil {
				t.Fatalf("call returned error: %v", err)
			}
			if got := stdout.String(); got != tc.wantOut {
				t.Fatalf("stdout = %q, want %q", got, tc.wantOut)
			}
			if got := stderr.String(); got != tc.wantErr {
				t.Fatalf("stderr = %q, want %q", got, tc.wantErr)
			}
		})
	}
}

// TestIsCIExplicit exercises the explicit ciOverride behaviour used by
// orchestrators. Defaulting to the env probe is exercised by the
// process-level tests in cmd/hub; here we only assert the override
// path.
func TestSinkIsInteractive(t *testing.T) {
	var buf bytes.Buffer
	ciSink := output.NewForTest(buf.Write, buf.Write, true)
	if ciSink.IsInteractive() {
		t.Fatalf("CI sink must report IsInteractive()==false")
	}
	localSink := output.NewForTest(buf.Write, buf.Write, false)
	if !localSink.IsInteractive() {
		t.Fatalf("local sink must report IsInteractive()==true")
	}
}
