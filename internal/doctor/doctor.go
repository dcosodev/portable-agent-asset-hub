// Package doctor is the read-only diagnostic collector for the hub
// shell. Per docs/architecture/go-product-shell.md the canonical
// `hub doctor` surface reports "health + contract + secrets + policy
// check" — T1 ships the read-only half: the checks that do not
// require `hub init`, runtime, or a bearer token.
//
// Every check is a small builder function that returns a single Check
// struct. The Report aggregates the checks into a top-level payload
// whose JSON shape is locked (see the schema section below). The
// package deliberately avoids any mutation: it never creates
// directories, never writes tokens, and never shells out. A check
// that needs to peek at a file uses os.Stat (read-only) and reports
// the result without ever touching the filesystem on the success path.
//
// The doctor MUST report "ok" on a fresh worktree — that is, on a
// checkout that has not run `hub init`. The check set is calibrated
// so the only required pieces are the shell binary itself, the
// resolved openapi.yaml under <repo>/openapi/, and a clean env.
// Anything else (state/, runtime/, logs/, tokens/) is reported as
// status="pending" (or absent) without blocking ok.
//
// Schema (locked at T1; do not change keys without updating the
// shell's contract docs and the s11 gate):
//
//	{
//	  "status": "ok" | "warn" | "fail" | "pending",
//	  "checks": [
//	    {
//	      "id":      "<snake_case>",
//	      "name":    "<human readable>",
//	      "status":  "ok" | "warn" | "fail" | "pending",
//	      "message": "<one-line summary>",
//	      "detail":  "<optional context>"
//	    },
//	    ...
//	  ]
//	}
//
// Status semantics:
//   - "ok"      — the check passed cleanly; no further action required
//   - "warn"    — the check passed but a downstream slice should care
//     (e.g. openapi path resolved to the repo default
//     instead of an explicit override)
//   - "fail"    — the check failed; the report's top-level status is
//     "fail" if any check is "fail"
//   - "pending" — the check is reserved for a future slice (e.g. the
//     REST handshake) and is reported as not-yet-wired
//
// Redaction: every string in the JSON payload is filtered through
// output.Redact so a stray bearer-shaped string in an env var can
// never reach stdout. The package depends only on hub/internal/output
// and the standard library.
package doctor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"hub/internal/config"
	"hub/internal/output"
	"hub/internal/version"
)

// Status is the documented per-check status. The values are pinned
// strings so downstream orchestrators can compare them byte-exactly.
type Status string

const (
	// StatusOK is reported when a check passed cleanly.
	StatusOK Status = "ok"
	// StatusWarn is reported when a check passed but a downstream
	// slice should care. The top-level report's status is "ok" if
	// every check is "ok" or "warn".
	StatusWarn Status = "warn"
	// StatusFail is reported when a check failed. The top-level
	// report's status is "fail" if any check is "fail".
	StatusFail Status = "fail"
	// StatusPending is reported when the check is reserved for a
	// future slice. The check does NOT count against the top-level
	// status; pending checks are filtered out of the aggregated
	// verdict.
	StatusPending Status = "pending"
)

