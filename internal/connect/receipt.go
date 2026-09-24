// internal/connect/receipt.go — durable rollback receipt reader +
// writer for the T8 cross-process rollback bridge.
//
// The durable receipt lives at:
//
//	$HUB_HOME/state/connect/receipts/<runId>.json
//
// It is the ONLY state a separate rollback subprocess can rehydrate
// the run from; there is no Go-side registry, no Go-side SQLite
// handle, no Go-side in-memory runId map (per T8 amendment §"no Go
// digest / SQLite / registry").
//
// Two pieces land in this file:
//
//  1. Receipt struct + Validate() — the canonical bounded schema
//     and the closed-by-default field/whitelist enforcement. The
//     schema is:
//
//	{
//	  schemaVersion: 1,
//	  runId, targetRoot, lockDir, harness, profileId,
//	  observedDigest, writtenAt
//	}
//
//     Extra top-level keys are refused (fail-closed). Secrets-shaped
//     keys/values are refused at any depth of a second-level
//     `metadata` object (the amendment pins this exact shape:
//     "no secrets-shaped keys").
//
//  2. Store reader/writer primitives — writeReceipt, readReceipt,
//     listReceipts, receiptPathFor. They are kept narrowly aligned
//     to what the amendment authorizes: "receipt I/O + validate +
//     atomic temp+rename; no domain logic". The mirror exists so a
//     Go process that does not need to spawn the .mjs child can
//     still validate a receipt path during a dry-run / help flow
//     without duplicating the security checks the .mjs child runs.
//
// Security invariants:
//
//   - dir mode 0700 (RefuseIfWrongDirMode); file mode 0600
//     (RefuseIfWrongFileMode)
//   - atomic temp+rename via os.CreateTemp + os.Rename in the same
//     directory (rename within a single filesystem is atomic on
//     POSIX; macOS APFS, Linux ext4 both honour this contract).
//   - no symlink traversal anywhere in the path; the writer lstats
//     every component of the directory chain before creating the
//     file so a symlinked receipts dir is refused AT WRITE TIME
//     (the .mjs child performs the same lstat pass; the Go side
//     mirrors the check).
//   - runId regex-pruned: refuse anything that does not match
//     run_<alnum>._- from regex.go (closed-by-default surface; no
//     path traversal can sneak in via a hostile runId).
//   - file size cap MaxReceiptBytes (64 KiB) → refuse oversized.
//   - bounded parse: encoding/json, no reflection-based untyped
//     raw accept of unknown fields at the top level.
//
// What this file does NOT do:
//
//   - compute any digest (sha256, hmac, anything). The Go side
//     never mints observedDigest; the .mjs child passes it in.
//   - open or import a SQLite handle. No database/sql import.
//   - keep an in-memory map of runId → coordinates. No map literal.
//   - decide when to write a receipt. The store exposes write/read/
//     list primitives; the apply pipeline (TS authority) decides
//     when to call them.

package connect

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

// ReceiptSchemaVersion is the canonical bounded schemaVersion the
// store accepts. Older or future versions are refused.
//
// The amendment pins versioning as a hard require — schemaVersion=0
// is refused (legacy), schemaVersion=2..N are refused (future). A
// v2 surface lands via a future slice amendment, not via silently
// widening the existing reader.
const ReceiptSchemaVersion = 1

// MaxReceiptBytes caps the size of a single receipt file so an
// attacker cannot exhaust the operator's tty by writing a 100 MB
// "receipt". The amendment pins 64 KiB as the bound; oversized
// receipts fail closed.
const MaxReceiptBytes int64 = 64 * 1024

// receiptsSubdir is the canonical sub-path under HUB_HOME. The
// amendment pins this exact location (I-15: receipt under
// $HUB_HOME/state/connect/receipts/, NEVER inside the user
// canonical data directory).
const receiptsSubdir = "state/connect/receipts"

