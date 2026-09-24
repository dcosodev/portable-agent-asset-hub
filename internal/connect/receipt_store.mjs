// internal/connect/receipt_store.mjs
//
// T8 — durable rollback receipt store.
//
// The receipt store is the cross-process rollback bridge for
// `hub hub connect apply|rollback`. It lives entirely as flat
// files under:
//
//   $HUB_HOME/state/connect/receipts/<runId>.json
//
// Per the T8 amendment (docs/roadmap/slices.json §T8) the
// surface is:
//
//   * canonical bounded JSON schema (8 keys; deterministic
//     sort order; sorted-key serialisation)
//   * schemaVersion = 1 (legacy / future versions fail closed)
//   * dir mode 0700; file mode 0600
//   * atomic temp+rename in the SAME directory (no leftover
//     .tmp / .partial files)
//   * no symlinks in any path segment (writer fails closed when
//     the receipts dir or any parent is a symlink)
//   * bounded read/write; secrets-shaped keys refused at any
//     depth of the optional `metadata` envelope and at the
//     top level
//   * runId regex `^run_[A-Za-z0-9._-]+$`; absolute /
//     traversal / NUL runIds refused
//   * file size cap 64 KiB → oversized receipts refused
//   * bearer sweep on every string field
//   * no `Date.now()` stamped by the store — the apply
//     pipeline passes `writtenAt` in, the store only persists
//   * no SQLite, no registry, no in-memory runId map (the
//     directory listing IS the registry; the store never
//     keeps one)
//
// Design contract this file honours:
//
//   * No domain logic. The store does NOT decide WHEN to
//     write a receipt; the apply pipeline decides (and only
//     after `applyPlan` returns `ApplyResult`). The store
//     exposes write/read/list/remove primitives.
//
//   * Fail-closed. Every security check returns a typed
//     Error (instanceof Error) with `code`; callers map
//     codes to exit codes / HTTP semantics. Errors NEVER
//     silently degrade ("refused" is not "skipped").
//
//   * Cross-platform where feasible. macOS APFS and Linux
//     ext4 honour POSIX `rename(2)` atomically when both
//     endpoints share a filesystem. On Windows the surface
//     is reduced (T8 is macOS / Linux only per the broader
//     product shell contract); we never rely on Windows-
//     specific fallbacks.
//
//   * Deterministic serialisation. JSON.stringify with the
//     declared insertion order produces byte-identical
//     output across runs; two writes of the same logical
//     receipt produce the same bytes.

// --------------------------------------------------------------------
// Imports
// --------------------------------------------------------------------

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
  constants as fsConstants,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

// --------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------

/**
 * Canonical bounded-schema version. Older or future versions are
 * refused (the amendment pins versioning as a hard requirement).
 * A v2 surface lands via a future slice amendment, not via silent
 * widening of the existing reader.
 */
export const RECEIPT_SCHEMA_VERSION = 1;

/**
 * File size cap: 64 KiB. Larger receipts are refused so an
 * attacker cannot exhaust the operator's tty by writing a 100 MB
 * "receipt".
 */
export const MAX_RECEIPT_BYTES = 64 * 1024;

/**
 * POSIX mode of the receipts directory.
 */
export const RECEIPTS_DIR_MODE = 0o700;

/**
 * POSIX mode of every receipt file.
 */
export const RECEIPT_FILE_MODE = 0o600;

/**
 * Canonical sub-path under HUB_HOME. The amendment pins this
 * exact location (I-15: receipt under $HUB_HOME/state/connect/
 * receipts/, NEVER inside the user canonical data directory).
 */
const RECEIPTS_SUBDIR = 'state/connect/receipts';

/**
 * Receipt filename suffix. Applied to the validated runId via
 * `<runId>.json`. Extra top-level files (`.tmp`, `.partial`,
 * `.swp`, …) are refused by the reader.
 */
export const RECEIPT_SUFFIX = '.json';

/**
 * Closed set of accepted top-level keys. The amendment pins
 * exactly these eight keys; the reader fails closed on any
 * unknown top-level key and on any missing required key.
 */
const CANONICAL_KEYS = Object.freeze([
  'schemaVersion',
  'runId',
  'targetRoot',
  'lockDir',
  'harness',
  'profileId',
  'observedDigest',
  'writtenAt',
]);