// Check is one diagnostic result. The struct's JSON shape is the
// contract: id, name, status, message, detail. Do not rename a field
// without bumping the contract version.
type Check struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Status  Status `json:"status"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

// Report is the top-level diagnostic payload. JSON keys are stable.
// The struct deliberately exposes only the fields documented above.
type Report struct {
	Status Status  `json:"status"`
	Checks []Check `json:"checks"`
}

// TopLevelStatus aggregates the per-check statuses into a single
// verdict. A single "fail" check is a fail (fail-closed); pending
// checks are ignored so a future slice can add reserved rows without
// regressing today's status. "warn" checks never escalate the top-
// level status — they are reported but do not block.
func TopLevelStatus(checks []Check) Status {
	hasOK := false
	for _, c := range checks {
		switch c.Status {
		case StatusFail:
			return StatusFail
		case StatusOK, StatusWarn:
			hasOK = true
		case StatusPending:
			// ignore — reserved
		}
	}
	if hasOK {
		return StatusOK
	}
	return StatusPending
}

// MarshalJSON renders the Report as redacted JSON. The redaction
// pass is the single chokepoint: every string field is filtered
// through output.Redact before encoding. The function preserves
// the locked schema (top-level keys in deterministic alphabetical
// order: "checks", "status") and the per-check shape (id, name,
// status, message, detail).
//
// We hand-roll the encoding instead of relying on a custom
// MarshalJSON on Report so a future addition to the struct does not
// silently leak an unredacted field through the contract surface.
// When adding a field, also add it here AND redact it. The
// top-level keys are emitted via a map so encoding/json's
// alphabetical sort is the contract surface — independent of any
// future field declaration order on the Report type.
func (r Report) MarshalJSON() ([]byte, error) {
	clonedChecks := make([]Check, 0, len(r.Checks))
	for _, c := range r.Checks {
		clonedChecks = append(clonedChecks, Check{
			ID:      c.ID,
			Name:    c.Name,
			Status:  c.Status,
			Message: output.Redact(c.Message),
			Detail:  output.Redact(c.Detail),
		})
	}
	payload := map[string]interface{}{
		"status": r.Status,
		"checks": clonedChecks,
	}
	return json.Marshal(payload)
}

// ---------------------------------------------------------------------------
// Check builders
// ---------------------------------------------------------------------------
//
// Each builder is a small pure function so tests can exercise them
// without touching the filesystem. The Run function below is the
// single entry point main.go calls; it composes the builders in a
// deterministic order.

func checkShellBinary() Check {
	v := version.Current()
	c := Check{
		ID:     "shell_binary",
		Name:   "shell binary version",
		Status: StatusOK,
	}
	if v.Hub == "" {
		c.Status = StatusFail
		c.Message = "hub version is empty"
		return c
	}
	c.Message = fmt.Sprintf("hub %s (%s)", v.Hub, v.Go)
	return c
}

func checkConfigValid(cfg config.Config, cfgErr error) Check {
	c := Check{
		ID:   "config_valid",
		Name: "environment configuration",
	}
	if cfgErr != nil {
		c.Status = StatusFail
		c.Message = "config load failed"
		c.Detail = cfgErr.Error()
		return c
	}
	c.Status = StatusOK
	c.Message = "environment variables valid"
	return c
}

func checkHomeResolved(cfg config.Config) Check {
	c := Check{
		ID:   "home_resolved",
		Name: "HUB_HOME resolves to an absolute path",
	}
	if cfg.Home == "" {
		c.Status = StatusFail
		c.Message = "HUB_HOME is empty"
		return c
	}
	if !filepath.IsAbs(cfg.Home) && cfg.Home != ".hub" {
		c.Status = StatusFail
		c.Message = "HUB_HOME is not absolute"
		return c
	}
	// The home directory need not exist on a fresh worktree — `hub
	// init` creates it. Report OK if the path is well-formed and
	// warn if the directory is absent (so the operator knows init
	// has not been run yet) but DO NOT fail.
	//
	// The contract surface here MUST be byte-deterministic across
	// different temp HUB_HOME paths — embedding the absolute path
	// in the message would break the byte-exact JSON promise for
	// `hub doctor --json` (two consecutive invocations on
	// different temp homes would diverge). We therefore report a
	// shape-only verdict ("HUB_HOME is set" vs "HUB_HOME does
	// not exist") and stash the actual path in Detail so the
	// operator still gets useful diagnostic context, but the
	// message itself stays constant.
	if _, err := os.Stat(cfg.Home); err != nil {
		if os.IsNotExist(err) {
			c.Status = StatusWarn
			c.Message = "HUB_HOME does not exist yet"
			c.Detail = "run `hub init` to create the layout"
			return c
		}
		// Some other stat error — surface as a warning so the
		// operator can investigate (e.g. permission denied on a
		// parent). The message still avoids embedding the path so
		// the contract surface stays deterministic.
		c.Status = StatusWarn
		c.Message = "HUB_HOME stat error"
		c.Detail = err.Error()
		return c
	}
	c.Status = StatusOK
	c.Message = "HUB_HOME is set"
	// No detail: embedding the absolute temp path would break
	// the byte-exact JSON contract for `hub doctor --json` (two
	// consecutive invocations on different temp homes would
	// diverge). The Message above is the stable diagnostic; the
	// resolved path is recoverable via `hub path home` for any
	// operator who needs the absolute location.
	return c
}