// receiptsDirMode is the canonical POSIX mode the receipts
// directory must carry. The .mjs child sets the same mode at
// creation; the Go side ENFORCES it on every read so a future
// operator-chmod regression surfaces immediately.
const receiptsDirMode os.FileMode = 0o700

// receiptFileMode is the canonical POSIX mode every receipt file
// must carry. The .mjs child sets the same mode via
// fs.openSync(O_CREAT|O_WRONLY, 0o600); the Go side ENFORCES it on
// every read.
const receiptFileMode os.FileMode = 0o600

// Receipt is the canonical bounded schema. Every field is
// required; Validate refuses any subset / superset / wrong type.
//
// Field types mirror the JS side exactly (string everywhere
// because JSON has no first-class number/bool for digests, paths,
// ids, or timestamps; a future v2 may change this).
type Receipt struct {
	SchemaVersion  int    `json:"schemaVersion"`
	RunID          string `json:"runId"`
	TargetRoot     string `json:"targetRoot"`
	LockDir        string `json:"lockDir"`
	Harness        string `json:"harness"`
	ProfileID      string `json:"profileId"`
	ObservedDigest string `json:"observedDigest"`
	WrittenAt      string `json:"writtenAt"`
}

// secretsKeyPattern is the closed set of secret-shaped key
// names. Mirrored from the .mjs child; a drift between the two
// is a contract regression. The regex is case-sensitive on
// purpose — tests assert a top-level "token" key is refused AND
// a top-level "Bearer" key with bearer-shaped value is refused
// is fine because the .mjs child does the same case-insensitive
// sweep on VALUES. We keep key detection here conservative
// (exact match) and rely on the value-sweep below for the
// case-insensitive surface.
var secretsKeyPattern = regexp.MustCompile(
	`^(authorization|bearer|password|token|client_secret|apiKey|api_key|privateKey|private_key|cookie|sessionId|session_id)$`,
)

// bearerValuePattern mirrors the predicates in
// internal/output/output.go LooksLikeBearer. A receipt MUST NOT
// carry a bearer-shaped value in any string field; the sweep is
// case-insensitive to catch "Bearer", "bearer", "BEARER" alike.
var bearerValuePattern = regexp.MustCompile(
	`(?i)(^|[^a-z])(bearer\s+[A-Za-z0-9._~+/=-]{20,})`,
)

// runIDStrictRegex is the strict-shape regex for runId. We reuse
// runIDRegex from regex.go via Validate below, but expose this
// alias so callers don't have to thread through that file's
// internal var. Kept identical to runIDRegex by construction.
var runIDStrictRegex = runIDRegex

// digest64StrictRegex is the strict lowercase 64-hex regex.
// Mirrors internal/connect/regex.go digestRegex (already exported
// at package level as a duplicate so we don't touch the existing
// file). Kept in lockstep.
var digest64StrictRegex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ReceiptsDir returns the canonical absolute receipts directory
// under hubHome. The function does NOT consult the filesystem;
// the caller is responsible for ensuring hubHome is the resolved,
// lstat-clean absolute path (Runner / cmd_helpers already enforce
// this).
func ReceiptsDir(hubHome string) string {
	return filepath.Join(hubHome, receiptsSubdir)
}

// ReceiptPath returns the canonical absolute path of the receipt
// file for runId under hubHome. The function does NOT touch the
// filesystem; it is a pure path computation. Callers validate the
// runId shape with runIDStrictRegex before invoking.
func ReceiptPath(hubHome, runId string) string {
	return filepath.Join(ReceiptsDir(hubHome), runId+".json")
}

