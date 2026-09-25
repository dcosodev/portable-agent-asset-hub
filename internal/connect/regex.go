// internal/connect — regexes and shared constants.
//
// These patterns are the canonical T8 surface validation, mirrored
// from packages/materializers/src/{preview,apply,rollback}.ts. The
// Go side MUST refuse invalid inputs BEFORE the adapter runs so the
// audit trail clearly attributes the rejection to the Go shell
// rather than to the TypeScript adapter. Drift between this file
// and the TS side is a contract regression; if a future TS-side
// change widens a regex, mirror it here in the same patch.

package connect

import "regexp"

// profileIDRegex matches a slice-mandated profile id:
// "prf_" followed by one or more of [A-Za-z0-9._-].
//
// Mirrors: packages/materializers/src/preview.ts
//
//	if (!/^prf_[A-Za-z0-9._-]+$/u.test(input.profileId)) {
//	  throw new HubError('VALIDATION', 'invalid profileId', 400);
//	}
var profileIDRegex = regexp.MustCompile(`^prf_[A-Za-z0-9._-]+$`)

// snapshotIDRegex mirrors packages/materializers/src/preview.ts's
// snapshot-id gate (snap_<alnum>._-).
//
// Mirrors: packages/materializers/src/preview.ts
//
//	if (!/^snap_[A-Za-z0-9._-]+$/u.test(input.snapshotId)) {
//	  throw new HubError('VALIDATION', 'invalid snapshotId', 400);
//	}
var snapshotIDRegex = regexp.MustCompile(`^snap_[A-Za-z0-9._-]+$`)

// runIDRegex mirrors packages/materializers/src/rollback.ts's run
// id gate (run_<alnum>._-). Spaces are explicitly NOT in the
// alphabet; the test suite locks that with a dedicated case
// ("run has spaces" → exit 2).
//
// Mirrors: packages/materializers/src/rollback.ts
//
//	if (!/^run_[A-Za-z0-9._-]+$/u.test(input.runId)) { … }
var runIDRegex = regexp.MustCompile(`^run_[A-Za-z0-9._-]+$`)

// digestRegex is exactly 64 lowercase hex characters — the
// canonical SHA-256 shape used by every digest the adapter
// exchanges. The test harness locks the lowercase-only invariant
// (see tests/go/connect/apply-reviewed-digest.test.ts case:
// "uppercase --reviewed-digest exits 2").
var digestRegex = regexp.MustCompile(`^[0-9a-f]{64}$`)
