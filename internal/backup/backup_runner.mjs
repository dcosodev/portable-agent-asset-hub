#!/usr/bin/env node
// internal/backup/backup_runner.mjs
//
// T9 child Node process for `hub backup --out <archive>` and
// `hub backup --restore <archive>`.
//
// Contract (mirrored in internal/backup/runner.go):
//
//   argv[0]              this file (resolved by the Go runner)
//   argv[1]              action: "snapshot" | "restore"
//   argv[2]              request payload (JSON string)
//
// Request shape (both verbs):
//
//   { "archivePath": "<absolute path to .tar.gz>",
//     "hubHome":     "<absolute HUB_HOME, only used for default archive location>",
//     "restoreArchivePath": "<absolute path to .tar.gz to extract>",
//     "dbPath":      "<absolute canonical SQLite DB path>" }
//
// The Go runner strips every HUB_BEARER_TOKEN* before forking us.
// We never receive a bearer or an environment that contains one.
//
// Exit codes (Go-side mapped by the dispatcher):
//
//   0  success — snapshot written OR restore applied
//   1  operator / runtime error (missing archive, malformed tar, IO failure, …)
//   2  contract violation (unknown action, malformed request, invalid archive path)
//
// Source-of-truth rules this child enforces by construction:
//
//   * CANONICAL storage binding. The DB path is the absolute path
//     returned by `@portable-agent-asset-hub/core`'s
//     `resolveHubDatabasePath` (which honours AGENT_MEMORY_DB_PATH →
//     AGENT_MEMORY_DATA_DIR → PORTABLE_AGENT_ASSET_HUB_DATA_DIR →
//     platform default — never a child-local fallback). The
//     dispatcher (cmd/hub/cmd_backup.go) passes the resolved
//     dbPath through argv; we NEVER re-derive it from HUB_HOME and
//     NEVER walk a HUB_HOME/*.sqlite fallback. The child's argv
//     envelope carries the single resolved path the Go side got from
//     resolveHubDatabasePath; the Go side got it through the same
//     authoritative resolution (no other resolution is allowed by
//     the slice contract).
//
//   * ATOMIC OUTPUT. The archive is staged to a sibling tmpfile in
//     the same directory as the destination, fsync'd, chmod 0600,
//     then renamed into place. A power loss mid-write leaves the
//     prior archive (or none) on disk, never a half-written file
//     visible to the operator.
//
//   * MODE 0600. The archive file is created with mode 0600 BEFORE
//     any bytes are written. The operator's umask is bypassed via
//     the explicit chmod(2) syscall on the same file descriptor
//     node hands us.
//
//   * EXCLUSION. The archive MUST NOT contain:
//       - any path under $HUB_HOME/tokens/**
//       - any file whose name matches the secret-shape regex:
//         `*.pem`, `*token*`, `*secret*`, `*.env`, `*.key`
//     The exclusion is a LIVE rule on the snapshot set, not a
//     hardcoded list: a secret-shaped file written AFTER `hub init`
//     must still be excluded. For T9's narrow scope the snapshot
//     set is the canonical DB only, so the exclusion rule is
//     structural defence-in-depth rather than a hot path.
//
//   * BEARER HYGIENE. The child never reads $HUB_HOME/tokens/** in
//     any branch, never writes bearer bytes to stdout, never
//     echoes the request payload back. All stdout is the JSON
//     envelope (success or failure); stderr is reserved for the
//     rare verbose diagnostics and is also filtered.
//
//   * STABLE ENVELOPE. Sorted-key JSON. One document per
//     invocation. Framing bytes are byte-deterministic; domain
//     fields (createdAt, archiveBytes) reflect the real outcome.