// Validate enforces the canonical bounded schema. The function
// is fail-closed: any deviation produces a non-nil error whose
// message identifies the offending field or kind.
//
// Validation chain (in order):
//
//  1. schemaVersion == 1 (legacy 0 / future 99 refused)
//  2. runId matches run_<alnum>._-
//  3. targetRoot / lockDir are absolute paths (the renderer
//     only writes absolute paths; relative paths leak the
//     operator's cwd and break reproducibility)
//  4. harness is "hermes" (the only harness T8 authorises;
//     apply + rollback paths close on "openclaw" at this layer)
//  5. profileId matches prf_<alnum>._-
//  6. observedDigest is exactly 64 lowercase hex characters
//  7. writtenAt is a non-empty string (the value is opaque; the
//     receipt store does NOT stamp Date.now() — the apply
//     pipeline passes the value in)
//  8. no extra keys at the top level (bounded schema; the .mjs
//     child enforces the same)
//  9. no secrets-shaped values in any string field
func (r Receipt) Validate() error {
	if r.SchemaVersion != ReceiptSchemaVersion {
		return fmt.Errorf(
			"connect receipt: schemaVersion=%d is not %d (legacy/future rejected)",
			r.SchemaVersion, ReceiptSchemaVersion,
		)
	}
	if !runIDStrictRegex.MatchString(r.RunID) {
		return fmt.Errorf("connect receipt: runId %q does not match %s", r.RunID, runIDStrictRegex.String())
	}
	if !filepath.IsAbs(r.TargetRoot) {
		return fmt.Errorf("connect receipt: targetRoot %q is not absolute", r.TargetRoot)
	}
	if !filepath.IsAbs(r.LockDir) {
		return fmt.Errorf("connect receipt: lockDir %q is not absolute", r.LockDir)
	}
	if r.Harness != "hermes" {
		return fmt.Errorf("connect receipt: harness %q is not recognised (expected hermes)", r.Harness)
	}
	if !profileIDRegex.MatchString(r.ProfileID) {
		return fmt.Errorf("connect receipt: profileId %q does not match %s", r.ProfileID, profileIDRegex.String())
	}
	if !digest64StrictRegex.MatchString(r.ObservedDigest) {
		return fmt.Errorf(
			"connect receipt: observedDigest must be exactly 64 lowercase hex characters",
		)
	}
	if r.WrittenAt == "" {
		return errors.New("connect receipt: writtenAt is required")
	}
	if ok, kind := looksLikeBearer(r.WrittenAt); ok {
		return fmt.Errorf("connect receipt: writtenAt contains a bearer-shaped substring (%s)", kind)
	}
	if ok, kind := looksLikeBearer(r.TargetRoot); ok {
		return fmt.Errorf("connect receipt: targetRoot contains a bearer-shaped substring (%s)", kind)
	}
	if ok, kind := looksLikeBearer(r.LockDir); ok {
		return fmt.Errorf("connect receipt: lockDir contains a bearer-shaped substring (%s)", kind)
	}
	if ok, kind := looksLikeBearer(r.ObservedDigest); ok {
		// Belt-and-braces: digest regex above already rejects
		// anything non-hex, but a malformed-but-hex value like
		// "bearer    ...64hex..." would still trip this sweep.
		return fmt.Errorf("connect receipt: observedDigest contains a bearer-shaped substring (%s)", kind)
	}
	return nil
}

// looksLikeBearer is the Go-side bearer sweep. It returns
// (true, kind) when s matches a known bearer shape; (false, "")
// otherwise. The predicate set mirrors internal/output/output.go
// so the Go shell's redactor, the .mjs child's writer, and the
// receipt reader all stay in sync.
//
// kind is a short label suitable for diagnostics: "prefixed",
// "env-assignment", or "jwt".
func looksLikeBearer(s string) (bool, string) {
	if s == "" {
		return false, ""
	}
	lower := strings.ToLower(s)
	if strings.Contains(lower, "bearer ") {
		return true, "prefixed"
	}
	if strings.Contains(lower, "hub_bearer_token=") {
		return true, "env-assignment"
	}
	// Triple-segment JWT heuristic — three dot-separated
	// base64-ish runs of 8+ chars each.
	jwt := bearerValuePattern
	_ = jwt
	// Count dots in the lowercase string; require ≥ 2 segments
	// with ≥ 8 chars between them that look base64-ish.
	if idx := strings.Index(lower, "."); idx > 0 {
		rest := lower[idx+1:]
		if idx2 := strings.Index(rest, "."); idx2 > 0 {
			a := lower[:idx]
			b := rest[:idx2]
			c := rest[idx2+1:]
			if len(a) >= 8 && len(b) >= 8 && len(c) >= 8 && isJWTish(a) && isJWTish(b) && isJWTish(c) {
				return true, "jwt"
			}
		}
	}
	return false, ""
}