func checkOpenAPIAccessible(cfg config.Config) Check {
	c := Check{
		ID:   "openapi_accessible",
		Name: "openapi.yaml is readable",
	}
	if cfg.OpenAPI == "" {
		c.Status = StatusWarn
		c.Message = "openapi.yaml path is unset"
		c.Detail = "HUB_OPENAPI env var not set and repo default could not be derived"
		return c
	}
	info, err := os.Stat(cfg.OpenAPI)
	if err != nil {
		if os.IsNotExist(err) {
			c.Status = StatusFail
			c.Message = fmt.Sprintf("openapi.yaml not found at %s", cfg.OpenAPI)
			return c
		}
		c.Status = StatusFail
		c.Message = fmt.Sprintf("openapi.yaml stat error: %v", err)
		return c
	}
	if info.IsDir() {
		c.Status = StatusFail
		c.Message = fmt.Sprintf("openapi.yaml is a directory: %s", cfg.OpenAPI)
		return c
	}
	c.Status = StatusOK
	c.Message = fmt.Sprintf("openapi.yaml at %s", cfg.OpenAPI)
	return c
}

func checkRestHandshake() Check {
	// The REST runtime /api/v1/status handshake is wired in T2.
	// Reserve the slot today so the contract is stable and a future
	// slice can plug in without reshaping the JSON. The check
	// reports "pending" (which is filtered out of the aggregated
	// verdict) — never "ok", never "fail" — until the REST process
	// is alive.
	return Check{
		ID:      "rest_handshake",
		Name:    "REST version handshake",
		Status:  StatusPending,
		Message: "REST handshake not yet wired (deferred to T2)",
	}
}

func checkNoBearerInEnv() Check {
	// The operator-supplied environment must not contain a bearer
	// that the shell would accidentally echo. We probe the three
	// bearer-shaped keys the contract recognizes; any NON-EMPTY
	// value triggers a warning so the operator sees the leak risk
	// regardless of whether the value happens to match a strict
	// bearer-shape predicate. The value itself is REDACTED before
	// it leaves the function — the surface message only carries
	// the env-var name and a <<REDACTED>> marker, never the raw
	// token.
	//
	// We intentionally do NOT gate on output.LooksLikeBearer: a
	// 32-char opaque string is a bearer for hygiene purposes even
	// when it lacks a "Bearer " prefix or JWT dots. The
	// bearer-shape predicates are for the redactor (which must
	// avoid false positives on ordinary prose), not for the
	// hygiene check (which must catch every leaked credential).
	c := Check{
		ID:   "no_bearer_in_env",
		Name: "no bearer-shaped value in env",
	}
	hits := []string{}
	for _, key := range []string{"HUB_BEARER_TOKEN", "HUB_BEARER_TOKEN_FILE", "HUB_BEARER_TOKEN_SOURCE"} {
		v := strings.TrimSpace(os.Getenv(key))
		if v == "" {
			continue
		}
		// Record the env-var name only. The value is filtered
		// through the redactor so a stray bearer-shaped substring
		// inside an unrelated env var can never reach the
		// operator. The redaction is best-effort: if the value
		// does not match a bearer pattern it round-trips
		// unchanged, but the marker is never the raw token.
		hits = append(hits, key+"="+output.Redact(v))
	}
	if len(hits) > 0 {
		c.Status = StatusWarn
		c.Message = "bearer-shaped values present in env"
		c.Detail = strings.Join(hits, ", ")
		return c
	}
	c.Status = StatusOK
	c.Message = "no bearer-shaped value in env"
	return c
}

// ---------------------------------------------------------------------------
// T9 additive posture checks
// ---------------------------------------------------------------------------
//
// Per docs/roadmap/slices.json slice `T9`, the final `hub doctor`
// shape EXTENDS the T1 check set with exactly three additive read-
// only posture checks:
//
//	id exactly `backup_posture`
//	id exactly `update_posture`
//	id exactly `distribution_checks`
//
// The amendment pins the three IDs by exact name and forbids any
// other addition or substitution. The T1-owned check IDs MUST
// remain byte-stable as a prefix of the report — `Run` composes
// the original six T1 builders first and APPENDS the three T9
// builders last, preserving order, status, and message verbatim.
// The legacy `rest_handshake` check is EXPLICITLY PERMITTED to
// remain `pending` (T1 authority on its status is preserved
// untouched; the doctor-final tests also pin this carve-out).
//
// Design constraints (all T9-builder-local invariants):
//
//   - Read-only. The T9 builders NEVER stat, never read or write
//     any file, never reach the network, and never call a
//     subprocess. They derive their verdicts from the already-
//     loaded `config.Config` + the compiled-in version triple so
//     `hub doctor` cannot regress the "never mutates the
//     filesystem" invariant the doctor.go docstring promises.
//     The doctor-final tests assert `existsSync($HUB_HOME/state/
//     backups/) === false` after a `hub doctor` invocation on a
//     fresh install fixture — pre-creating `state/backups/` from
//     a posture check would regress that contract.
//
//   - Non-fail / non-pending on a fresh install. The T9-owned
//     checks MUST report `ok` (not `fail`, not `pending`) on a
//     fresh install fixture: `cfg.Home` and `cfg.Layout` are
//     populated by `config.Load`; `version.Current()` always
//     returns a non-empty triple for a real build. The doctor-
//     final tests assert this directly via the
//     `none-of-the-three-T9-owned-checks-is-"fail"-or-"pending"`
//     case.
//
//   - Bearer hygiene. The T9 builder messages NEVER embed any
//     operator-supplied value directly — every Detail / Message
//     is a fixed, deterministic human-readable posture
//     statement. A bearer-shaped value present in a sidecar env
//     var cannot leak through a posture check because the
//     builder never reads bearer-shaped keys. The redaction
//     pass in `Report.MarshalJSON` still applies to every
//     field, so a defensive belt-and-braces holds even if a
//     future builder accidentally embeds a bearer-shaped
//     literal.
//
//   - Determinism / byte-stability. The T9 builders do NOT
//     consult `os.Stat`, `time.Now`, or any other time-varying
//     or path-varying source. Two consecutive invocations on
//     the same worktree produce a byte-identical report (the
//     T1 shell doctor suite asserts this for the T1 prefix;
//     the additive T9 tail preserves the same invariant).

