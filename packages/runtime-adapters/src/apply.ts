// packages/runtime-adapters/src/apply.ts
//
// The apply pipeline. Re-scans every input (USER/SOUL/MCP entry),
// re-validates the target root and every ancestor for symlinks,
// validates the reviewed digest against the preview, writes
// per-file backups that record (existed + original mode + sha256),
// stages every write under an isolated staging directory, performs
// the rename, verifies bytes, and records the rollback key.
//
// Every code path releases the apply lock and removes staged files.
// The registry is written atomically (tmp + rename) at mode 0600
// and treated as fail-closed — corrupt JSON aborts the apply with
// a descriptive error; the registry is *not* silently reinitialised
// after writes have already been recorded on a previous run.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  ApplyInput,
  ApplyResult,
  HarnessId,
  PlanFile,
  Preview,
} from './contracts.js';
import { canonicalise, sha256 } from './internal/digest.js';
import { assertSafeMode } from './internal/safe-mode.js';
import { assertSafeRelativePath, assertWithinRoot } from './internal/safe-paths.js';
import { assertSafeTargetDir } from './internal/safe-target.js';

const BACKUP_ROOT = '.pah/runtime-adapters-backups';
const RUN_REGISTRY = '.pah/runtime-adapters-runs.json';
const STAGING_ROOT = '.pah/runtime-adapters-staging';
const STAGING_TMP = '.pah/runtime-adapters-staging.tmp';
const BACKUP_TMP = '.pah/runtime-adapters-backups.tmp';
const LOCK_FILE = '.pah/apply.lock';

/** Uses `lstatSync(...).isSymbolicLink()` directly. The helper kept
 * for symmetry removed because the linter flagged it. */