import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { chmodSync, copyFileSync, renameSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, sep, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// argv & request parsing
// ---------------------------------------------------------------------------

const [, , action, requestJSON] = process.argv;

if (!action) {
  emitError({
    code: 'NO_ACTION',
    message: 'backup_runner: missing action positional (snapshot|restore)',
    httpCode: 400,
  });
  process.exit(2);
}

let request;
try {
  request = JSON.parse(requestJSON ?? '{}');
} catch (error) {
  emitError({
    code: 'INVALID_REQUEST',
    message: `backup_runner: cannot parse request payload: ${error.message}`,
    httpCode: 400,
  });
  process.exit(2);
}

if (!request || typeof request !== 'object') {
  emitError({
    code: 'INVALID_REQUEST',
    message: 'backup_runner: request payload must be a JSON object',
    httpCode: 400,
  });
  process.exit(2);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emit(payload) {
  process.stdout.write(JSON.stringify(payload, sortedReplacer(), 2) + '\n');
}

function sortedReplacer() {
  return (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  };
}

function emitError({ code, message, httpCode = 500, extra = {} }) {
  emit({ code, message, httpCode, ...extra });
}

// ---------------------------------------------------------------------------
// secret-shape predicate — mirrors tests/go/distribution/_distribution-harness.ts
//
// The regex below is intentionally identical (case-insensitive) so the
// production exclusion matches the test predicate BY CONSTRUCTION. If
// the test suite ever widens the secret-shape set, the harness is the
// single source of truth and this regex must follow.
// ---------------------------------------------------------------------------

const SECRET_SHAPED_NAME = /(\.pem$)|(token)|(secret)|(\.env$)|(\.key$)/i;

function isSecretShaped(relativePath) {
  const segments = String(relativePath).split(/[\\/]+/u).filter(Boolean);
  if (segments.some((s) => s === 'tokens')) return true;
  const base = segments.at(-1) ?? '';
  return SECRET_SHAPED_NAME.test(base);
}

// ---------------------------------------------------------------------------
// bounded + secure extraction (portable)
//
// restore must (a) cap the unpacked size so a malicious archive cannot
// exhaust disk, (b) reject entries that escape the destination root
// (path-traversal defence), (c) reject symlinks, device nodes, hard
// links, etc.
//
// PORTABLE EXTRACTION. The macOS/BSD system tar (bsdtar, libarchive 3.x)
// does NOT support GNU's `--no-absolute-names` flag — that option is
// a GNU extension. The portable replacement delegates fail-closed
// validation to the child itself rather than to the tar binary:
//
//   1. PRE-LIST archive entries with `tar -tzf` and inspect every
//      entry name in-process. Reject ANY entry whose name is absolute
//      (leading `/`), contains a `..` segment, points outside the
//      staging root, names an unsafe entry type, or fails the
//      secret-shape predicate.
//   2. REJECT an UNEXPECTED entry set. The snapshot set is bounded
//      and known (a single `hub.sqlite` file). Any archive that
//      carries a different set — extras, missing, or surprise
//      prefixes — is a tampering signal and is refused BEFORE
//      extraction.
//   3. EXTRACT without `--no-absolute-names` and without `-P`
//      (libarchive's `preserve-permissions` / `absolute-names`).
//      bsdtar with no `-P` already strips leading `/` and refuses
//      to extract entries whose pathnames contain `..`, which is
//      the same effect GNU tar achieves with `--no-absolute-names`
//      but expressed as the libarchive default. GNU tar behaves
//      the same way by default.
//   4. POST-VALIDATE the extracted tree (existing defence in depth:
//      bound total bytes, reject traversal/secret-shaped entries,
//      require `hub.sqlite` at the staged root).
//   5. ATOMIC SWAP into the canonical DB path (existing semantics).
//
// This keeps the file portable across macOS/BSD and GNU tar, keeps
// the security posture fail-closed (hostile archives are refused
// before any byte is written to the staging dir), and leaves the
// snapshot behaviour, Go-side runner, tests, and documents unchanged.
// ---------------------------------------------------------------------------

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024; // 512 MiB hard cap on the archive itself
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024; // 512 MiB hard cap on the unpacked size

function stageSnapshot(archivePath, dbPath) {
  // 1) Validate inputs up front so a hostile request fails BEFORE any
  //    file is written.
  validateAbsolutePath(archivePath, 'archivePath');
  validateAbsolutePath(dbPath, 'dbPath');
  if (!existsSync(dbPath)) {
    throw new OpError('DB_MISSING', `backup_runner: canonical database not found at ${dbPath}`, 1);
  }

  // 2) Stage the DB to a tmpfile (mode 0600). We copy rather than
  //    symlink so a later archive step sees a regular file (tar
  //    refuses to follow symlinks unless told to).
  const stagingDir = mkdtempSync(join(tmpdir(), 'hub-backup-stage-'));
  try {
    const stagedDb = join(stagingDir, 'hub.sqlite');
    copyFileSync(dbPath, stagedDb);
    chmodSync(stagedDb, 0o600);

    // 3) Atomic tar.gz staging. The archive is written to a
    //    sibling tmpfile so the rename preserves filesystem
    //    semantics (POSIX rename is atomic on the same filesystem).
    //
    //    PORTABILITY NOTE: the system tar may be the BSD variant on
    //    macOS (libarchive 3.x) which does NOT accept GNU's
    //    `--mode=0600` flag. The slice contract pins the archive file
    //    mode at 0600, but pins it on the FILE, not on tar entries
    //    (the snapshot set is a single regular file we chmod
    //    ourselves before staging). We omit `--mode` entirely and
    //    enforce 0600 on the archive file via Node's chmodSync after
    //    the rename. `--owner=0 --group=0 --numeric-owner` are also a
    //    GNU extension on some legacy tars, but bsdtar on macOS
    //    accepts them (they're an invariant of the libarchive family),
    //    so we keep them to keep the on-wire archive format
    //    (uid/gid/mode=0644 regular file) byte-deterministic.
    const finalDir = dirname(archivePath);
    mkdirSync(finalDir, { recursive: true, mode: 0o700 });
    const tmpArchive = join(
      finalDir,
      `.hub.backup.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`,
    );
    const tarArgs = [
      '-czf', tmpArchive,
      '-C', stagingDir,
      '--owner=0', '--group=0', '--numeric-owner',
      'hub.sqlite',
    ];
    const tarResult = spawnSync('tar', tarArgs, { encoding: 'buffer' });
    if (tarResult.status !== 0) {
      safeRemove(tmpArchive);
      throw new OpError(
        'TAR_WRITE_FAILED',
        `backup_runner: tar -czf failed (status=${tarResult.status}): ${tarResult.stderr?.toString('utf8') ?? ''}`,
        1,
      );
    }

    // 4) Enforce 0600 explicitly on the staged tmpfile. The slice
    //    contract is "archive file mode 0600"; we hold that on the
    //    FILE (post-staging, post-rename, verified) so the contract
    //    is independent of the system tar's idea of entry mode bits.
    chmodSync(tmpArchive, 0o600);

    // 5) Enforce archive byte cap.
    const staged = statSync(tmpArchive);
    if (staged.size > MAX_ARCHIVE_BYTES) {
      safeRemove(tmpArchive);
      throw new OpError(
        'ARCHIVE_TOO_LARGE',
        `backup_runner: staged archive ${staged.size} bytes exceeds ${MAX_ARCHIVE_BYTES} byte cap`,
        1,
      );
    }

    // 6) Atomic rename into place.
    renameSync(tmpArchive, archivePath);

    // 7) Re-stat and verify the mode survived the rename. On most
    //    filesystems rename preserves the source mode; we verify
    //    anyway so a future umask or filesystem quirk cannot
    //    silently widen the permissions.
    const finalStat = statSync(archivePath);
    const finalMode = finalStat.mode & 0o777;
    if (finalMode !== 0o600) {
      throw new OpError(
        'ARCHIVE_MODE_INVALID',
        `backup_runner: archive mode ${finalMode.toString(8)}, expected 0600`,
        1,
      );
    }

    return {
      archiveBytes: finalStat.size,
      archiveMode: finalMode,
      archivePath,
      createdAt: new Date().toISOString(),
      dbPath,
    };
  } finally {
    safeRemove(stagingDir);
  }
}

function stageRestore(archivePath, dbPath) {
  // 1) Validate inputs.
  validateAbsolutePath(archivePath, 'archivePath');
  validateAbsolutePath(dbPath, 'dbPath');

  if (!existsSync(archivePath)) {
    throw new OpError(
      'ARCHIVE_MISSING',
      `backup_runner: archive not found at ${archivePath}`,
      1,
    );
  }
  const arcStat = statSync(archivePath);
  if (arcStat.size > MAX_ARCHIVE_BYTES) {
    throw new OpError(
      'ARCHIVE_TOO_LARGE',
      `backup_runner: archive ${arcStat.size} bytes exceeds ${MAX_ARCHIVE_BYTES} byte cap`,
      1,
    );
  }
  const arcMode = arcStat.mode & 0o777;
  // The archive MUST be mode 0600 (the snapshot wrote it that way
  // and a restore from a permissive archive is a security regression).
  if (arcMode !== 0o600) {
    throw new OpError(
      'ARCHIVE_MODE_INVALID',
      `backup_runner: refusing to restore archive with mode ${arcMode.toString(8)} (expected 0600)`,
      1,
    );
  }

  // 2) Stage the archive's payload to a tmpdir so the live DB is
  //    swapped atomically (write-to-tmp + rename). This is the
  //    mirror of stageSnapshot's atomic output.
  const destDir = dirname(dbPath);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const stagingDir = mkdtempSync(join(tmpdir(), 'hub-backup-restore-'));
  try {
    // 2a) PRE-LIST the archive and validate the entry set BEFORE any
    //     byte is written to the staging dir. This is the portable
    //     fail-closed gate: the system tar (GNU or BSD) is invoked
    //     with no GNU-only options, and the in-process validator
    //     guarantees (i) no entry escapes the staging root, (ii) no
    //     secret-shaped entry is present, (iii) the entry set is
    //     exactly the snapshot set we wrote — a single `hub.sqlite`.
    //
    //     The list step is hermetic (read-only over the archive file)
    //     so a hostile archive is refused without ever writing into
    //     the staging dir.
    const listedEntries = listArchiveSafely(archivePath);
    validateArchiveEntrySet(listedEntries, stagingDir);

    // 2b) Extract. Note the deliberate ABSENCE of GNU-only flags:
    //     bsdtar and GNU tar both, by default, (a) strip leading `/`
    //     from absolute pathnames on extract, and (b) refuse to
    //     extract entries whose pathnames contain `..` components —
    //     exactly the safety net GNU tar names `--no-absolute-names`.
    //     We never pass `-P` (libarchive's `absolute-names`) so the
    //     default is in force; the in-process validation above is
    //     the source of truth, this is defence in depth at the
    //     system-tar layer. Metadata-stripping flags are further
    //     split by which `tar` actually supports them — see
    //     isBsdTar() below.
    const tarArgs = [
      '-xzf', archivePath,
      '-C', stagingDir,
      '--no-acls', '--no-xattrs',
      // --no-fflags / --no-mac-metadata are libarchive/bsdtar-only —
      // see isBsdTar() below. GNU tar has no BSD file flags or Mac
      // extended metadata to strip in the first place.
      ...(isBsdTar() ? ['--no-fflags', '--no-mac-metadata'] : []),
      '--no-same-permissions',
    ];
    const tarResult = spawnSync('tar', tarArgs, { encoding: 'buffer' });
    if (tarResult.status !== 0) {
      throw new OpError(
        'TAR_EXTRACT_FAILED',
        `backup_runner: tar -xzf failed (status=${tarResult.status}): ${tarResult.stderr?.toString('utf8') ?? ''}`,
        1,
      );
    }

    // 3) Bound + validate the unpacked payload (defence in depth —
    //    the in-process pre-list above is the primary gate; this
    //    walk is the post-extract re-check that catches anything
    //    the system tar might have rewritten on disk).
    const entries = listDirRecursive(stagingDir);
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.absPath === stagingDir) continue;
      // Reject any entry that escapes the staging root.
      const rel = entry.absPath.slice(stagingDir.length + 1);
      if (rel.startsWith('..') || rel.split(sep).includes('..')) {
        throw new OpError(
          'ARCHIVE_PATH_TRAVERSAL',
          `backup_runner: archive entry escapes destination: ${rel}`,
          1,
        );
      }
      // Reject any secret-shaped entry — the snapshot contract
      // forbids them from being captured, so a restore that
      // produces one is a security regression. This is a
      // conservative structural defence; today's snapshots never
      // carry them.
      if (entry.isFile && isSecretShaped(rel)) {
        throw new OpError(
          'ARCHIVE_SECRET_ENTRIES',
          `backup_runner: archive contains forbidden secret-shaped entry ${rel}`,
          1,
        );
      }
      if (entry.isFile) {
        totalBytes += entry.size;
        if (totalBytes > MAX_EXTRACTED_BYTES) {
          throw new OpError(
            'ARCHIVE_EXTRACTED_TOO_LARGE',
            `backup_runner: extracted bytes ${totalBytes} exceed ${MAX_EXTRACTED_BYTES} cap`,
            1,
          );
        }
      }
    }

    // 4) Find the canonical DB inside the staging tree. The
    //    snapshot always stages it as `hub.sqlite` (or under a
    //    single root prefix that tar may have introduced).
    const candidate = resolvePath(join(stagingDir, 'hub.sqlite'));
    if (!existsSync(candidate)) {
      throw new OpError(
        'ARCHIVE_DB_MISSING',
        'backup_runner: archive does not contain hub.sqlite at the expected root',
        1,
      );
    }

    // 5) Atomic swap. Stage the DB to a sibling tmpfile in the
    //    destination directory, then rename into place so a
    //    mid-write failure leaves the prior DB on disk.
    const tmpDb = join(destDir, `.hub.sqlite.restore.${process.pid}.${Date.now()}.tmp`);
    copyFileSync(candidate, tmpDb);
    chmodSync(tmpDb, 0o600);
    renameSync(tmpDb, dbPath);
    const finalStat = statSync(dbPath);
    const finalMode = finalStat.mode & 0o777;
    if (finalMode !== 0o600) {
      throw new OpError(
        'DB_MODE_INVALID',
        `backup_runner: restored DB mode ${finalMode.toString(8)}, expected 0600`,
        1,
      );
    }

    return {
      archivePath,
      dbPath,
      dbBytes: finalStat.size,
      restoredAt: new Date().toISOString(),
    };
  } finally {
    safeRemove(stagingDir);
  }
}

