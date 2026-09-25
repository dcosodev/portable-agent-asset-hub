// internal/connect — payload contracts shared between the Go
// orchestrator and the child Node runner.
//
// The structs mirror the JSON shapes the .mjs child emits on
// stdout. The Go side decodes every payload through
// json.Unmarshal / Marshal so the on-wire format is the only
// contract and either side can evolve independently as long as
// the keys stay stable.
//
// Every field carries an explicit JSON tag and explicit zero
// values that map "nothing to report" to the operator-visible
// empty form (empty string / empty slice). The slice mandates
// no Date.now()-style timestamps in the JSON payload; the
// runner stamps a fixed generatedAt so two previews of the same
// plan produce byte-identical JSON, which is the invariant the
// deterministic-output suite asserts on.

package connect

// PreviewPayload is the JSON shape returned by a successful
// `hub hub connect preview --json`. The Go side emits it to
// stdout; the test harness parses it back into a
// `{observedDigest, plan:{…}}` envelope.
type PreviewPayload struct {
	// Command is always "connect preview" — surfaced so
	// auditing tools can correlate the payload to the action.
	Command string `json:"command"`
	// Action echoes the parser-resolved verb.
	Action string `json:"action"`
	// Harness is the renderer id the preview ran against
	// ("hermes" for now; "openclaw" future-compatible).
	Harness string `json:"harness"`
	// ObservedDigest is the SHA-256 of the canonical manifest
	// bytes. 64 lowercase hex characters. Byte-deterministic
	// across invocations of the same logical plan.
	ObservedDigest string `json:"observedDigest"`
	// PlanDigest is the canonical SHA-256 of the plan CONTENT
	// (volatile runId / generatedAt normalised out). This is the
	// value the operator carries across the preview→apply boundary
	// as `--reviewed-digest`. It is byte-deterministic across two
	// previews of the same logical input. The amendment pins
	// planDigest as a distinct field from observedDigest so the
	// audit trail can disambiguate the reviewed contract digest
	// from the live CAS manifest digest.
	PlanDigest string `json:"planDigest"`
	// Profile is the resolved Profile the adapter returned;
	// surfaced for human readers without parsing the plan.
	Profile ProfileSummary `json:"profile"`
	// Plan is the frozen manifest the apply step will consume.
	Plan PreviewPlan `json:"plan"`
}

// ProfileSummary is a small projected view of the in-memory
// Profile record. We emit only the immutable metadata the
// operator needs; the deep profile data stays in storage.
type ProfileSummary struct {
	ID string `json:"id"`
}

// PreviewPlan mirrors the on-the-wire ManifestV1 projection the
// adapter hands back. Go's encoding/json emits sorted keys (via
// the deterministic map-key sort), and the child runner
// serializes the plan fields explicitly, so two consecutive
// previews of the same input produce byte-identical JSON.
type PreviewPlan struct {
	RunID           string            `json:"runId,omitempty"`
	SnapshotID      string            `json:"snapshotId"`
	Harness         string            `json:"harness"`
	ProfileID       string            `json:"profileId"`
	TargetRoot      string            `json:"targetRoot"`
	Files           []PreviewPlanFile `json:"files"`
	GeneratedAt     string            `json:"generatedAt"`
	RendererVersion string            `json:"rendererVersion"`
}

// PreviewPlanFile is the immutable per-file projection the apply
// step consumes. We deliberately project `bytes` away from the
// human-visible payload — the wire carries only the metadata so
// the operator can read the plan without dumping hex.
type PreviewPlanFile struct {
	RelativePath string `json:"relativePath"`
	SHA256       string `json:"sha256"`
	Size         int    `json:"size"`
	Mode         uint32 `json:"mode"`
	SourceRef    string `json:"sourceRef"`
}

// ApplyPayload mirrors PreviewPayload but adds the run id and
// the list of files the apply actually wrote.
type ApplyPayload struct {
	Command        string   `json:"command"`
	Action         string   `json:"action"`
	Harness        string   `json:"harness"`
	RunID          string   `json:"runId"`
	ObservedDigest string   `json:"observedDigest"`
	WrittenFiles   []string `json:"writtenFiles"`
	// BackupRoot is the on-disk path the apply created. The
	// slice does not require surfacing it; we include it so a
	// future operator action (e.g. manual rollback in
	// `docs/architecture/operator-shell.md`) can find the
	// backup without re-scanning the target.
	BackupRoot string `json:"backupRoot"`
}

// RollbackPayload is the JSON shape returned by a successful
// `hub hub connect rollback --json`. The slice mandates
// (runId, restored[]); we project only those keys.
type RollbackPayload struct {
	Command  string   `json:"command"`
	Action   string   `json:"action"`
	RunID    string   `json:"runId"`
	Restored []string `json:"restored"`
}

// ErrorPayload is the structured form an adapter failure takes
// when the child decides to surface it via stdout (e.g. drift
// detection). The Go dispatcher can decide to print Error
// verbatim on stderr; tests assert on stderr content but accept
// the structured shape when present on stdout.
type ErrorPayload struct {
	Command  string `json:"command"`
	Action   string `json:"action"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	HTTPCode int    `json:"httpCode"`
}