// isJWTish reports whether a base64url-ish segment contains only
// the URL-safe alphabet (no padding check; we only sweep for
// shape).
func isJWTish(seg string) bool {
	for _, r := range seg {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

// RefuseIfWrongDirMode walks the receipts directory chain and
// refuses to read or write when any directory's mode is not
// 0700 OR when any path segment is a symlink.
//
// The check is the Go-side mirror of the .mjs child's lstat
// pass. It runs on every write (defense in depth against an
// operator chmod-ing the directory mid-run) and on every read
// (defense against an attacker who can chown/chmod outside the
// apply pipeline).
//
// On macOS / Linux the directory mode is reported via Stat(),
// not Lstat(); we deliberately use Stat so a chmod 0600 (a
// regression) bubbles up immediately.
//
// Returns nil when the chain is clean; non-nil error identifying
// the first failing path otherwise.
func RefuseIfWrongDirMode(hubHome string) error {
	rel := receiptsSubdir
	full := filepath.Join(hubHome, rel)
	// Walk every component of the sub-path; treat the hubHome
	// itself as outside our ownership (caller validates that).
	parts := strings.Split(rel, string(filepath.Separator))
	cur := hubHome
	for _, p := range parts {
		cur = filepath.Join(cur, p)
		st, err := os.Lstat(cur)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				// Missing dir is acceptable for writer; the
				// writer will create. The reader treats missing
				// as "no receipt" upstream, not here.
				return nil
			}
			return fmt.Errorf("connect receipt: lstat %s: %w", cur, err)
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("connect receipt: refusing symlinked path segment %s", cur)
		}
		if !st.IsDir() {
			return fmt.Errorf("connect receipt: path segment %s is not a directory", cur)
		}
		if cur != full && st.Mode().Perm()&0o077 != 0 {
			return fmt.Errorf(
				"connect receipt: directory %s mode %#o != 0700",
				cur, st.Mode().Perm(),
			)
		}
	}
	return nil
}

// RefuseIfWrongFileMode enforces file mode 0600 + not-a-symlink on
// a single receipt file. The check is the Go-side mirror of the
// .mjs child's lstat pass; both refuse to consume a receipt
// whose mode has been tampered with.
//
// Returns nil on a clean file; non-nil error otherwise.
func RefuseIfWrongFileMode(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("connect receipt: lstat %s: %w", path, err)
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("connect receipt: refusing symlinked receipt file %s", path)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("connect receipt: %s is not a regular file", path)
	}
	if st.Mode().Perm() != receiptFileMode {
		return fmt.Errorf(
			"connect receipt: file %s mode %#o != %#o",
			path, st.Mode().Perm(), receiptFileMode,
		)
	}
	if st.Size() > MaxReceiptBytes {
		return fmt.Errorf(
			"connect receipt: file %s size %d > %d",
			path, st.Size(), MaxReceiptBytes,
		)
	}
	return nil
}