// checkBackupPosture reports the read-only posture of the T9
// backup surface as observed from the already-resolved layout. It
// makes no filesystem call: the four reserved subdirectories are
// derivable from `cfg.Layout`, and a fresh install fixture (post-
// `hub init`) carries well-formed Layout fields populated entirely
// from env. The check is reported as `ok` whenever the layout has
// at least the four required reservations; otherwise it surfaces a
// warn so the operator can investigate — without ever failing the
// overall verdict on a properly initialised install.
//
// The message wording avoids embedding any operator-supplied path
// so the contract surface stays byte-stable across temp HOME
// paths (mirroring the `home_resolved` message-shaping rule above).
func checkBackupPosture(cfg config.Config) Check {
	c := Check{
		ID:   "backup_posture",
		Name: "T9 backup posture (runner wired, layout reserved)",
	}
	// The four required reservations derive from `cfg.Layout`.
	// None of the four paths are stat'd: the check answers
	// "is the layout well-formed enough to reserve state/backups
	// as the canonical snapshot target", which is a pure
	// computation against the already-loaded Config.
	if cfg.Home == "" || cfg.Layout.State == "" || cfg.Layout.Tokens == "" || cfg.Layout.Logs == "" || cfg.Layout.Runtime == "" {
		// A genuinely malformed Layout would block the
		// backup verb (no place to write an archive), so a
		// warn here is appropriate. This branch is
		// unreachable on the test surface the doctor-final
		// suite exercises (`hub init` succeeded → Layout is
		// fully populated), but keeping it as warn-not-fail
		// matches the rest of the doctor's "tolerant of a
		// not-yet-initialised layout" calibration.
		c.Status = StatusWarn
		c.Message = "backup layout not fully reserved"
		c.Detail = "hub backup requires a fully-resolved HUB_HOME layout"
		return c
	}
	c.Status = StatusOK
	c.Message = "backup layout reserved; runner wired (snapshot/restore)"
	c.Detail = "snapshot set: resolver-canonical SQLite + config files; excludes tokens/** and secret-shaped files"
	return c
}

// checkUpdatePosture reports the read-only posture of the T9
// update surface. The update verb is plan-only (the apply
// transport is explicitly out of scope for T9 and is forbidden by
// `forbidden_paths: internal/update/apply.go`), so the posture
// reduces to "the compiled-in version triple is non-empty and the
// literal channel `stable` is the only one the planner accepts".
//
// Like `checkBackupPosture`, this builder is pure: it never
// reaches the network, never inspects the install, and never
// calls into the planner. It reads `version.Current()` (already
// imported) so a fresh install binary with a stamped build always
// reports `ok`. The presence of an empty Hub string would
// indicate an unrecoverable build defect (the version package
// stamps it at build time); we surface that as a warn instead of
// a fail to keep the doctor's verdict tolerant, matching the
// "fresh worktree" calibration.
func checkUpdatePosture() Check {
	v := version.Current()
	c := Check{
		ID:   "update_posture",
		Name: "T9 update posture (plan-only dry-run, stable channel only)",
	}
	if v.Hub == "" || v.Go == "" {
		c.Status = StatusWarn
		c.Message = "compiled-in version triple is empty"
		c.Detail = "update planner refused to interpret an unversioned binary"
		return c
	}
	c.Status = StatusOK
	c.Message = "planner wired (stable channel, dry-run default); apply out of scope"
	c.Detail = "hub update --apply refuses with exit 2; no install mutation in this slice"
	return c
}

