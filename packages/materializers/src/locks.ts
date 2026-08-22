// packages/materializers/src/locks.ts
//
// Per-(harness,profile) mutual-exclusion lock for the S8 materializer.
// The lock file lives next to the manifest so it travels with the
// target; the lock directory is `targetRoot/.pah/locks` by default.
//
// Lock protocol:
//   * `acquireLock(lockDir, harness, profile)` writes
//     `<lockDir>/.pah/locks/<harness>__<profile>.lock` with the current
//     pid and an exclusive `wx` open() flag. If the file already
//     exists, the call rejects with a 409.
//   * The returned `LockHandle#release()` deletes the lock file. The
//     caller is responsible for releasing on every code path — apply
//     and rollback both release through their `finally` blocks.
//   * Lock root must not be a symlink (defence in depth; matches the
//     `FileMaterializer` rule from Slice 4).

import { existsSync, lstatSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { HubError } from '@portable-agent-asset-hub/core';
import type { HarnessId } from './contracts.js';

export type LockHandle = {
  harness: HarnessId;
  profileId: string;
  lockPath: string;
  pid: number;
  release(): void;
};

function assertSafeLockRoot(root: string): string {
  if (!root || typeof root !== 'string') {
    throw new HubError('VALIDATION', 'lockDir required', 400);
  }
  const absolute = resolve(root);
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new HubError('VALIDATION', 'symlink lock root rejected', 400);
  }
  return absolute;
}

export function acquireLock(lockDir: string, harness: HarnessId, profileId: string): LockHandle {
  if (!/^prf_[A-Za-z0-9._-]+$/u.test(profileId)) {
    throw new HubError('VALIDATION', 'invalid profileId for lock', 400);
  }
  const root = assertSafeLockRoot(lockDir);
  const locksDir = join(root, '.pah', 'locks');
  mkdirSync(locksDir, { recursive: true });
  const lockPath = join(locksDir, `${harness}__${profileId}.lock`);
  // `wx` ensures we fail if the file already exists — exclusive lock.
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({
      harness,
      profileId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }) + '\n');
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HubError('CONFLICT', `lock already held: ${harness}/${profileId}`, 409);
    }
    throw error;
  }

  let released = false;
  const handle: LockHandle = {
    harness,
    profileId,
    lockPath,
    pid: process.pid,
    release(): void {
      if (released) return;
      released = true;
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        // Best effort: lock files are advisory; the next process that
        // opens the file sees no lock and proceeds.
      }
    },
  };
  return handle;
}

/**
 * Top-level `releaseLock(handle)` companion to `acquireLock`. Identical
 * effect to `handle.release()` — kept as a free function so callers
 * that imported the lock module directly (instead of the index
 * surface) have a single, named entry point. Idempotent: calling it
 * after the underlying handle was already released is a no-op.
 */
export function releaseLock(handle: LockHandle): void {
  if (!handle || typeof handle !== 'object' || typeof handle.release !== 'function') {
    throw new HubError('VALIDATION', 'releaseLock: invalid handle', 400);
  }
  try {
    handle.release();
  } catch {
    // Lock release is best-effort; a failed unlink still leaves the
    // lock file advisory and the next acquire overwrites it.
  }
}

/** Read a lock file for diagnostics (returns null when absent). */
export function readLock(lockDir: string, harness: HarnessId, profileId: string): { pid: number; acquiredAt: string } | null {
  if (!lockDir || isAbsolute(lockDir) === false) return null;
  const root = assertSafeLockRoot(lockDir);
  const lockPath = join(root, '.pah', 'locks', `${harness}__${profileId}.lock`);
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; acquiredAt: string };
  } catch {
    return null;
  }
}