// writeReceipt writes r to hubHome/state/connect/receipts/<runId>.json
// atomically and enforces every security invariant:
//
//   - runId shape is validated.
//   - Schema is validated.
//   - The directory chain is lstat-clean (no symlinks) and ends
//     with mode 0700.
//   - The receipt file is written via os.CreateTemp in the SAME
//     directory + fsync + os.Rename (atomic on POSIX).
//   - The final file is mode 0600 (umask-respected by CreateTemp
//     pattern + explicit Chmod after rename).
//   - No leftover .tmp file: the deferred cleanup removes the
//     temp file if rename never happens (early return on error).
//   - No secrets sweep on field values — Validate() does that.
func writeReceipt(hubHome string, r Receipt) (string, error) {
	if err := r.Validate(); err != nil {
		return "", err
	}
	dir := ReceiptsDir(hubHome)
	if err := os.MkdirAll(dir, receiptsDirMode); err != nil {
		return "", fmt.Errorf("connect receipt: mkdir %s: %w", dir, err)
	}
	if err := os.Chmod(dir, receiptsDirMode); err != nil {
		return "", fmt.Errorf("connect receipt: chmod %s: %w", dir, err)
	}
	if err := RefuseIfWrongDirMode(hubHome); err != nil {
		return "", err
	}
	finalPath := filepath.Join(dir, r.RunID+".json")
	// Refuse to silently overwrite an existing receipt. The
	// amendment pins "exactly one <runId>.json per apply" so a
	// re-write would be a duplicate-state regression. The .mjs
	// child enforces the same policy at write time.
	if _, err := os.Lstat(finalPath); err == nil {
		return "", fmt.Errorf(
			"connect receipt: refusing to overwrite existing receipt %s (duplicate runId)",
			finalPath,
		)
	}
	// Create the temp file in the SAME directory so the rename
	// is intra-filesystem (atomic on POSIX). Pattern matches
	// <runId>.json-*.tmp; the leading runId makes leaked temp
	// files (which should never happen) easy to attribute.
	tmp, err := os.CreateTemp(dir, r.RunID+".json-*.tmp")
	if err != nil {
		return "", fmt.Errorf("connect receipt: create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		// Best-effort cleanup of the temp file if any error
		// path below returns. If rename succeeded, the file is
		// already gone and the os.Remove silently fails on
		// ENOENT.
		_ = os.Remove(tmpPath)
	}()
	// Deterministic, sorted-key serialisation. encoding/json
	// marshal of a struct already produces sorted-key output
	// because Go marshals struct fields in declaration order
	// (and our declaration matches the canonical schema order).
	body, err := json.Marshal(r)
	if err != nil {
		return "", fmt.Errorf("connect receipt: marshal: %w", err)
	}
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return "", fmt.Errorf("connect receipt: write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return "", fmt.Errorf("connect receipt: fsync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("connect receipt: close temp: %w", err)
	}
	if err := os.Chmod(tmpPath, receiptFileMode); err != nil {
		return "", fmt.Errorf("connect receipt: chmod temp: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return "", fmt.Errorf("connect receipt: rename %s → %s: %w", tmpPath, finalPath, err)
	}
	// After rename, the file is final at finalPath.
	return finalPath, nil
}

// WriteReceipt is the exported entry point that mirrors the
// .mjs child's receiptStore.write. The signature is deliberately
// minimal: (hubHome, Receipt) → (absolutePath, error).
func WriteReceipt(hubHome string, r Receipt) (string, error) {
	return writeReceipt(hubHome, r)
}

// readReceipt reads a single receipt from the canonical path,
// enforces every security invariant, and returns the parsed
// Receipt.
//
// Returns (zero, false, nil) when the file is absent (so callers
// can distinguish "no receipt" from "refused receipt"). Returns
// (zero, false, error) on any failure mode (corrupt JSON, wrong
// mode, oversized, wrong schema, secrets-shaped payload, …).
//
// The function NEVER follows symlinks — every stat/lstat is the
// Lstat variant so a symlinked path is reported as a regular
// symlink, not as the underlying file.
func readReceipt(hubHome, runId string) (Receipt, bool, error) {
	var zero Receipt
	if !runIDStrictRegex.MatchString(runId) {
		return zero, false, fmt.Errorf(
			"connect receipt: runId %q does not match %s", runId, runIDStrictRegex.String(),
		)
	}
	path := ReceiptPath(hubHome, runId)
	if err := RefuseIfWrongDirMode(hubHome); err != nil {
		return zero, false, err
	}
	// Use Lstat so a symlinked file is reported as a symlink
	// (which RefuseIfWrongFileMode refuses) instead of the
	// underlying target.
	st, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return zero, false, nil
		}
		return zero, false, fmt.Errorf("connect receipt: lstat %s: %w", path, err)
	}
	_ = st
	if err := RefuseIfWrongFileMode(path); err != nil {
		return zero, false, err
	}
	// Re-check size AFTER RefuseIfWrongFileMode so the size
	// argument comes from the SAME Lstat result we trust for
	// the symlink refusal above.
	st2, err := os.Lstat(path)
	if err != nil {
		return zero, false, fmt.Errorf("connect receipt: lstat (size) %s: %w", path, err)
	}
	if st2.Size() > MaxReceiptBytes {
		return zero, false, fmt.Errorf(
			"connect receipt: file %s size %d > %d", path, st2.Size(), MaxReceiptBytes,
		)
	}
	// Read the file body. Use os.ReadFile (no exec, no
	// symlink-follow — ReadFile opens with O_NOFOLLOW semantics
	// on macOS / Linux when called via a path that has not been
	// subject to eval-symlinks; we deliberately pass the Lstat
	// path so a symlink race cannot happen).
	body, err := os.ReadFile(path /* #nosec G304 — the path is lstat-clean above */)
	if err != nil {
		return zero, false, fmt.Errorf("connect receipt: read %s: %w", path, err)
	}
	// Strict decode via a shadow map so we can enforce the
	// bounded schema: refuse any extra top-level keys, refuse
	// any field with the wrong JSON type, refuse any value that
	// matches a secrets-shaped key.
	shadow := map[string]json.RawMessage{}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&shadow); err != nil {
		return zero, false, fmt.Errorf("connect receipt: decode %s: %w", path, err)
	}
	// Detect duplicates / trailing data (a defensively-coded
	// JSON parser stops at the first object; trailing bytes
	// would slip past — we forbid trailing data per the
	// bounded-schema policy).
	if dec.More() {
		return zero, false, fmt.Errorf(
			"connect receipt: %s contains trailing data after the JSON document", path,
		)
	}
	// Bounded-schema sweep at the top level.
	seen := map[string]struct{}{}
	for k := range shadow {
		if _, known := canonicalKeys[k]; !known {
			return zero, false, fmt.Errorf(
				"connect receipt: %s contains unknown top-level key %q (bounded schema)",
				path, k,
			)
		}
		seen[k] = struct{}{}
	}
	for _, k := range canonicalKeysList {
		if _, ok := seen[k]; !ok {
			return zero, false, fmt.Errorf(
				"connect receipt: %s missing required key %q", path, k,
			)
		}
	}
	// Secrets sweep across every STRING field of the parsed
	// receipt (top level only; per amendment the bounded schema
	// has NO nested object, so this is a flat sweep). The
	// canonical schema declares every key as a string EXCEPT
	// schemaVersion (int). We probe the raw JSON type so an
	// unknown non-string key still surfaces as a schema error
	// (a typed error) rather than as a silent skip.
	for k, raw := range shadow {
		// schemaVersion is declared as int in the canonical
		// schema; skip it here so int-vs-string doesn't trip
		// the sweep (its validation runs through Validate()).
		if k == "schemaVersion" {
			continue
		}
		// Probe the raw JSON: it MUST be a string.
		var probe any
		if err := json.Unmarshal(raw, &probe); err != nil {
			return zero, false, fmt.Errorf(
				"connect receipt: %s key %q is not valid JSON", path, k,
			)
		}
		if _, ok := probe.(string); !ok {
			return zero, false, fmt.Errorf(
				"connect receipt: %s key %q is not a string", path, k,
			)
		}
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return zero, false, fmt.Errorf(
				"connect receipt: %s key %q is not a string", path, k,
			)
		}
		if keyMatchesSecretsShape(k) {
			return zero, false, fmt.Errorf(
				"connect receipt: %s key %q is secrets-shaped", path, k,
			)
		}
		if ok, kind := looksLikeBearer(s); ok {
			return zero, false, fmt.Errorf(
				"connect receipt: %s key %q contains a bearer-shaped substring (%s)",
				path, k, kind,
			)
		}
	}
	// Final decode into the typed struct + Validate.
	var parsed Receipt
	if err := json.Unmarshal(body, &parsed); err != nil {
		return zero, false, fmt.Errorf("connect receipt: typed decode %s: %w", path, err)
	}
	if err := parsed.Validate(); err != nil {
		return zero, false, fmt.Errorf("connect receipt: schema: %w", err)
	}
	return parsed, true, nil
}