/**
 * Closed set of secrets-shaped key names (top-level + nested
 * under `metadata`). Mirrors the Go-side `secretsKeyPattern`
 * in internal/connect/receipt.go. Drift between the two is a
 * contract regression.
 *
 * The list is intentionally matched case-sensitively for the
 * kebab-case entries (client_secret, api_key, private_key,
 * session_id) and case-insensitively for the camelCase set —
 * production code SHOULD normalize on the camelCase spelling
 * per the canonical schema (no metadata object), but the
 * reader sweeps case-insensitively to catch operator-typed
 * misspellings that an attacker could otherwise lean on.
 */
const SECRETS_KEY_BLOCKLIST = Object.freeze([
  'authorization',
  'bearer',
  'password',
  'token',
  'client_secret',
  'client-secret',
  'apiKey',
  'api_key',
  'api-key',
  'privateKey',
  'private_key',
  'private-key',
  'cookie',
  'sessionId',
  'session_id',
  'session-id',
]);

/**
 * Mirrors internal/connect/regex.go's runIDRegex.
 */
const RUN_ID_REGEX = /^run_[A-Za-z0-9._-]+$/;

/**
 * Mirrors internal/connect/regex.go's profileIDRegex.
 */
const PROFILE_ID_REGEX = /^prf_[A-Za-z0-9._-]+$/;

/**
 * Mirrors internal/connect/regex.go's digestRegex.
 */
const DIGEST_REGEX = /^[0-9a-f]{64}$/;

/**
 * Mirror of internal/output/output.go LooksLikeBearer and
 * internal/connect/receipt.go's bearerValuePattern. Kept in
 * lockstep; a silent drift would let a captured token reach
 * the operator's stderr.
 */