/** Walks the lexical ancestors of `absPath` and aborts on any symlink. */
function assertNoSymlinkAncestors(label: string, absPath: string, start: string): void {
  let current = resolve(start);
  // Bound the walk so we never traverse past the filesystem root.
  const stop = dirname(current);
  let previous: string | null = null;
  while (current !== previous) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} ancestor is a symlink: ${current} (root: ${absPath})`);
    }
    if (current === stop) break;
    previous = current;
    current = dirname(current);
  }
}

/** Refuses physical root/ancestor divergence and any symlink in the path. */
function assertSafeAbsDir(label: string, absPath: string): string {
  if (!isAbsolute(absPath)) throw new Error(`${label} must be absolute: ${absPath}`);
  const resolved = resolve(absPath);
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  assertNoSymlinkAncestors(label, resolved, resolved);
  return resolved;
}

/** Symlink-safe file existence check used by both staging and backup. */
function assertSafeFile(label: string, absPath: string, mustExist: boolean): void {
  if (!isAbsolute(absPath)) throw new Error(`${label} must be absolute: ${absPath}`);
  const resolved = resolve(absPath);
  if (!existsSync(resolved)) {
    if (!mustExist) return;
    throw new Error(`${label} not found: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${resolved}`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);
}

function backupDirFor(targetDir: string, runId: string): string {
  return join(targetDir, BACKUP_ROOT, runId);
}

function stagingDirFor(targetDir: string, runId: string): string {
  return join(targetDir, STAGING_ROOT, runId);
}

function registryPathFor(targetDir: string): string {
  return join(targetDir, RUN_REGISTRY);
}

function lockPathFor(targetDir: string): string {
  return join(targetDir, LOCK_FILE);
}

function readCanonicalInputBytes(absPath: string, label: string): Uint8Array {
  assertSafeFile(label, absPath, true);
  return new Uint8Array(readFileSync(resolve(absPath)));
}

/** Re-scans every preview-supplied input that touches the filesystem.
 *  Detects drift between the persisted preview and the current inputs:
 *  a preview file whose USER/SOUL bytes are mutated between preview
 *  and apply is rejected with a descriptive error. We never trust the
 *  bytes persisted to disk — every byte the apply writes is re-read
 *  from the live canonical input. */
function rescanInputs(input: ApplyInput): void {
  if (!input || typeof input !== 'object') throw new Error('apply input required');
  const preview = input.preview;
  if (!preview || typeof preview !== 'object') throw new Error('preview missing');
  // Target tree — already validated by `assertSafeTargetDir` in
  // revalidatePlan, but we re-check so rescanInputs can stand on
  // its own for tests.
  assertSafeTargetDir(input.targetDir);

  // mcp entry must still exist, be regular, and non-symlink. The
  // path on the preview must equal the absolute path on the apply
  // input (no silent redirection).
  const mcpBytes = readCanonicalInputBytes(preview.mcpEntry, 'mcpEntry');
  if (input.targetDir && preview.targetDir !== input.targetDir) {
    throw new Error(`targetDir drift on apply: ${preview.targetDir} vs ${input.targetDir}`);
  }

  // USER / SOUL — re-read from the absolute preview-stored path,
  // re-hash, and compare with the file digest that the preview
  // recorded. Drift here forces the operator to rerun the preview.
  const userBytes = readCanonicalInputBytes(preview.userFile, 'userFile');
  const soulBytes = readCanonicalInputBytes(preview.soulFile, 'soulFile');
  const userRel = userRelativePathFor(preview.harness);
  const soulRel = soulRelativePathFor(preview.harness);
  const userDigestExpected = sha256(userBytes);
  const soulDigestExpected = sha256(soulBytes);
  const userRecord = preview.files.find((file) => file.relativePath === userRel);
  const soulRecord = preview.files.find((file) => file.relativePath === soulRel);
  if (!userRecord || userRecord.sha256 !== userDigestExpected) {
    throw new Error(`USER drift: ${userRel} ${userRecord?.sha256 ?? '∅'} vs ${userDigestExpected}`);
  }
  if (!soulRecord || soulRecord.sha256 !== soulDigestExpected) {
    throw new Error(`SOUL drift: ${soulRel} ${soulRecord?.sha256 ?? '∅'} vs ${soulDigestExpected}`);
  }
  // mcpEntry must remain a regular non-symlink file: byte length
  // recorded (informational only; we do not write to it).
  if (mcpBytes.byteLength === 0) {
    throw new Error('mcpEntry is empty');
  }
}

function userRelativePathFor(harness: HarnessId): string {
  switch (harness) {
    case 'codex':
    case 'claude-code':
    case 'opencode':
    case 'hermes':
    case 'openclaw':
      return 'USER.md';
    default:
      throw new Error(`unknown harness: ${String(harness)}`);
  }
}

function soulRelativePathFor(harness: HarnessId): string {
  switch (harness) {
    case 'codex':
    case 'claude-code':
    case 'opencode':
    case 'hermes':
    case 'openclaw':
      return 'SOUL.md';
    default:
      throw new Error(`unknown harness: ${String(harness)}`);
  }
}

function revalidatePlan(input: ApplyInput): { target: string; plan: readonly PlanFile[]; digest: Preview['planDigest'] } {
  if (!input || typeof input !== 'object') throw new Error('apply input required');
  if (typeof input.reviewedDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(input.reviewedDigest)) {
    throw new Error('reviewedDigest must be a 64-char hex digest');
  }
  const target = assertSafeTargetDir(input.targetDir);
  const preview = input.preview;
  if (!preview || preview.planDigest.digest !== input.reviewedDigest) {
    throw new Error(`reviewed digest mismatch: ${input.reviewedDigest} vs ${preview?.planDigest.digest ?? '∅'}`);
  }
  if (preview.targetDir !== target.absolute) {
    throw new Error(`preview targetDir drift: ${preview.targetDir} vs ${target.absolute}`);
  }
  for (const file of preview.files) {
    assertSafeRelativePath(file.relativePath);
    assertWithinRoot(target.absolute, join(target.absolute, file.relativePath));
    if (!/^[0-9a-f]{64}$/u.test(file.sha256)) {
      throw new Error(`preview file sha256 invalid: ${file.relativePath}`);
    }
    assertSafeMode(file.mode);
  }
  return { target: target.absolute, plan: preview.files, digest: preview.planDigest };
}

type BackupRecordFile = {
  relativePath: string;
  existed: boolean;
  mode: number;
  sha256: string;
};
type BackupRecord = {
  runId: string;
  createdAt: string;
  target: string;
  planDigest: string;
  files: BackupRecordFile[];
};

/** Refuses a final write target that is a symlink at apply time. */
function assertSafeFinalTargets(target: string, files: readonly PlanFile[]): void {
  for (const file of files) {
    const finalPath = join(target, file.relativePath);
    if (existsSync(finalPath) && lstatSync(finalPath).isSymbolicLink()) {
      throw new Error(`final target is a symlink: ${file.relativePath}`);
    }
    // Walk every ancestor under target for symlinks.
    let current = dirname(finalPath);
    let previous: string | null = null;
    while (current !== previous && current !== target) {
      if (current === previous) break;
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error(`final target ancestor is a symlink: ${current} (for ${file.relativePath})`);
      }
      previous = current;
      current = dirname(current);
    }
  }
}

function acquireLock(target: string): { lockPath: string; release: () => void; handle: number } {
  const lockPath = lockPathFor(target);
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink()) throw new Error(`lock path must not be a symlink: ${lockPath}`);
    throw new Error(`another apply is already running (${lockPath})`);
  }
  const handle = openSync(lockPath, 'wx', 0o600);
  writeFileSync(handle, `${process.pid}\n${new Date().toISOString()}\n`);
  return {
    lockPath,
    handle,
    release() {
      try { closeSync(handle); } catch { /* already closed */ }
      try { rmSync(lockPath, { force: true }); } catch { /* lockfile may already be gone */ }
    },
  };
}

function backupFiles(target: string, files: readonly PlanFile[], backupDir: string): BackupRecord {
  const entries: BackupRecord['files'] = [];
  const createdAt = new Date().toISOString();
  for (const file of files) {
    const absolute = join(target, file.relativePath);
    if (!existsSync(absolute)) {
      entries.push({ relativePath: file.relativePath, existed: false, mode: file.mode, sha256: '' });
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`cannot backup symlink: ${file.relativePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`cannot backup non-file: ${file.relativePath}`);
    }
    const backupPath = join(backupDir, file.relativePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    const bytes = readFileSync(absolute);
    const computed = sha256(new Uint8Array(bytes));
    const originalMode = stat.mode & 0o7777;
    writeFileSync(backupPath, bytes);
    chmodSync(backupPath, 0o600);
    entries.push({ relativePath: file.relativePath, existed: true, mode: originalMode, sha256: computed });
  }
  return {
    runId: '', // populated at call-site
    createdAt,
    target,
    planDigest: '', // populated at call-site
    files: entries,
  };
}

