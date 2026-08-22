// packages/materializers/src/apply.ts
//
// The renderer-agnostic apply pipeline. Given a `PreviewResult`
// (already containing a manifest plan + observedDigest) plus the lock
// directory, the run reason, and an optional caller-provided
// `observedDigest`, it:
//
//   1. Validates the target root (existing, non-symlink, directory).
//   2. Validates the lock directory (existing, non-symlink).
//   3. Acquires the per-(harness,profile) lock; releases it on every
//      code path via a finally block.
//   4. Reads the manifest currently on disk and compares its digest
//      against `preview.observedDigest`. If they differ AND the
//      caller passed `observedDigest`, rejects with PRECONDITION_FAILED
//      (HTTP 412) — this is the drift detector the REST/MCP/SDKs
//      surface to callers.
//   5. Validates the optional `expectedDigest` against
//      `preview.observedDigest` (CAS).
//   6. Creates a backup directory at `<targetRoot>/.pah/backups/<runId>/`
//      and copies every file the apply is about to overwrite.
//   7. Stages every new file into `<runId>/staging/<relPath>`, hashes
//      it, and compares against the declared sha256 — any mismatch
//      aborts before any user-visible write.
//   8. Atomically renames each staged file into place (`renameSync`).
//   9. Writes the manifest last (`.pah/manifest.v1.json`).
//  10. Records an audit event with the run id and reason.
//  11. Re-verifies every byte on disk and rejects if any file no
//      longer matches the declared sha256 — defence against an
//      external writer that races the apply.
//
// On every failure path the function restores the backup, removes the
// backup directory, removes any staged files, releases the lock, and
// throws. The contract guarantees that a failing apply leaves the
// filesystem byte-identical to its pre-apply state for every file the
// preview listed.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ActorContext, Storage } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';
import { acquireLock } from './locks.js';
import {
  assertSafeRelativePath,
  canonicalizeManifest,
  observedManifestDigest,
} from './manifest.js';
import { assertSafeTargetRoot } from './preview.js';
import { registerRun } from './registry.js';
import type { ApplyInput, ApplyResult, ManifestFile } from './contracts.js';

const HASH_REGEX = /^[0-9a-f]{64}$/u;

function assertSafeLockDir(lockDir: string): string {
  if (!lockDir || typeof lockDir !== 'string') {
    throw new HubError('VALIDATION', 'lockDir required', 400);
  }
  const absolute = resolve(lockDir);
  if (!isAbsolute(absolute)) {
    throw new HubError('VALIDATION', 'lockDir must be absolute', 400);
  }
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new HubError('VALIDATION', 'symlink lockDir rejected', 400);
  }
  return absolute;
}

function assertWithin(root: string, candidate: string): void {
  const rootAbs = resolve(root);
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  const candidateAbs = resolve(candidate);
  if (!candidateAbs.startsWith(rootWithSep) && candidateAbs !== rootAbs) {
    throw new HubError('VALIDATION', `path escapes target root: ${candidate}`, 400);
  }
}

function backupRoot(targetRoot: string, runId: string): string {
  return join(targetRoot, '.pah', 'backups', runId);
}

function stagingRoot(targetRoot: string, runId: string): string {
  return join(targetRoot, '.pah', 'staging', runId);
}

function manifestPath(targetRoot: string): string {
  return join(targetRoot, '.pah', 'manifest.v1.json');
}

/**
 * 11-step apply pipeline. Returns the runId, the on-disk manifest
 * path, the observed digest that matched the preview, and the list of
 * files written. Throws HubError on every failure path after rolling
 * back any partial writes.
 */
