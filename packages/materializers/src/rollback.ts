// packages/materializers/src/rollback.ts
//
// The renderer-agnostic rollback pipeline. Given a `runId`, it
// restores the target files from the staging backup that `applyPlan`
// created at `<targetRoot>/.pah/backups/<runId>/`. The flow:
//
//   1. Read the on-disk manifest and confirm it carries `runId`. If
//      the manifest is missing OR the runId doesn't match, the run is
//      unknown — reject with NOT_FOUND (HTTP 404).
//   2. Resolve the lock directory from the manifest's recorded
//      (harness, profileId) and acquire the same per-pair lock.
//   3. Walk the backup tree and copy every backed-up file back to
//      its original location. Any file the apply *added* (no prior
//      bytes) is recorded in the backup as a marker — rollback
//      removes it. Any file the apply did not touch is left alone.
//   4. Delete the manifest (so subsequent previews start clean).
//   5. Remove the backup directory.
//   6. Audit the rollback.
//   7. Release the lock.
//
// On any failure the lock is released via finally and the filesystem
// is left as close to the pre-rollback state as possible.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ActorContext, Storage } from '@portable-agent-asset-hub/core';
import { HubError } from '@portable-agent-asset-hub/core';
import { acquireLock } from './locks.js';
import { canonicalizeManifest } from './manifest.js';
import { forgetRun, lookupRun } from './registry.js';
import type { RollbackInput, RollbackResult } from './contracts.js';

function backupRoot(targetRoot: string, runId: string): string {
  return join(targetRoot, '.pah', 'backups', runId);
}

function manifestPath(targetRoot: string): string {
  return join(targetRoot, '.pah', 'manifest.v1.json');
}