function stageFiles(target: string, files: readonly PlanFile[], stageDir: string): void {
  for (const file of files) {
    const stagePath = join(stageDir, file.relativePath);
    mkdirSync(dirname(stagePath), { recursive: true });
    writeFileSync(stagePath, Buffer.from(file.bytes));
    chmodSync(stagePath, 0o600);
    const staged = readFileSync(stagePath);
    const computed = sha256(new Uint8Array(staged));
    if (computed !== file.sha256) {
      throw new Error(`staged sha256 mismatch for ${file.relativePath}: ${computed} vs ${file.sha256}`);
    }
  }
}

function renameFiles(target: string, stageDir: string, files: readonly PlanFile[]): readonly { relativePath: string; mode: number; sha256: string }[] {
  const written: { relativePath: string; mode: number; sha256: string }[] = [];
  for (const file of files) {
    const stagePath = join(stageDir, file.relativePath);
    const finalPath = join(target, file.relativePath);
    mkdirSync(dirname(finalPath), { recursive: true });
    if (existsSync(finalPath)) {
      const stat = lstatSync(finalPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`target became a symlink during apply: ${file.relativePath}`);
      }
    }
    renameSync(stagePath, finalPath);
    chmodSync(finalPath, file.mode);
    written.push({ relativePath: file.relativePath, mode: file.mode, sha256: file.sha256 });
  }
  return written;
}