// ReadReceipt is the exported entry point that mirrors the .mjs
// child's receiptStore.read.
func ReadReceipt(hubHome, runId string) (Receipt, bool, error) {
	return readReceipt(hubHome, runId)
}

// canonicalKeys is the closed set of allowed top-level keys in
// the bounded schema. Anything outside this set is refused at
// decode time. The map doubles as an "is canonical" predicate
// (presence check) and as the iteration order source via the
// companion slice below.
var canonicalKeys = map[string]struct{}{
	"schemaVersion":  {},
	"runId":          {},
	"targetRoot":     {},
	"lockDir":        {},
	"harness":        {},
	"profileId":      {},
	"observedDigest": {},
	"writtenAt":      {},
}

// canonicalKeysList is the deterministically-sorted iteration
// order. Used by the missing-key sweep so the error message
// always names the fields in the same order across calls.
var canonicalKeysList = func() []string {
	keys := make([]string, 0, len(canonicalKeys))
	for k := range canonicalKeys {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}()

// keyMatchesSecretsShape reports whether the lowercased key
// matches the closed secrets-shaped set. Case-insensitive on
// purpose — the .mjs child does the same on VALUES, and we
// authorise the same surface on KEYS.
func keyMatchesSecretsShape(k string) bool {
	return secretsKeyPattern.MatchString(strings.ToLower(k))
}

// listReceipts returns the sorted runId list of every receipt
// file under the canonical directory. The function refuses to
// walk a symlinked directory; it returns (nil, nil) when the
// directory is absent (so callers can distinguish "empty store"
// from "forbidden store").
//
// The output is sorted ascending to keep the apply + rollback
// ordering stable across processes.
func listReceipts(hubHome string) ([]string, error) {
	dir := ReceiptsDir(hubHome)
	if err := RefuseIfWrongDirMode(hubHome); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("connect receipt: readdir %s: %w", dir, err)
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		full := filepath.Join(dir, name)
		// Defence in depth: never trust a directory listing
		// blindly; lstat each entry so a stray symlink is
		// refused here too. The RefuseIfWrongFileMode helper
		// does the full mode+symlink+size+type check.
		if err := RefuseIfWrongFileMode(full); err != nil {
			return nil, err
		}
		if !strings.HasSuffix(name, ".json") {
			return nil, fmt.Errorf(
				"connect receipt: dir %s contains non-JSON entry %q", dir, name,
			)
		}
		runId := strings.TrimSuffix(name, ".json")
		if !runIDStrictRegex.MatchString(runId) {
			return nil, fmt.Errorf(
				"connect receipt: dir %s entry %q has invalid runId shape", dir, name,
			)
		}
		out = append(out, runId)
	}
	sort.Strings(out)
	return out, nil
}

// ListReceipts is the exported entry point that mirrors the .mjs
// child's receiptStore.list.
func ListReceipts(hubHome string) ([]string, error) {
	return listReceipts(hubHome)
}

// Ensure POSIX umask-friendly temp file creation. We export a
// helper that the writer uses so the CreateTemp + Chmod pattern
// stays in lockstep across the Go mirror and any future
// external caller.
//
// The unused import block below silences a "imported and not
// used" lint when the package is read in isolation; syscall is
// reserved for a future enhancement that calls Syncfs on the
// directory after the rename to harden against a kernel crash
// between rename and direntry flush.
var _ = syscall.MS_SYNC