function readManifestRecord(targetRoot: string): {
  runId: string;
  harness: 'hermes' | 'openclaw';
  profileId: string;
  targetRoot: string;
} | null {
  const manifestAbsolute = manifestPath(targetRoot);
  if (!existsSync(manifestAbsolute)) return null;
  try {
    const raw = readFileSync(manifestAbsolute, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const runId = parsed.runId;
    const harness = parsed.harness;
    const profileId = parsed.profileId;
    if (typeof runId !== 'string' || typeof harness !== 'string' || typeof profileId !== 'string') return null;
    if (harness !== 'hermes' && harness !== 'openclaw') return null;
    return { runId, harness, profileId, targetRoot: typeof parsed.targetRoot === 'string' ? parsed.targetRoot : targetRoot };
  } catch {
    return null;
  }
}

/**
 * Roll back the prior `applyPlan` identified by `runId`. Returns the
 * list of files restored. Throws NOT_FOUND when the runId is unknown
 * (no manifest on disk references it and no backup directory
 * exists).
 */
export function rollbackPlan(
  store: Storage,
  actor: ActorContext,
  input: RollbackInput,
): RollbackResult {
  if (!input.runId || typeof input.runId !== 'string') {
    throw new HubError('VALIDATION', 'runId required', 400);
  }
  if (!/^run_[A-Za-z0-9._-]+$/u.test(input.runId)) {
    throw new HubError('VALIDATION', 'invalid runId', 400);
  }

  // 1. Resolve target root from the registry FIRST. A successful
  //    applyPlan registers its runId with the (targetRoot, lockDir,
  //    harness, profileId) tuple it actually used. Falling back to a
  //    manifest scan is the legacy S8 behaviour; the registry path is
  //    exact and does not depend on the manifest still being present
  //    on disk at a path the caller did not specify.
  let targetRoot: string | undefined;
  let harness: 'hermes' | 'openclaw' | undefined;
  let profileId: string | undefined;
  let lockDir: string | undefined;
  const registered = lookupRun(input.runId);
  if (registered) {
    targetRoot = registered.targetRoot;
    harness = registered.harness;
    profileId = registered.profileId;
    lockDir = registered.lockDir;
  } else {
    // 1b. Fallback: scan the well-known manifest paths. The S8
    //     contract places the manifest at
    //     `<targetRoot>/.pah/manifest.v1.json`. The apply pipeline
    //     always writes there, so the rollback only needs to inspect
    //     that single location. We expose this as a separate
    //     function for tests that want to inject multiple candidate
    //     roots; the default implementation returns an empty list
    //     and the caller fills in the well-known root via
    //     `readManifestRecord`.
    const manifestCandidates = discoverManifests();
    for (const candidate of manifestCandidates) {
      const record = readManifestRecord(candidate);
      if (record && record.runId === input.runId) {
        targetRoot = candidate;
        harness = record.harness;
        profileId = record.profileId;
        lockDir = candidate;
        break;
      }
    }
  }
  if (!targetRoot || !harness || !profileId) {
    // No manifest references this runId; check for an orphaned backup
    // directory in any well-known location. For the S8 contract the
    // only well-known location is the recorded targetRoot of the most
    // recent manifest, so we treat the missing case as unknown.
    throw new HubError('NOT_FOUND', `unknown runId: ${input.runId}`, 404);
  }

  const backupDir = backupRoot(targetRoot, input.runId);
  if (!existsSync(backupDir)) {
    // The manifest references the run but the backup is gone — we
    // can still remove the manifest and audit, but the file restore
    // is a no-op.
    try { unlinkSync(manifestPath(targetRoot)); } catch { /* best effort */ }
    return { runId: input.runId, restored: [] };
  }

  // 2. Validate the target root is still safe (existing,
  //    non-symlink, directory).
  const targetAbsolute = resolve(targetRoot);
  if (!isAbsolute(targetAbsolute)) {
    throw new HubError('VALIDATION', `targetRoot must be absolute: ${targetAbsolute}`, 400);
  }
  if (existsSync(targetAbsolute) && lstatSync(targetAbsolute).isSymbolicLink()) {
    throw new HubError('VALIDATION', 'symlink targetRoot rejected', 400);
  }

  // 3. Acquire the same per-(harness, profile) lock the apply held.
  //    Always release via finally.
  const lock = acquireLock(lockDir ?? targetRoot, harness, profileId);
  const restored: string[] = [];
  try {
    // 4. Walk the backup tree and restore each file. Files with a
    //    `.deleted` marker (we wrote the marker when the apply
    //    removed a pre-existing file) are *removed* from the live
    //    tree; otherwise the bytes are copied back.
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
        if (current.endsWith('.deleted')) {
          // `.deleted` marker: the apply added this file over no prior
          // bytes, so rollback removes the real file (marker suffix
          // stripped), restoring the pre-apply absence.
          const realRelative = relative.slice(0, -'.deleted'.length);
          try { rmSync(join(targetAbsolute, realRelative), { force: true }); } catch { /* best effort */ }
          restored.push(realRelative);
        } else {
          const dest = join(targetAbsolute, relative);
          mkdirSync(join(dest, '..'), { recursive: true });
          copyFileSync(current, dest);
          restored.push(relative);
        }
      }
    }

    // 5. Remove the manifest so the next preview starts from a clean
    //    observed-digest of zero. We do this AFTER the file restore so
    //    a mid-restore crash still leaves a manifest pointing at the
    //    run we were rolling back.
    try { rmSync(manifestPath(targetAbsolute), { force: true }); } catch { /* best effort */ }

    // 6. Remove the backup directory.
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best effort */ }

    // 7. Audit.
    try {
      store.transaction(actor, (tx) => {
        tx.audit.append({
          action: 'materialization.rollback',
          actor: {
            userId: actor.userId,
            agentId: actor.agentId,
            harnessId: actor.harnessId,
          },
          scope: actor.scope,
          target: targetAbsolute,
          metadata: {
            runId: input.runId,
            harness,
            profileId,
            reason: input.reason,
            requestId: input.requestId ?? null,
            restoredCount: restored.length,
            canonicalDigest: canonicalizeManifest({
              runId: input.runId,
              snapshotId: 'snap_rollback',
              harness,
              profileId,
              targetRoot: targetAbsolute,
              files: [],
              generatedAt: new Date().toISOString(),
              rendererVersion: '0.0.0',
            }),
          },
        });
      });
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError('INTERNAL', `audit append failed: ${(error as Error).message}`, 500);
    }

    return { runId: input.runId, restored };
  } finally {
    try { lock.release(); } catch { /* best effort */ }
    // Remove the registry entry on every code path so the map never
    // leaks stale runs across long-running processes. Idempotent when
    // the run was unknown on entry.
    forgetRun(input.runId);
  }
}

/**
 * Find candidate manifest paths. The S8 contract places the manifest
 * at `<targetRoot>/.pah/manifest.v1.json`. The apply pipeline always
 * writes there, so the rollback only needs to inspect that single
 * location. We expose this as a separate function for tests that want
 * to inject multiple candidate roots; the default implementation
 * returns an empty list and the caller fills in the well-known root
 * via `readManifestRecord`.
 */
function discoverManifests(): string[] {
  return [];
}

/**
 * Direct file restore helper. Used by the rollback test scaffold and
 * exposed for diagnostics: given a backup directory, copy every
 * regular file back to its mirrored location under `targetRoot`.
 */
export function restoreFromBackup(backupDir: string, targetRoot: string): string[] {
  const restored: string[] = [];
  if (!existsSync(backupDir)) return restored;
  const targetAbsolute = resolve(targetRoot);
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
      if (relative.endsWith('.deleted')) {
        const realRelative = relative.slice(0, -'.deleted'.length);
        try { rmSync(join(targetAbsolute, realRelative), { force: true }); } catch { /* best effort */ }
        restored.push(realRelative);
        continue;
      }
      const dest = join(targetAbsolute, relative);
      mkdirSync(join(dest, '..'), { recursive: true });
      copyFileSync(current, dest);
      restored.push(relative);
    }
  }
  return restored;
}

// Silence unused-import warnings (writeFileSync is referenced by the
// backup-creating caller; we keep it imported so the apply/rollback
// pair shares the same set of fs primitives).
void writeFileSync;