// packages/runtime-adapters/src/internal/safe-target.ts
//
// The target directory gate. Both preview and apply refuse to
// operate when:
//   * the path is empty,
//   * the path is not absolute,
//   * the path does not exist,
//   * the path is a symlink,
//   * the path is a file rather than a directory,
//   * any *ancestor* of the path is a symlink,
//   * the lexical path differs from the physical path (`realpathSync`),
//     which we treat as a redirection attempt.
//
// Defending against symlinks at every ancestor is what stops a
// malicious host from causing the apply to follow a symlink to
// `/etc/passwd` or any other out-of-tree target.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

export class SafeTargetError extends Error {
  public override readonly name = 'SafeTargetError';
  public constructor(
    public readonly code: 'NOT_ABSOLUTE' | 'MISSING' | 'SYMLINK' | 'NOT_DIR' | 'ANCESTOR_SYMLINK' | 'PHYSICAL_DIVERGED',
    message: string,
  ) {
    super(message);
  }
}

export type SafeTarget = {
  readonly absolute: string;
  readonly physical: string;
};

function fail(code: 'NOT_ABSOLUTE' | 'MISSING' | 'SYMLINK' | 'NOT_DIR' | 'ANCESTOR_SYMLINK' | 'PHYSICAL_DIVERGED', message: string): never {
  throw new SafeTargetError(code, message);
}

/**
 * Resolve the canonical physical target and refuse any path that is
 * itself a symlink, has a symlink ancestor, or diverges from its
 * `realpath` result. The caller receives a `SafeTarget` whose
 * `physical` is the canonical inode-aware path, never the lexical
 * input.
 */
export function assertSafeTargetDir(targetDir: string): SafeTarget {
  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    fail('NOT_ABSOLUTE', 'targetDir empty');
  }
  if (!isAbsolute(targetDir)) {
    fail('NOT_ABSOLUTE', `targetDir must be absolute: ${targetDir}`);
  }
  const absolute = resolve(targetDir);
  if (!existsSync(absolute)) {
    fail('MISSING', `targetDir does not exist: ${absolute}`);
  }
  if (lstatSync(absolute).isSymbolicLink()) {
    fail('SYMLINK', `targetDir is a symlink: ${absolute}`);
  }
  if (!lstatSync(absolute).isDirectory()) {
    fail('NOT_DIR', `targetDir is not a directory: ${absolute}`);
  }

  // Walk every ancestor; reject the first symlink found.
  let current = dirname(absolute);
  let previous: string | null = null;
  while (current !== previous && current !== sep && current !== '/') {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      fail('ANCESTOR_SYMLINK', `targetDir ancestor is a symlink: ${current} (root: ${absolute})`);
    }
    previous = current;
    current = dirname(current);
  }

  const physical = realpathSync(absolute);
  // Refuse lexical/physical divergence: that means the kernel had
  // to resolve a symlink during the walk. We want the literal path
  // and the canonical inode to agree on a directory the caller owns.
  if (physical !== absolute) {
    fail('PHYSICAL_DIVERGED', `targetDir ${absolute} diverges from physical ${physical}`);
  }
  return { absolute, physical };
}