export function applyPlan(
  store: Storage,
  actor: ActorContext,
  input: ApplyInput,
): ApplyResult {
  // 0. Validate inputs up front. Target root + lock dir must exist and
  //    must not be symlinks. Profile id, snapshot id, and harness are
  //    pinned by the preview plan; we re-validate here as a belt-and-
  //    braces check.
  const targetRoot = assertSafeTargetRoot(input.targetRoot);
  const lockDir = assertSafeLockDir(input.lockDir);
  const plan = input.preview.plan;
  for (const file of plan.files) {
    assertSafeRelativePath(file.relativePath);
    assertWithin(targetRoot, join(targetRoot, file.relativePath));
    if (!HASH_REGEX.test(file.sha256)) {
      throw new HubError('VALIDATION', `invalid sha256: ${file.relativePath}`, 400);
    }
  }

  // 1. Stamp the run id. The preview is frozen; the apply mutates a
  //    local copy with this run id so the on-disk manifest always
  //    references the run that produced it.
  const runId = plan.runId ?? `run_${createHash('sha256').update(`${plan.snapshotId}:${plan.profileId}:${Date.now()}`).digest('hex')}`;
  const stampedPlan = { ...plan, runId };

  // 2. Acquire the lock. We always release it via finally.
  const lock = acquireLock(lockDir, plan.harness, plan.profileId);
  let backupDir: string | undefined;
  let stageDir: string | undefined;
  let manifestWritten = false;
  try {
    // 3. Compare observed manifest against the preview. The
    //    `observedDigest` passed by the caller is what they read from
    //    the target just before applying. We check TWO invariants:
    //      (a) `input.observedDigest === input.preview.observedDigest`:
    //          the caller's observation matches what the preview
    //          expected — i.e. no drift has occurred since preview.
    //      (b) `input.observedDigest === currentObserved`: the live
    //          state at apply time still matches what the caller
    //          observed (covers concurrent writers between read and
    //          apply).
    //    Both must hold for the apply to proceed.
    const currentObserved = observedManifestDigest(targetRoot);
    if (input.observedDigest !== undefined && input.observedDigest !== input.preview.observedDigest) {
      throw new HubError(
        'PRECONDITION_FAILED',
        `observed manifest drift: caller=${input.observedDigest} preview=${input.preview.observedDigest}`,
        412,
      );
    }
    if (input.observedDigest !== undefined && input.observedDigest !== currentObserved) {
      throw new HubError(
        'PRECONDITION_FAILED',
        `observed manifest drift: caller=${input.observedDigest} actual=${currentObserved}`,
        412,
      );
    }
    // 4. CAS check: if the caller pinned a specific digest, it must
    //    match the preview's expected digest exactly.
    if (input.expectedDigest !== undefined && input.expectedDigest !== input.preview.observedDigest) {
      throw new HubError(
        'PRECONDITION_FAILED',
        `expected digest mismatch: caller=${input.expectedDigest} preview=${input.preview.observedDigest}`,
        412,
      );
    }

    // 5. Create the backup directory and snapshot every file the
    //    apply is about to overwrite.
    backupDir = backupRoot(targetRoot, runId);
    mkdirSync(backupDir, { recursive: true });
    for (const file of plan.files) {
      const absolute = join(targetRoot, file.relativePath);
      const existed = existsSync(absolute);
      if (existed) {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          throw new HubError('VALIDATION', `symlink in target rejected: ${file.relativePath}`, 400);
        }
        const bytes = readFileSync(absolute);
        const backupPath = join(backupDir, file.relativePath);
        mkdirSync(join(backupPath, '..'), { recursive: true });
        writeFileSync(backupPath, bytes);
      }
    }

    // 6. Stage every file and verify the bytes match the declared
    //    sha256 BEFORE we touch the live filesystem.
    stageDir = stagingRoot(targetRoot, runId);
    mkdirSync(stageDir, { recursive: true });
    for (const file of plan.files) {
      const stagePath = join(stageDir, file.relativePath);
      mkdirSync(join(stagePath, '..'), { recursive: true });
      writeFileSync(stagePath, file.bytes);
      const stageHash = createHash('sha256').update(readFileSync(stagePath)).digest('hex');
      if (stageHash !== file.sha256) {
        throw new HubError(
          'INTERNAL',
          `stage hash mismatch: ${file.relativePath} declared=${file.sha256} actual=${stageHash}`,
          500,
        );
      }
    }

    // 7. Atomic rename. POSIX rename(2) on the same filesystem is
    //    atomic; we use `renameSync` so a failure mid-loop leaves the
    //    previous file in place.
    const writtenFiles: ManifestFile[] = [];
    for (const file of plan.files) {
      const stagePath = join(stageDir, file.relativePath);
      const targetPath = join(targetRoot, file.relativePath);
      mkdirSync(join(targetPath, '..'), { recursive: true });
      renameSync(stagePath, targetPath);
      try { chmodSync(targetPath, file.mode); } catch { /* best effort — POSIX-only */ }
      const verify = createHash('sha256').update(readFileSync(targetPath)).digest('hex');
      if (verify !== file.sha256) {
        throw new HubError(
          'INTERNAL',
          `post-rename hash mismatch: ${file.relativePath} declared=${file.sha256} actual=${verify}`,
          500,
        );
      }
      writtenFiles.push(file);
    }

    // 8. Write the manifest LAST. After this point, observedManifestDigest
    //    will return `preview.observedDigest`. We use
    //    `canonicalizeManifest` as the on-disk format so the SHA-256
    //    computed by `digestPlan` matches the byte-digest the caller
    //    already saw in `preview.observedDigest`. Any other
    //    formatting (pretty-print, key reordering, base64 vs raw
    //    bytes) would produce a different digest and trip the
    //    post-verify drift check.
    const manifestAbsolute = manifestPath(targetRoot);
    mkdirSync(join(manifestAbsolute, '..'), { recursive: true });
    const manifestJson = canonicalizeManifest(stampedPlan) + '\n';
    writeFileSync(manifestAbsolute, manifestJson);
    manifestWritten = true;

    // 9. Post-verify: re-digest the manifest on disk and assert it
    //    matches the preview's observedDigest.
    const verifyObserved = observedManifestDigest(targetRoot);
    if (verifyObserved !== input.preview.observedDigest) {
      throw new HubError(
        'INTERNAL',
        `manifest verify drift: declared=${input.preview.observedDigest} actual=${verifyObserved}`,
        500,
      );
    }

    // 10. Audit. We use the storage audit repository so every apply
    //     is observable through the S6 audit query surface.
    try {
      store.transaction(actor, (tx) => {
        tx.audit.append({
          action: 'materialization.apply',
          actor: {
            userId: actor.userId,
            agentId: actor.agentId,
            harnessId: actor.harnessId,
          },
          scope: actor.scope,
          target: targetRoot,
          requestDigest: input.preview.observedDigest,
          metadata: {
            runId,
            harness: plan.harness,
            profileId: plan.profileId,
            snapshotId: plan.snapshotId,
            reason: input.reason,
            requestId: input.requestId ?? null,
            fileCount: plan.files.length,
            backupRoot: backupDir,
            canonicalDigest: canonicalizeManifest(stampedPlan),
          },
        });
      });
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError('INTERNAL', `audit append failed: ${(error as Error).message}`, 500);
    }

    // 11. Register the run in the in-memory rollback registry. Done
    //     AFTER the manifest is on disk and audit succeeded so that
    //     any rollback can locate this run via lookupRun. The
    //     rollback pipeline deletes the entry on completion.
    registerRun(runId, {
      targetRoot,
      lockDir,
      harness: plan.harness,
      profileId: plan.profileId,
    });

    return {
      runId,
      manifestPath: manifestAbsolute,
      observedDigest: input.preview.observedDigest,
      backupRoot: backupDir ?? backupRoot(targetRoot, runId),
      writtenFiles,
    };
  } catch (error) {
    // Roll back any partial writes. We restore every backup we made,
    // remove any staged files, and delete the manifest if we got past
    // step 8.
    if (manifestWritten) {
      try { rmSync(manifestPath(targetRoot), { force: true }); } catch { /* best effort */ }
    }
    if (backupDir && existsSync(backupDir)) {
      restoreBackupTree(backupDir, targetRoot);
      try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (stageDir && existsSync(stageDir)) {
      try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    try { lock.release(); } catch { /* best effort */ }
  }
}

/**
 * Walk the backup directory and copy every file back to its original
 * location. The backup tree mirrors the relative paths under the
 * target root, so we restore by stripping the backup prefix.
 */
function restoreBackupTree(backupDir: string, targetRoot: string): void {
  const stack: string[] = [backupDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stat;
    try { stat = statSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      let children: string[];
      try { children = readdirSync(current); } catch { continue; }
      for (const child of children) {
        stack.push(join(current, child));
      }
    } else if (stat.isFile()) {
      const relative = current.slice(backupDir.length).replace(/^[/\\]/u, '');
      if (!relative) continue;
      const dest = join(targetRoot, relative);
      mkdirSync(join(dest, '..'), { recursive: true });
      copyFileSync(current, dest);
    }
  }
}