const BEARER_PREFIXED_OPAQUE = /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i;
const HUB_BEARER_ENV_ASSIGNMENT = /\bHUB_BEARER_TOKEN\b\s*=\s*[^\s,'"]+/i;

/**
 * Mirrors the Go-side harness helper; intentionally duplicated
 * here so the .mjs child never has to import from
 * tests/go/connect.
 */

/**
 * Receipt store error class. Callers map `code` to HTTP / exit
 * semantics. The `code` set is closed; new codes are introduced
 * only by an amendment.
 */
export class ReceiptStoreError extends Error {
  /**
   * @param {string} code  - closed-set error code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ReceiptStoreError';
    this.code = code;
  }
}

const ERROR_CODES = Object.freeze({
  INVALID_RUN_ID: 'INVALID_RUN_ID',
  INVALID_PROFILE_ID: 'INVALID_PROFILE_ID',
  INVALID_DIGEST: 'INVALID_DIGEST',
  SCHEMA_VERSION: 'SCHEMA_VERSION',
  MISSING_KEY: 'MISSING_KEY',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  WRONG_TYPE: 'WRONG_TYPE',
  SECRETS_KEY: 'SECRETS_KEY',
  BEARER_VALUE: 'BEARER_VALUE',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  SYMLINK_REFUSED: 'SYMLINK_REFUSED',
  ABSOLUTE_REQUIRED: 'ABSOLUTE_REQUIRED',
  WRONG_DIR_MODE: 'WRONG_DIR_MODE',
  WRONG_FILE_MODE: 'WRONG_FILE_MODE',
  OVERSIZED: 'OVERSIZED',
  IO: 'IO',
  DUPLICATE: 'DUPLICATE',
  CORRUPT_JSON: 'CORRUPT_JSON',
  HARNESS_REFUSED: 'HARNESS_REFUSED',
});

// --------------------------------------------------------------------
// Public surface — pure path helpers
// --------------------------------------------------------------------

/**
 * Compute the canonical receipts directory under hubHome. Pure
 * path computation — does NOT touch the filesystem.
 *
 * @param {string} hubHome
 * @returns {string}
 */
export function receiptsDir(hubHome) {
  if (typeof hubHome !== 'string' || hubHome.length === 0) {
    throw new ReceiptStoreError(ERROR_CODES.IO, `hubHome must be a non-empty string (got ${typeof hubHome})`);
  }
  return join(hubHome, RECEIPTS_SUBDIR);
}

/**
 * Compute the canonical receipt file path for runId under
 * hubHome. Pure path computation — does NOT touch the
 * filesystem. Callers validate the runId shape BEFORE invoking
 * (we re-validate here too, defensively).
 *
 * @param {string} hubHome
 * @param {string} runId
 * @returns {string}
 */
export function receiptPath(hubHome, runId) {
  validateRunId(runId);
  return join(receiptsDir(hubHome), `${runId}${RECEIPT_SUFFIX}`);
}

// --------------------------------------------------------------------
// Public surface — primitives
// --------------------------------------------------------------------

/**
 * Write a receipt atomically.
 *
 * Pipeline:
 *   1. validate `receipt` schema (closed-by-default; bounded keys;
 *      runId / harness / profileId / observedDigest / writtenAt
 *      shape gates).
 *   2. mkdir -p the receipts directory AT mode 0700.
 *   3. lstat the canonical path → refuse to overwrite an
 *      existing receipt (the amendment pins "exactly one
 *      <runId>.json per apply"; a re-write would be a
 *      duplicate-state regression and a future shadow
 *      receipt).
 *   4. refuse when ANY path segment of the receipts directory
 *      chain (under hubHome) is a symlink (defensive against
 *      an attacker who symlinked the receipts directory to
 *      /tmp). The walk stops at hubHome — we never inspect
 *      arbitrary filesystem ancestors.
 *   5. openSync(O_CREAT | O_WRONLY | O_EXCL, 0o600) on a
 *      per-runid .tmp path in the SAME directory.
 *   6. write the body; fsync; close; rename(2) atomic within
 *      the directory. rename of the SAME filesystem is
 *      atomic on POSIX; the test suite locks the "no
 *      leftover .tmp" invariant by listing the directory
 *      post-write.
 *   7. chmod the final file to 0600 (the temp file is
 *      already 0600 from O_EXCL but the rename preserves
 *      the inode's mode; explicit re-chmod is belt-and-
 *      braces for kernel quirks).
 *
 * @param {string} hubHome
 * @param {object} receipt  - bounded-schema receipt
 * @returns {string} absolute path of the written receipt
 */
export function write(hubHome, receipt) {
  if (typeof hubHome !== 'string' || hubHome.length === 0) {
    throw new ReceiptStoreError(ERROR_CODES.IO, 'hubHome must be a non-empty string');
  }
  if (typeof receipt !== 'object' || receipt === null) {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt must be an object');
  }

  // Schema validation first; refuse malformed payloads BEFORE
  // touching the filesystem.
  validateReceipt(receipt);

  const dir = receiptsDir(hubHome);
  const finalPath = receiptPath(hubHome, receipt.runId);

  // The receipts directory is a product-owned path under
  // HUB_HOME. We create it on demand with mode 0700.
  mkdirSync(dir, { recursive: true, mode: RECEIPTS_DIR_MODE });
  // mkdir does not honour mode under some kernels when the
  // directory already exists (or when a stricter umask
  // tightened the inherited mode). Belt-and-braces: re-chmod
  // after creation so the canonical mode is always reflected
  // on disk.
  chmodSafe(dir, RECEIPTS_DIR_MODE);

  // Refuse to walk symlinks at any path segment of the
  // directory chain UNDER hubHome. We refuse BEFORE the
  // open so a maliciously-linked receipts directory cannot
  // redirect the write outside HUB_HOME. The walk stops
  // once we reach hubHome itself — we never inspect
  // arbitrary filesystem ancestors (which on macOS include
  // symlinks like `/var` → `/private/var` that are NOT a
  // security concern).
  refuseIfAnySymlinkInChain(dir, hubHome);

  // Do not silently overwrite an existing receipt. The
  // amendment pins "one runId.json per apply" — a re-write
  // would be a duplicate-state regression.
  if (existsSync(finalPath)) {
    throw new ReceiptStoreError(
      ERROR_CODES.DUPLICATE,
      `refusing to overwrite existing receipt ${finalPath} (duplicate runId)`,
    );
  }

  // Atomic write: temp file in the SAME directory + fsync +
  // rename within filesystem. Pattern matches <runId>.json-
  // <random>.tmp so a leaked temp file (which should never
  // happen) is easy to attribute.
  const tmpName = `${receipt.runId}${RECEIPT_SUFFIX}-${randomHex(8)}.tmp`;
  const tmpPath = join(dir, tmpName);
  let tmpFd;
  try {
    tmpFd = openSync(
      tmpPath,
      fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL,
      RECEIPT_FILE_MODE,
    );
  } catch (err) {
    throw new ReceiptStoreError(
      ERROR_CODES.IO,
      `create temp in ${dir} failed: ${err.message}`,
    );
  }

  try {
    const body = serializeReceipt(receipt);
    writeFileSync(tmpPath, body, { encoding: 'utf8', mode: RECEIPT_FILE_MODE });
    // fsync the data + close the fd.
    fsyncSync(tmpFd);
    closeSync(tmpFd);
    tmpFd = null;
    // Belt-and-braces: explicit chmod in case the kernel
    // applied a group/other bit via inherited umask.
    chmodSafe(tmpPath, RECEIPT_FILE_MODE);
    // Atomic intra-filesystem rename. Both endpoints are
    // in the SAME directory → guaranteed atomic rename(2)
    // on POSIX (macOS APFS / Linux ext4).
    renameSync(tmpPath, finalPath);
    // Re-chmod the final path (some kernels preserve the
    // temp inode's mode; some reset to 0666&~umask).
    chmodSafe(finalPath, RECEIPT_FILE_MODE);
    return finalPath;
  } catch (err) {
    // Re-throw the typed error; the finally block cleans up.
    if (err instanceof ReceiptStoreError) throw err;
    throw new ReceiptStoreError(
      ERROR_CODES.IO,
      `atomic write failed: ${err.message}`,
    );
  } finally {
    if (tmpFd !== null) {
      try { closeSync(tmpFd); } catch { /* best-effort */ }
    }
    // If we still have a temp file (rename didn't happen),
    // best-effort remove it so the directory stays clean.
    if (existsSync(tmpPath)) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
    }
  }
}

/**
 * Read a receipt from the canonical path.
 *
 * Returns `{ ok: true, receipt }` on success.
 *
 * Returns `{ ok: false, code: 'NOT_FOUND' }` when the file
 * is absent (callers can distinguish "no receipt" from
 * "refused receipt").
 *
 * Returns `{ ok: false, code, message }` on any refusal:
 * corrupt JSON, wrong mode, oversized, wrong schema,
 * secrets-shaped, symlinked, etc.
 *
 * @param {string} hubHome
 * @param {string} runId
 * @returns {{ ok: true, receipt: object } | { ok: false, code: string, message: string }}
 */
export function read(hubHome, runId) {
  validateRunId(runId);
  const finalPath = receiptPath(hubHome, runId);

  if (!existsSync(finalPath)) {
    return { ok: false, code: 'NOT_FOUND', message: `no receipt at ${finalPath}` };
  }

  const dir = receiptsDir(hubHome);
  refuseIfAnySymlinkInChain(dir, hubHome);

  // Lstat the file so symlinks are visible (and refused)
  // rather than silently followed.
  const st = lstatSafe(finalPath);
  if (st === null) {
    return { ok: false, code: ERROR_CODES.NOT_FOUND ?? 'NOT_FOUND', message: `lstat ${finalPath} returned null` };
  }
  if (st.isSymbolicLink()) {
    throw new ReceiptStoreError(
      ERROR_CODES.SYMLINK_REFUSED,
      `refusing symlinked receipt file ${finalPath}`,
    );
  }
  if (!st.isFile()) {
    throw new ReceiptStoreError(
      ERROR_CODES.WRONG_FILE_MODE,
      `${finalPath} is not a regular file`,
    );
  }
  // Mode check: must be 0600. NOTE — on some kernels the
  // raw mode comes back as a Number that includes the
  // type bits; we compare via the perm-mask.
  if ((st.mode & 0o777) !== RECEIPT_FILE_MODE) {
    throw new ReceiptStoreError(
      ERROR_CODES.WRONG_FILE_MODE,
      `${finalPath} mode ${(st.mode & 0o777).toString(8)} != ${RECEIPT_FILE_MODE.toString(8)}`,
    );
  }
  if (st.size > MAX_RECEIPT_BYTES) {
    throw new ReceiptStoreError(
      ERROR_CODES.OVERSIZED,
      `${finalPath} size ${st.size} > ${MAX_RECEIPT_BYTES}`,
    );
  }

  const body = readFileSync(finalPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new ReceiptStoreError(
      ERROR_CODES.CORRUPT_JSON,
      `${finalPath}: parse error: ${err.message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReceiptStoreError(
      ERROR_CODES.WRONG_TYPE,
      `${finalPath}: top-level value is not an object`,
    );
  }

  // Bounded-schema sweep at the top level: refuse unknown
  // keys, refuse missing required keys, refuse wrong types.
  validateParsed(parsed, finalPath);

  // Bearer sweep on every string field at the top level.
  sweepBearerValues(parsed, finalPath);

  // Final typed decode → Validate() blows up on the same
  // checks but in the canonical domain (runId regex,
  // harness enum, profileId regex, digest regex, etc).
  validateReceipt(parsed);

  return { ok: true, receipt: parsed };
}

/**
 * List all receipts under the canonical directory, sorted by
 * runId ascending. Returns an empty array when the directory
 * is absent; throws a typed error when the directory chain
 * contains a symlink or any non-JSON entry.
 *
 * The list is the canonical cross-process surface; the .mjs
 * child uses it to validate "every receipt path is bounded"
 * audits in the future. For now the apply + rollback path
 * addresses receipts by runId, not by list.
 *
 * @param {string} hubHome
 * @returns {string[]} sorted runId list
 */
export function list(hubHome) {
  const dir = receiptsDir(hubHome);
  if (!existsSync(dir)) {
    return [];
  }
  refuseIfAnySymlinkInChain(dir, hubHome);
  const entries = readdirSync(dir);
  const out = [];
  for (const name of entries) {
    // Reject hidden files (.tmp, .partial, .swp, …).
    if (name.startsWith('.')) {
      throw new ReceiptStoreError(
        ERROR_CODES.UNKNOWN_KEY,
        `receipts dir ${dir} contains hidden entry ${name}`,
      );
    }
    if (!name.endsWith(RECEIPT_SUFFIX)) {
      throw new ReceiptStoreError(
        ERROR_CODES.UNKNOWN_KEY,
        `receipts dir ${dir} contains non-JSON entry ${name}`,
      );
    }
    const runId = name.slice(0, -RECEIPT_SUFFIX.length);
    try {
      validateRunId(runId);
    } catch (err) {
      throw new ReceiptStoreError(
        ERROR_CODES.INVALID_RUN_ID,
        `receipts dir ${dir} entry ${name} has invalid runId shape: ${err.message}`,
      );
    }
    out.push(runId);
  }
  out.sort();
  return out;
}

/**
 * Consume a receipt: read it once, then delete the canonical
 * file. Used by the rollback verb to mark "this runId has been
 * rolled back" without keeping an in-memory map. The amendment
 * pins that we never delete the receipt inside a happy-path
 * apply; this entry point exists for future consume-scenarios
 * (e.g. an explicit `hub connect consume` operator verb). It
 * is fail-closed: refuses any receipt that fails the same
 * security gates the read path enforces.
 *
 * @param {string} hubHome
 * @param {string} runId
 * @returns {{ ok: true, receipt: object } | { ok: false, code: string, message: string }}
 */
export function consume(hubHome, runId) {
  // Read first, refuse before delete so a corrupt receipt
  // leaves no destructive side-effect.
  const result = read(hubHome, runId);
  if (!result.ok) {
    return result;
  }
  const finalPath = receiptPath(hubHome, runId);
  // Re-validate the path BEFORE the unlink: refuse to unlink
  // a symlink (rmSync on macOS follows symlinks by default for
  // recursive; we use the non-recursive variant here AND lstat
  // the path so the symlink is visible and refused).
  const st = lstatSafe(finalPath);
  if (st !== null && st.isSymbolicLink()) {
    throw new ReceiptStoreError(
      ERROR_CODES.SYMLINK_REFUSED,
      `refusing to consume symlinked receipt ${finalPath}`,
    );
  }
  rmSync(finalPath, { force: false });
  return result;
}

/**
 * Delete a receipt by runId. Use ONLY in tests + future
 * operator-verb consume paths. Production apply never calls
 * this; apply writes, rollback reads but does NOT delete. The
 * entry point is exposed so the receipt store has a closed
 * "remove" surface per the amendment's "
 * receiptStore exposes explicit write/read/delete/consume
 * primitives but does not decide apply timing" mandate.
 *
 * @param {string} hubHome
 * @param {string} runId
 * @returns {boolean} true iff a file was removed
 */
export function remove(hubHome, runId) {
  validateRunId(runId);
  const finalPath = receiptPath(hubHome, runId);
  const st = lstatSafe(finalPath);
  if (st === null) {
    return false;
  }
  if (st.isSymbolicLink()) {
    throw new ReceiptStoreError(
      ERROR_CODES.SYMLINK_REFUSED,
      `refusing to remove symlinked receipt ${finalPath}`,
    );
  }
  if (!st.isFile()) {
    throw new ReceiptStoreError(
      ERROR_CODES.WRONG_FILE_MODE,
      `${finalPath} is not a regular file`,
    );
  }
  rmSync(finalPath, { force: false });
  return true;
}

// --------------------------------------------------------------------
// Validation surface
// --------------------------------------------------------------------

/**
 * Pure validator: throws on any deviation from the bounded
 * schema. Exposed so the apply pipeline can sweep a receipt
 * BEFORE writing (defense in depth — the writer also calls
 * this).
 *
 * @param {object} receipt
 */
export function validate(receipt) {
  return validateReceipt(receipt);
}

function validateReceipt(receipt) {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt must be a plain object');
  }
  // Bounded top-level keys. ANY unknown key fails closed.
  for (const k of Object.keys(receipt)) {
    if (!CANONICAL_KEYS.includes(k)) {
      throw new ReceiptStoreError(
        ERROR_CODES.UNKNOWN_KEY,
        `receipt contains unknown top-level key "${k}" (bounded schema)`,
      );
    }
    // Secrets-shaped keys fail closed.
    if (SECRETS_KEY_BLOCKLIST.includes(k) || SECRETS_KEY_BLOCKLIST.includes(k.toLowerCase())) {
      throw new ReceiptStoreError(
        ERROR_CODES.SECRETS_KEY,
        `receipt contains secrets-shaped key "${k}"`,
      );
    }
  }
  // All required keys must be present.
  for (const k of CANONICAL_KEYS) {
    if (!(k in receipt)) {
      throw new ReceiptStoreError(ERROR_CODES.MISSING_KEY, `receipt missing required key "${k}"`);
    }
  }
  // Per-field shape gates.
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new ReceiptStoreError(
      ERROR_CODES.SCHEMA_VERSION,
      `receipt.schemaVersion=${receipt.schemaVersion} != ${RECEIPT_SCHEMA_VERSION}`,
    );
  }
  validateRunId(receipt.runId);
  if (typeof receipt.targetRoot !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt.targetRoot must be a string');
  }
  if (!isAbsolute(receipt.targetRoot)) {
    throw new ReceiptStoreError(ERROR_CODES.ABSOLUTE_REQUIRED, `receipt.targetRoot "${receipt.targetRoot}" is not absolute`);
  }
  if (typeof receipt.lockDir !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt.lockDir must be a string');
  }
  if (!isAbsolute(receipt.lockDir)) {
    throw new ReceiptStoreError(ERROR_CODES.ABSOLUTE_REQUIRED, `receipt.lockDir "${receipt.lockDir}" is not absolute`);
  }
  // Harness: closed enumeration. The amendment authorises
  // "hermes" today; "openclaw" is parser-accepted but
  // apply+rollback close on "openclaw" at this layer.
  if (typeof receipt.harness !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt.harness must be a string');
  }
  if (receipt.harness !== 'hermes') {
    throw new ReceiptStoreError(ERROR_CODES.HARNESS_REFUSED, `receipt.harness "${receipt.harness}" is not recognised (expected hermes)`);
  }
  if (typeof receipt.profileId !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt.profileId must be a string');
  }
  if (!PROFILE_ID_REGEX.test(receipt.profileId)) {
    throw new ReceiptStoreError(
      ERROR_CODES.INVALID_PROFILE_ID,
      `receipt.profileId "${receipt.profileId}" does not match ${PROFILE_ID_REGEX.source}`,
    );
  }
  if (typeof receipt.observedDigest !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt.observedDigest must be a string');
  }
  if (!DIGEST_REGEX.test(receipt.observedDigest)) {
    throw new ReceiptStoreError(
      ERROR_CODES.INVALID_DIGEST,
      `receipt.observedDigest must be exactly 64 lowercase hex characters`,
    );
  }
  if (typeof receipt.writtenAt !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.WRONG_TYPE, 'receipt.writtenAt must be a string');
  }
  if (receipt.writtenAt.length === 0) {
    throw new ReceiptStoreError(ERROR_CODES.MISSING_KEY, 'receipt.writtenAt must be a non-empty string');
  }
  // Bearer sweep on every string field — defense in depth
  // even though the keys are constrained.
  for (const k of CANONICAL_KEYS) {
    const v = receipt[k];
    if (typeof v === 'string' && looksLikeBearer(v)) {
      throw new ReceiptStoreError(
        ERROR_CODES.BEARER_VALUE,
        `receipt.${k} contains a bearer-shaped substring`,
      );
    }
  }
}

function validateRunId(runId) {
  if (typeof runId !== 'string') {
    throw new ReceiptStoreError(ERROR_CODES.INVALID_RUN_ID, `runId must be a string (got ${typeof runId})`);
  }
  if (runId.length === 0) {
    throw new ReceiptStoreError(ERROR_CODES.INVALID_RUN_ID, 'runId must be a non-empty string');
  }
  // Refuse NUL bytes + control characters before the regex.
  if ([...runId].some((character) => character.charCodeAt(0) <= 0x1f)) {
    throw new ReceiptStoreError(ERROR_CODES.INVALID_RUN_ID, `runId "${runId}" contains control characters`);
  }
  if (runId.includes('..')) {
    throw new ReceiptStoreError(ERROR_CODES.PATH_TRAVERSAL, `runId "${runId}" contains ".."`);
  }
  if (runId.includes('/') || runId.includes('\\')) {
    throw new ReceiptStoreError(ERROR_CODES.PATH_TRAVERSAL, `runId "${runId}" contains a path separator`);
  }
  if (!RUN_ID_REGEX.test(runId)) {
    throw new ReceiptStoreError(
      ERROR_CODES.INVALID_RUN_ID,
      `runId "${runId}" does not match ${RUN_ID_REGEX.source}`,
    );
  }
}

function validateParsed(parsed, finalPath) {
  // Bounded top-level keys.
  const seen = new Set();
  for (const k of Object.keys(parsed)) {
    seen.add(k);
    if (!CANONICAL_KEYS.includes(k)) {
      throw new ReceiptStoreError(
        ERROR_CODES.UNKNOWN_KEY,
        `${finalPath}: unknown top-level key "${k}"`,
      );
    }
  }
  for (const k of CANONICAL_KEYS) {
    if (!seen.has(k)) {
      throw new ReceiptStoreError(
        ERROR_CODES.MISSING_KEY,
        `${finalPath}: missing required key "${k}"`,
      );
    }
  }
}

function sweepBearerValues(obj, finalPath) {
  for (const k of CANONICAL_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && looksLikeBearer(v)) {
      throw new ReceiptStoreError(
        ERROR_CODES.BEARER_VALUE,
        `${finalPath}: key "${k}" contains a bearer-shaped substring`,
      );
    }
  }
}

/**
 * Look-alike bearer predicate (mirrors internal/output/output.go
 * LooksLikeBearer + internal/connect/receipt.go's
 * bearerValuePattern). Returns true when s matches a bearer-shape.
 *
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeBearer(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (BEARER_PREFIXED_OPAQUE.test(s)) return true;
  if (HUB_BEARER_ENV_ASSIGNMENT.test(s)) return true;
  if (looksLikeJwt(s)) return true;
  return false;
}

function looksLikeJwt(s) {
  // Three dot-separated base64url segments of ≥ 8 chars each.
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length >= 8 && /^[A-Za-z0-9_-]+$/.test(p));
}

// --------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------

/**
 * Symlink-traversal refusal: walk every component of `path`
 * under `hubHome` and throw if any segment is a symlink.
 * The walk stops AT hubHome — we never inspect arbitrary
 * filesystem ancestors (which on macOS include symlinks like
 * `/var` → `/private/var` that are NOT a security concern).
 *
 * The receipt store never follows symlinks within the
 * product-owned path chain. We refuse at write time AND at
 * read time so a hostile symlink race cannot redirect the
 * operation outside HUB_HOME.
 *
 * Algorithm:
 *   1. lstat the canonical `path` (e.g.
 *      `<hubHome>/state/connect/receipts`).
 *   2. lstat each parent moving up the chain.
 *   3. Refuse if any segment in the chain (up to AND
 *      INCLUDING the receipts directory itself) is a
 *      symlink.
 *   4. Stop walking once we reach `hubHome`. We do NOT
 *      validate hubHome itself (the operator / runner owns
 *      that path; the receipt store doesn't claim it).
 *
 * @param {string} path    canonical product path (e.g. receipts dir)
 * @param {string} hubHome boundary — walk stops here
 */
function refuseIfAnySymlinkInChain(path, hubHome) {
  // Resolve the hubHome boundary to its absolute form so
  // string comparisons are robust against trailing
  // separators. node:path's `dirname` strips the trailing
  // separator, but we also defensively normalise.
  const boundary = hubHome.replace(/\/+$/u, '');
  let cur = path;
  // Walk up the path chain. Each iteration lstat's `cur`;
  // if it's a symlink, refuse. Then move one level up,
  // but stop AS SOON AS we cross back through hubHome.
  while (true) {
    const st = lstatSafe(cur);
    if (st === null) {
      // Segment doesn't exist; the calling code (mkdirSync
      // recursive + refuse-after) handles this. Stop walking.
      return;
    }
    if (st.isSymbolicLink()) {
      throw new ReceiptStoreError(
        ERROR_CODES.SYMLINK_REFUSED,
        `refusing symlinked path segment ${cur}`,
      );
    }
    // Stop walking once we are about to leave hubHome.
    if (cur === boundary) {
      return;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      // Reached the filesystem root without crossing
      // hubHome — the HUB_HOME path is bogus (operator
      // configured a nonexistent hubHome). Refuse so the
      // caller surfaces the misconfiguration.
      throw new ReceiptStoreError(
        ERROR_CODES.IO,
        `refuseIfAnySymlinkInChain: walked past hubHome=${hubHome} without stopping; check HUB_HOME`,
      );
    }
    cur = parent;
  }
}

/**
 * Lstat with a swallowed error → null. Used when "missing"
 * is not a hard failure (we let the caller disambiguate via
 * the result).
 *
 * @param {string} path
 * @returns {import('node:fs').Stats | null}
 */
function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Best-effort chmod. Used for the "re-chmod" belt-and-braces
 * after mkdir/createTemp/rename because some kernels reset
 * the inode mode to `0666 & ~umask` after a rename within
 * the same directory.
 *
 * @param {string} path
 * @param {number} mode
 */
function chmodSafe(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // ignore — best-effort
  }
}

/**
 * Serialize a receipt with the canonical key order. The
 * serializer is purely deterministic at the key-order level
 * (the bounded schema has fixed fields in fixed order).
 *
 * @param {object} receipt
 * @returns {string} JSON body
 */
function serializeReceipt(receipt) {
  // Re-emit in canonical order so two writes of the same
  // logical receipt produce byte-identical output. JSON.parse
  // does not preserve insertion order, so we can't just
  // JSON.stringify the input directly.
  const ordered = {};
  for (const k of CANONICAL_KEYS) {
    ordered[k] = receipt[k];
  }
  return JSON.stringify(ordered);
}

/**
 * Cryptographically-strong hex string of `nbytes` bytes.
 * Used to name the per-write .tmp file so leftover temp
 * files (which should never happen) are easy to attribute.
 *
 * @param {number} nbytes
 * @returns {string}
 */
function randomHex(nbytes) {
  return randomBytes(nbytes).toString('hex');
}

// --------------------------------------------------------------------
// Default export: the closed surface the apply + rollback path uses
// --------------------------------------------------------------------

export const receiptStore = Object.freeze({
  receiptsDir,
  receiptPath,
  validate,
  write,
  read,
  list,
  remove,
  consume,
  looksLikeBearer,
  RECEIPT_SCHEMA_VERSION,
  RECEIPTS_DIR_MODE,
  RECEIPT_FILE_MODE,
  MAX_RECEIPT_BYTES,
  RECEIPT_SUFFIX,
  ReceiptStoreError,
});

export default receiptStore;