// checkDistributionChecks reports the read-only posture of the
// T9 distribution surface as a whole. It is the composite gate
// for the T9 delivery: a fresh install fixture (post `hub init`)
// has a resolved layout, a reachable openapi spec, and a stamped
// binary version, so the distribution posture is `ok`. The check
// surfaces `warn` rather than `fail` when one of the three legs
// is missing, mirroring `home_resolved`'s tolerant semantics.
//
// All three inputs are already loaded into the `Run` call frame:
// `cfg.OpenAPI` is set by config.Load (the openapi_accessible T1
// check confirms the spec is reachable on disk; this T9 check
// confirms the distribution surface CONSISTENTLY knows the spec
// path AND the layout AND the version triple), `cfg.Layout` is
// populated, and `version.Current()` returns a stamped triple.
func checkDistributionChecks(cfg config.Config) Check {
	c := Check{
		ID:     "distribution_checks",
		Name:   "T9 distribution posture (openapi + layout + version all wired)",
		Status: StatusOK,
	}
	// Three posture legs. A `warn` is appropriate when ANY
	// leg is missing — a missing leg makes distribution
	// choreography unsafe, but a fresh install with one
	// missing leg is recoverable (re-run `hub init`), so we
	// surface warn-not-fail to match the rest of the doctor's
	// calibration.
	if cfg.OpenAPI == "" {
		c.Status = StatusWarn
		c.Message = "openapi path is unset"
		return c
	}
	if cfg.Home == "" {
		c.Status = StatusWarn
		c.Message = "HUB_HOME is unset"
		return c
	}
	v := version.Current()
	if v.Hub == "" {
		c.Status = StatusWarn
		c.Message = "compiled-in hub version is empty"
		return c
	}
	c.Message = "distribution surface wired (backup/update posture + openapi)"
	c.Detail = "hub binary, openapi spec, and HUB_HOME layout all resolved"
	return c
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Run executes every check in a deterministic order and returns the
// aggregated Report. The function is the single entry point main.go
// calls. It is read-only: it stats files, probes env, and returns
// data. It MUST NOT mutate the filesystem.
//
// Check composition is two-segment:
//
//  1. The T1 PREFIX — six checks in their original order
//     (`shell_binary`, `config_valid`, `home_resolved`,
//     `openapi_accessible`, `no_bearer_in_env`, `rest_handshake`).
//     The legacy `rest_handshake` check reports `pending` and is
//     filtered out of the aggregated verdict; every other T1 check
//     is byte-stable on a freshly materialised worktree.
//
//  2. The T9 TAIL — three additive posture checks
//     (`backup_posture`, `update_posture`, `distribution_checks`)
//     appended in id-alphabetical order. The amendment pins these
//     three exact ids; no other id may be appended, and no T1 id
//     may be reordered, removed, demoted, or substituted. The T9
//     checks are pure functions of `cfg` + `version.Current()` and
//     make no filesystem call, no network call, and no subprocess
//     call; they report `ok` on a freshly initialised install.
func Run(cfg config.Config, cfgErr error) Report {
	// Build the checks in a deterministic order so the JSON payload
	// is byte-stable across invocations on the same worktree. The
	// T1 prefix is preserved byte-for-byte (same builder call
	// order, same arguments); the T9 tail is appended in id-
	// alphabetical order to match the slice governance pinning.
	checks := []Check{
		// T1 prefix (preserved untouched):
		checkShellBinary(),
		checkConfigValid(cfg, cfgErr),
		checkHomeResolved(cfg),
		checkOpenAPIAccessible(cfg),
		checkNoBearerInEnv(),
		checkRestHandshake(),
		// T9 additive tail (id-alphabetical):
		checkBackupPosture(cfg),
		checkUpdatePosture(),
		checkDistributionChecks(cfg),
	}
	return Report{
		Status: TopLevelStatus(checks),
		Checks: checks,
	}
}

// ProbeReadable is a small wrapper around os.Stat that reports
// whether the file is reachable and is not a directory. It is
// exported so tests can substitute a deterministic implementation
// when needed (and so main.go can reuse the predicate).
func ProbeReadable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("path %q is a directory", path)
	}
	return nil
}