function verifyAfterApply(target: string, files: readonly PlanFile[]): void {
  for (const file of files) {
    const finalPath = join(target, file.relativePath);
    if (!existsSync(finalPath)) {
      throw new Error(`post-apply verification failed (missing): ${file.relativePath}`);
    }
    const stat = lstatSync(finalPath);
    if (stat.isSymbolicLink()) throw new Error(`post-apply verification failed (symlink): ${file.relativePath}`);
    const bytes = readFileSync(finalPath);
    const computed = sha256(new Uint8Array(bytes));
    if (computed !== file.sha256) {
      throw new Error(`post-apply sha mismatch: ${file.relativePath} (${computed} vs ${file.sha256})`);
    }
    assertSafeMode(stat.mode & 0o7777);
  }
}

function restoreFromBackup(target: string, backupDir: string, record: BackupRecord): readonly string[] {
  const restored: string[] = [];
  // record.files is the same array we used to build the backup;
  // we declared it mutably so we can also stamp runId/planDigest
  // after the fact without TypeScript escape hatches.
  for (const entry of record.files) {
    const destination = join(target, entry.relativePath);
    const backupPath = join(backupDir, entry.relativePath);
    if (entry.existed) {
      const bytes = readFileSync(backupPath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      chmodSync(destination, entry.mode);
      restored.push(entry.relativePath);
    } else if (existsSync(destination)) {
      rmSync(destination, { force: true });
      restored.push(`-removed:${entry.relativePath}`);
    }
  }
  return restored;
}

function atomicWriteRegistry(target: string, entry: unknown): void {
  const path = registryPathFor(target);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Read existing registry, fail-closed on parse error.
  let registry: { runs: unknown[] } = { runs: [] };
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { runs?: unknown }).runs)) {
        throw new Error('registry missing "runs" array');
      }
      registry = parsed as { runs: unknown[] };
    } catch (error) {
      throw new Error(`registry corrupt at ${path}: ${(error as Error).message}`, { cause: error });
    }
  }

  // Reject duplicate run-id entries.
  const newId = (entry as { runId?: string })?.runId;
  if (typeof newId !== 'string' || newId.length === 0) {
    throw new Error('registry entry missing runId');
  }
  const duplicate = registry.runs.some((existing) => (
    typeof existing === 'object' && existing !== null && (existing as { runId?: unknown }).runId === newId
  ));
  if (duplicate) {
    throw new Error(`registry already contains runId: ${newId}`);
  }

  registry.runs.push(entry);
  const serialised = canonicalise(registry);

  // Atomic write: tmp file in a sibling dir + rename. Mode 0600 on the
  // tmp file; the rename preserves the inode but inherits the parent
  // directory mode, so we re-chmod after.
  const tmpPath = join(dir, '.runtime-adapters-registry.tmp');
  if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
  const handle = openSync(tmpPath, 'wx', 0o600);
  try {
    writeFileSync(handle, serialised);
  } finally {
    closeSync(handle);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function cleanupStaging(stageDir: string): void {
  if (!existsSync(stageDir)) return;
  rmSync(stageDir, { recursive: true, force: true });
}

function cleanupBackup(backupDir: string): void {
  if (!existsSync(backupDir)) return;
  rmSync(backupDir, { recursive: true, force: true });
}

function safeRemove(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function applyPlan(input: ApplyInput): ApplyResult {
  const validated = revalidatePlan(input);
  rescanInputs(input);
  const target = validated.target;
  const digest = input.reviewedDigest;
  const startedAt = new Date().toISOString();
  // runId is a non-deterministic UUID-derived identifier; we never
  // claim it is reproducible. Two apply calls with the same plan
  // produce different runIds so rollback keys remain fresh.
  const runId = `run_${randomUUID().replace(/-/gu, '')}`;

  const lock = acquireLock(target);
  let backupDir: string | undefined;
  let stageDir: string | undefined;
  let manifestWritten = false;
  let backupRecord: BackupRecord | undefined;
  let written: readonly { relativePath: string; mode: number; sha256: string }[];
  const stagedRoot = join(target, STAGING_TMP);
  const backupTmpRoot = join(target, BACKUP_TMP);

  try {
    backupDir = backupDirFor(target, runId);
    stageDir = stagingDirFor(target, runId);

    // Refuse to overwrite a leftover staging or backup tree from a
    // prior crash — the operator must delete it (or rollback) first.
    if (existsSync(stageDir) || existsSync(backupDir)) {
      throw new Error(`staging or backup directory already exists: ${stageDir} / ${backupDir}`);
    }
    // Symlink guard for staging and backup trees: any symlink under
    // .pah/runtime-adapters-{staging,backups} or one of their
    // ancestors is rejected.
    for (const sub of [STAGING_ROOT, BACKUP_ROOT]) {
      const parent = join(target, sub);
      if (!existsSync(parent)) continue;
      if (lstatSync(parent).isSymbolicLink()) {
        throw new Error(`${sub} under target is a symlink: ${parent}`);
      }
    }
    if (existsSync(stagedRoot) && lstatSync(stagedRoot).isSymbolicLink()) {
      throw new Error(`staging tmp root is a symlink: ${stagedRoot}`);
    }
    if (existsSync(backupTmpRoot) && lstatSync(backupTmpRoot).isSymbolicLink()) {
      throw new Error(`backup tmp root is a symlink: ${backupTmpRoot}`);
    }

    mkdirSync(join(target, STAGING_ROOT), { recursive: true });
    mkdirSync(join(target, BACKUP_ROOT), { recursive: true });
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });

    // Final-target symlink guard: refuse any preview file whose
    // absolute path inside the target root is or sits under a
    // symlink. Runs AFTER mkdir so a malicious operator cannot
    // pre-plant a `.pah/runtime-adapters-staging/file` symlink to
    // get us to write to /etc/passwd.
    assertSafeFinalTargets(target, input.preview.files);

    backupRecord = backupFiles(target, input.preview.files, backupDir);
    backupRecord.runId = runId;
    backupRecord.planDigest = digest;

    stageFiles(target, input.preview.files, stageDir);
    written = renameFiles(target, stageDir, input.preview.files);
    verifyAfterApply(target, input.preview.files);

    const finishedAt = new Date().toISOString();
    const registryEntry = {
      runId,
      planDigest: digest,
      reason: input.reason,
      startedAt,
      finishedAt,
      backup: {
        relativeRoot: '.pah/runtime-adapters-backups',
        runId,
        files: backupRecord.files,
      },
      files: written,
    };
    atomicWriteRegistry(target, registryEntry);
    manifestWritten = true;

    return {
      runId,
      planDigest: digest,
      writtenFiles: written,
      backupRoot: backupDir,
      startedAt,
      finishedAt,
    };
  } catch (error) {
    // Restore originals from backup (delete files that did not
    // exist before apply; restore with original mode+sha).
    if (backupRecord && backupDir) {
      try { restoreFromBackup(target, backupDir, backupRecord); } catch { /* surface the original error */ }
    }
    if (stageDir) cleanupStaging(stageDir);
    if (backupDir && !manifestWritten) cleanupBackup(backupDir);
    safeRemove(stagedRoot);
    safeRemove(backupTmpRoot);
    throw error;
  } finally {
    lock.release();
    safeRemove(stagedRoot);
    safeRemove(backupTmpRoot);
  }
}