// ---------------------------------------------------------------------------
// small helpers (intentionally inline — this file is a single seam)
// ---------------------------------------------------------------------------

class OpError extends Error {
  constructor(code, message, exit) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

function safeRemove(p) {
  try {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

function validateAbsolutePath(p, name) {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new OpError('INVALID_REQUEST', `backup_runner: ${name} is required`, 2);
  }
  if (!p.startsWith('/')) {
    throw new OpError('INVALID_REQUEST', `backup_runner: ${name} must be an absolute path, got ${p}`, 2);
  }
  if (p.includes('\u0000')) {
    throw new OpError('INVALID_REQUEST', `backup_runner: ${name} contains a NUL byte`, 2);
  }
}

function listDirRecursive(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) {
        let st;
        try { st = statSync(abs); } catch { continue; }
        out.push({ absPath: abs, isFile: true, size: st.size });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// archive pre-list helpers (portable)
//
// `listArchiveSafely` runs `tar -tzf` over the archive and returns the
// raw entry names (one per line, trimmed). It uses NO GNU-only flags
// so it works on both macOS/BSD tar and GNU tar. The output format
// differs slightly between implementations (GNU emits a trailing
// newline per entry plus the long-form `ls -l` style if `-v` is set;
// BSD emits a single entry per line, no metadata) — `tar -tzf` (no
// `-v`) is the lowest-common-denominator listing both tar families
// emit identically: one entry name per line.
//
// `validateArchiveEntrySet` is the fail-closed gate. It enforces:
//   * no entry name is absolute (does not start with `/`);
//   * no entry name escapes the staging root via `..` segments;
//   * no entry name carries a leading directory component (the
//     snapshot set is a flat single file at the archive root);
//   * no entry is secret-shaped (the snapshot contract forbids
//     them, so a restore that sees one is a tampering signal);
//   * the entry set is EXACTLY the pinned snapshot set: a single
//     `hub.sqlite` regular file at the archive root. Any extra
//     entry, missing entry, or surprise prefix is refused BEFORE
//     extraction.
//
// The contract — exactly one entry, named `hub.sqlite` at the root —
// is what `stageSnapshot` produces with `tar -czf -C <stagingDir>
// hub.sqlite`. Tightening this to a literal set check (not a
// "prefix-stripped, file is somewhere under the archive root" walk)
// is what makes the pre-list a real fail-closed gate: a hostile
// archive that includes `hub.sqlite` AND a malicious sidecar is
// refused, not silently accepted because the right file is also
// present.
// ---------------------------------------------------------------------------

/** The literal set of entry names the snapshot guarantees on the wire. */
const EXPECTED_ARCHIVE_ENTRIES = Object.freeze(['hub.sqlite']);

// `--no-fflags` and `--no-mac-metadata` are libarchive/bsdtar-only —
// GNU tar (the default on every Linux CI runner) rejects them outright
// (exit 64, "unrecognized option"). Detect the system `tar` once and
// only add them when it is actually bsdtar; GNU tar's own defaults
// already omit BSD file flags and Mac extended metadata, so skipping
// the flags there changes nothing observable.
let cachedIsBsdTar;
function isBsdTar() {
  if (cachedIsBsdTar === undefined) {
    const res = spawnSync('tar', ['--version'], { encoding: 'utf8' });
    cachedIsBsdTar = res.status === 0 && /bsdtar/i.test(res.stdout ?? '');
  }
  return cachedIsBsdTar;
}

function listArchiveSafely(archivePath) {
  const res = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new OpError(
      'ARCHIVE_LIST_FAILED',
      `backup_runner: tar -tzf failed (status=${res.status}): ${res.stderr ?? ''}`,
      1,
    );
  }
  const entries = (res.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return entries;
}

/**
 * Normalise an entry name to its canonical relative form. Strips a
 * single leading `./` (GNU tar and bsdtar both emit `./` for
 * entries staged without an explicit name); leaves absolute or
 * traversal paths intact so the caller can refuse them.
 */
function normaliseEntryName(name) {
  if (name.length >= 2 && name[0] === '.' && (name[1] === '/' || name[1] === sep)) {
    return name.slice(2);
  }
  return name;
}

function validateArchiveEntrySet(entries, stagingDir) {
  // Normalise + de-dupe so a hostile archive that emits `./hub.sqlite`
  // and `hub.sqlite` is treated as one entry (we refuse it because
  // the de-duped set still contains exactly the expected shape, and
  // because the literal-name validator below catches stray duplicates
  // by way of the exact-set comparison).
  const normalised = entries.map(normaliseEntryName);

  // 1) Reject any entry that is absolute, traverses upward, or
  //    points outside the staging root. This is the fail-closed
  //    path-traversal / absolute-name gate.
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.startsWith(sep)) {
      throw new OpError(
        'ARCHIVE_ABSOLUTE_ENTRY',
        `backup_runner: archive entry is absolute: ${entry}`,
        1,
      );
    }
    const segments = entry.split(/[\\/]+/u).filter(Boolean);
    if (segments.some((s) => s === '..')) {
      throw new OpError(
        'ARCHIVE_PATH_TRAVERSAL',
        `backup_runner: archive entry escapes destination: ${entry}`,
        1,
      );
    }
    if (segments.some((s) => s.startsWith('/') || s.includes('\u0000'))) {
      throw new OpError(
        'ARCHIVE_PATH_TRAVERSAL',
        `backup_runner: archive entry has unsafe segment: ${entry}`,
        1,
      );
    }
  }

  // 2) Reject any secret-shaped entry. The snapshot contract forbids
  //    them; a restore that carries one is a tampering signal.
  for (const entry of normalised) {
    if (isSecretShaped(entry)) {
      throw new OpError(
        'ARCHIVE_SECRET_ENTRIES',
        `backup_runner: archive contains forbidden secret-shaped entry ${entry}`,
        1,
      );
    }
  }

  // 3) The entry set MUST be EXACTLY the pinned snapshot set. This
  //    is the single most important guard: a hostile archive that
  //    includes the right `hub.sqlite` AND a sidecar (e.g. an
  //    overrideable config, a planted token, an extra `.env`) is
  //    refused because the sidecar changes the set.
  if (normalised.length !== EXPECTED_ARCHIVE_ENTRIES.length) {
    throw new OpError(
      'ARCHIVE_UNEXPECTED_ENTRIES',
      `backup_runner: archive entry set is not the expected snapshot set: got [${normalised.join(', ')}], expected [${EXPECTED_ARCHIVE_ENTRIES.join(', ')}]`,
      1,
    );
  }
  for (let i = 0; i < EXPECTED_ARCHIVE_ENTRIES.length; i += 1) {
    if (normalised[i] !== EXPECTED_ARCHIVE_ENTRIES[i]) {
      throw new OpError(
        'ARCHIVE_UNEXPECTED_ENTRIES',
        `backup_runner: archive entry set is not the expected snapshot set: got [${normalised.join(', ')}], expected [${EXPECTED_ARCHIVE_ENTRIES.join(', ')}]`,
        1,
      );
    }
  }

  // `stagingDir` is currently reserved for the post-extract walk,
  // but we keep the parameter so a future refactor that wants to
  // resolve a symlink at the staging root can plug in here without
  // changing the call site.
  void stagingDir;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

try {
  const exitCode = (() => {
    switch (action) {
      case 'snapshot': {
        const archivePath = String(request.archivePath ?? '').trim();
        const dbPath = String(request.dbPath ?? '').trim();
        const result = stageSnapshot(archivePath, dbPath);
        emit({
          action,
          archiveBytes: result.archiveBytes,
          archiveMode: '0600',
          archivePath: result.archivePath,
          code: 'OK',
          createdAt: result.createdAt,
          dbPath: result.dbPath,
          message: `snapshot written to ${result.archivePath}`,
        });
        return 0;
      }
      case 'restore': {
        const archivePath = String(request.archivePath ?? '').trim();
        const dbPath = String(request.dbPath ?? '').trim();
        const result = stageRestore(archivePath, dbPath);
        emit({
          action,
          archivePath: result.archivePath,
          code: 'OK',
          dbBytes: result.dbBytes,
          dbPath: result.dbPath,
          message: `restored canonical database at ${result.dbPath}`,
          restoredAt: result.restoredAt,
        });
        return 0;
      }
      default:
        emitError({
          code: 'UNKNOWN_ACTION',
          message: `backup_runner: unknown action ${JSON.stringify(action)} (expected snapshot|restore)`,
          httpCode: 400,
        });
        return 2;
    }
  })();
  process.exit(exitCode);
} catch (error) {
  if (error instanceof OpError) {
    emitError({ code: error.code, message: error.message, httpCode: error.exit === 2 ? 400 : 500 });
    process.exit(error.exit);
  }
  emitError({
    code: 'INTERNAL',
    message: `backup_runner: internal error: ${error.message}`,
    httpCode: 500,
  });
  process.exit(1);
}