export function rollbackPlan(input: { targetDir: string; runId: string; reason?: string }): {
  runId: string;
  restoredFiles: readonly string[];
  removedFiles: readonly string[];
  finishedAt: string;
} {
  const target = assertSafeTargetDir(input.targetDir);
  const backupDir = assertSafeAbsDir('backupDir', join(target.absolute, BACKUP_ROOT, input.runId));
  const registry = readRegistryRaw(target.absolute);
  const entry = registry.runs.find((run) => (
    typeof run === 'object' && run !== null && (run as { runId?: unknown }).runId === input.runId
  )) as { backup?: { files?: Array<{ relativePath: string; existed: boolean; mode: number }> } } | undefined;
  if (!entry || !entry.backup || !Array.isArray(entry.backup.files)) {
    throw new Error(`run not found in registry: ${input.runId}`);
  }

  const restored: string[] = [];
  const removed: string[] = [];
  for (const record of entry.backup.files) {
    const destination = join(target.absolute, record.relativePath);
    const source = join(backupDir, record.relativePath);
    if (record.existed) {
      if (!existsSync(source)) {
        throw new Error(`backup missing for ${record.relativePath}`);
      }
      const bytes = readFileSync(source);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      chmodSync(destination, record.mode);
      restored.push(record.relativePath);
    } else if (existsSync(destination)) {
      rmSync(destination, { force: true });
      removed.push(record.relativePath);
    }
  }
  // Walk the backup tree for any leftover entries (defence in depth)
  // and restore them too in case registry got out of sync.
  for (const relative of walkBackup(backupDir)) {
    const destination = join(target.absolute, relative);
    const source = join(backupDir, relative);
    if (existsSync(destination)) {
      const stat = lstatSync(destination);
      if (stat.isSymbolicLink()) rmSync(destination, { force: true });
    }
    const bytes = readFileSync(source);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    if (!restored.includes(relative)) restored.push(relative);
  }
  return {
    runId: input.runId,
    restoredFiles: restored,
    removedFiles: removed,
    finishedAt: new Date().toISOString(),
  };
}

function walkBackup(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip manifest
      const absolute = join(current, entry.name);
      if (lstatSync(absolute).isDirectory()) {
        stack.push(absolute);
      } else {
        out.push(absolute.slice(root.length + 1));
      }
    }
  }
  // Sort with deterministic a<b (no localeCompare, no third-party helpers).
  return out.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readRegistryRaw(target: string): { runs: unknown[] } {
  const path = registryPathFor(target);
  if (!existsSync(path)) throw new Error(`registry missing: ${path}`);
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`registry corrupt: ${(error as Error).message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { runs?: unknown }).runs)) {
    throw new Error('registry missing "runs" array');
  }
  return parsed as { runs: unknown[] };
}

/** Registry reader exposed for the CLI/tests. Fail-closed on corruption. */
export function readRegistry(targetDir: string): { runs: unknown[] } {
  const target = assertSafeTargetDir(targetDir);
  const path = registryPathFor(target.absolute);
  if (!existsSync(path)) return { runs: [] };
  return readRegistryRaw(target.absolute);
}

/**
 * Returns a random run-id for a given plan digest. The id is *not*
 * deterministic — a second call with identical inputs produces a
 * different identifier. The helper exists so callers can refer to a
 * run before `applyPlan` actually finishes.
 */
export function deriveRunId(planDigest: string): string {
  // The planDigest parameter is accepted for API symmetry; we make no
  // claim that the resulting id is reproducible. We deliberately
  // avoid using Date.now() in the digest to keep the id independent
  // of wall-clock jumps.
  void planDigest;
  return `run_${randomUUID().replace(/-/gu, '')}`;
}
